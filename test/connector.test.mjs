import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { BridgeServer, BridgeClient } from "../src/bridge.mjs";
import { JobCreateSchema, GENERATION_MODES } from "../src/shared.mjs";
import {
  extractSignedMediaUrls,
  extractPromptPairs,
  extractAsbPairs,
  isFlowUrl,
  isVideoGenerationMode
} from "../extension/src/shared/flow-url.js";

test("Flow URL and RPC payload extractors work accurately", () => {
  assert.equal(isFlowUrl("https://labs.google/fx/tools/flow/project/123"), true);
  assert.equal(isFlowUrl("https://flow.google.com/project/abc"), true);
  assert.equal(isFlowUrl("https://example.com"), false);
  assert.equal(isVideoGenerationMode("flow-text-to-video"), true);
  assert.equal(isVideoGenerationMode("flow-image"), false);

  const sampleRpc = JSON.stringify({
    media: [
      {
        name: "11111111-2222-3333-4444-555555555555",
        prompt: "cinematic neon skyline",
        url: "https://storage.googleapis.com/ai-sandbox-videofx/video/11111111-2222-3333-4444-555555555555?GoogleAccessId=test"
      }
    ],
    workflows: [
      {
        metadata: {
          name: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          createTime: "2026-11-06T23:00:00Z"
        }
      }
    ]
  });

  const urls = extractSignedMediaUrls(sampleRpc);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("ai-sandbox-videofx/video/11111111-2222-3333-4444-555555555555"));

  const prompts = extractPromptPairs(sampleRpc);
  assert.deepEqual(prompts, [["11111111-2222-3333-4444-555555555555", "cinematic neon skyline"]]);

  const asbs = extractAsbPairs(sampleRpc);
  assert.equal(asbs.length, 1);
  assert.equal(asbs[0][0], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("JobCreateSchema validates all Flow modes and parameters", () => {
  for (const mode of GENERATION_MODES) {
    const parsed = JobCreateSchema.parse({
      mode,
      prompt: "test prompt",
      params: {
        imageModel: "nano-banana-pro",
        aspectRatio: "16:9",
        outputsPerPrompt: 4,
        downloadImageQuality: "2k",
        downloadVideoQuality: "1080p"
      }
    });
    assert.equal(parsed.mode, mode);
    assert.equal(parsed.params.outputsPerPrompt, 4);
  }
});

test("BridgeServer <-> Extension WebSocket <-> BridgeClient full job lifecycle", async () => {
  const port = 18795;
  const server = new BridgeServer(port, "127.0.0.1");
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.once("open", r));

  ws.send(
    JSON.stringify({
      type: "hello",
      version: "1.0.0",
      status: {
        extensionVersion: "1.0.0",
        onFlowPage: true,
        loggedIn: true,
        usage: { plan: "pro", effectivePlan: "pro" }
      },
      jobs: []
    })
  );

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.cmd === "status.get") {
      ws.send(
        JSON.stringify({
          type: "response",
          reqId: msg.reqId,
          ok: true,
          status: {
            extensionVersion: "1.0.0",
            onFlowPage: true,
            loggedIn: true,
            usage: { plan: "pro", effectivePlan: "pro" }
          }
        })
      );
    } else if (msg.cmd === "job.submit") {
      const job = {
        ...msg.job,
        id: "job_unit_1",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      ws.send(JSON.stringify({ type: "response", reqId: msg.reqId, ok: true, job }));
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "event",
            event: {
              kind: "queue.updated",
              jobs: [
                {
                  ...job,
                  status: "done",
                  resultFiles: [{ path: "/Downloads/flow-connector/job_unit_1-0.png", kind: "image" }]
                }
              ]
            }
          })
        );
      }, 60);
    }
  });

  const client = new BridgeClient(`http://127.0.0.1:${port}`);
  const statusRes = await client.getStatus();
  assert.equal(statusRes.extensionConnected, true);
  assert.equal(statusRes.status.usage.plan, "pro");

  const created = await client.createJob({
    mode: "flow-image",
    prompt: "test glass sculpture",
    params: { imageModel: "nano-banana-pro", downloadImageQuality: "2k" }
  });
  assert.equal(created.job.id, "job_unit_1");

  const waited = await client.waitJob("job_unit_1", 5000);
  assert.equal(waited.job.status, "done");
  assert.equal(waited.job.resultFiles[0].path, "/Downloads/flow-connector/job_unit_1-0.png");

  ws.close();
  await server.stop();
});

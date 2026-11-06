import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { BridgeServer, BridgeClient } from "../src/bridge.mjs";
import { JobCreateSchema, GENERATION_MODES } from "../src/shared.mjs";
import {
  extractFlowMediaUrls,
  extractMediaPrompts,
  extractAsbTokens,
  isFlowUrl,
  isVideoGenerationMode
} from "../extension/src/shared/flow-url.js";
import { getSelectors, getMaxReferences } from "../extension/src/shared/selectors.js";

test("Flow URL, selectors, and RPC payload extractors work accurately", () => {
  assert.equal(isFlowUrl("https://labs.google/fx/tools/flow/project/123"), true);
  assert.equal(isFlowUrl("https://flow.google.com/project/abc"), true);
  assert.equal(isFlowUrl("https://example.com"), false);
  assert.equal(isVideoGenerationMode("flow-text-to-video"), true);
  assert.equal(isVideoGenerationMode("flow-image"), false);

  const selectors = getSelectors();
  assert.ok(selectors.promptInput.length > 0);
  assert.ok(selectors.submitButton.length > 0);
  assert.equal(getMaxReferences("flow-image", "nano-banana-pro"), 10);
  assert.equal(getMaxReferences("flow-ingredients-to-video", "veo-3.1-fast"), 3);

  const sampleRpc =
    '["11111111-2222-3333-4444-555555555555",null,"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",null,[[null,1,null,2,"cinematic neon skyline"]]] ' +
    'https://flow-content.google/video/11111111-2222-3333-4444-555555555555?token=abc ' +
    '["11111111-2222-3333-4444-555555555555","22222222-3333-4444-5555-666666666666","33333333-4444-5555-6666-777777777777","/asb/asb_tok_123",[[1,2],"cinematic neon skyline"]]';

  const urls = extractFlowMediaUrls(sampleRpc);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("flow-content.google/video/11111111-2222-3333-4444-555555555555"));

  const prompts = extractMediaPrompts(sampleRpc);
  assert.deepEqual(prompts, [["11111111-2222-3333-4444-555555555555", "cinematic neon skyline"]]);

  const asbs = extractAsbTokens(sampleRpc);
  assert.equal(asbs.length, 1);
  assert.deepEqual(asbs[0], ["11111111-2222-3333-4444-555555555555", "asb_tok_123", "cinematic neon skyline"]);
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

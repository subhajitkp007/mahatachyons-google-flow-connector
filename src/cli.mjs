import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { BridgeClient, BridgeServer } from "./bridge.mjs";
import {
  GENERATION_MODES,
  FLOW_MODELS,
  ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  IMAGE_QUALITIES,
  VIDEO_QUALITIES,
  MODE_DESCRIPTIONS
} from "./shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(os.homedir(), ".mflow", "runs");

function saveRunManifest(runId, entries, meta = {}) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${runId}.json`);
  const payload = {
    runId,
    updatedAt: new Date().toISOString(),
    ...meta,
    entries
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function loadRunManifest(runId) {
  if (!fs.existsSync(RUNS_DIR)) return null;
  if (runId) {
    const p = path.join(RUNS_DIR, runId.endsWith(".json") ? runId : `${runId}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  }
  const files = fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, files[0]), "utf8"));
}

function parsePromptsInput(promptOpt, promptsFileOpt) {
  const list = [];
  if (promptOpt) list.push(promptOpt.trim());
  if (promptsFileOpt) {
    const raw = fs.readFileSync(path.resolve(promptsFileOpt), "utf8").trim();
    if (promptsFileOpt.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) list.push(item.trim());
          else if (item && typeof item.prompt === "string") list.push(item.prompt.trim());
        }
      }
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const clean = line.trim();
        if (clean && !clean.startsWith("#")) list.push(clean);
      }
    }
  }
  return list;
}

export async function runCli(argv = process.argv) {
  const program = new Command();
  const client = new BridgeClient();

  program
    .name("mflow")
    .description(
      "Mahatachyons Google Flow Connector — Unrestricted CLI & Agent Bridge for Google Flow (Veo 3.1 & Nano Banana)"
    )
    .version("1.0.0");

  program
    .command("status")
    .description("Show bridge, Chrome extension, Flow tab, and queue status")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const res = await client.getStatus();
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log("=== Mahatachyons Google Flow Connector Status ===");
      console.log(`Extension Connected : ${res.extensionConnected ? "YES" : "NO"}`);
      if (res.status) {
        const s = res.status;
        console.log(`Extension Version   : ${s.extensionVersion}`);
        console.log(`Plan                : UNLIMITED PRO (Local Self-Hosted)`);
        console.log(`Queue Paused        : ${s.paused ? "YES" : "NO"}`);
        console.log(`Flow Tabs Open      : ${s.flowTabs?.length ?? 0}`);
        console.log(`On Flow Page        : ${s.onFlowPage ? "YES" : "NO"}`);
        console.log(`Google Logged In    : ${s.loggedIn === false ? "NO" : s.loggedIn ? "YES" : "UNKNOWN"}`);
        console.log(
          `Queue Counts        : running=${s.queueCounts?.running ?? 0}, queued=${s.queueCounts?.queued ?? 0}, done=${s.queueCounts?.done ?? 0}, failed=${s.queueCounts?.failed ?? 0}`
        );
      }
    });

  program
    .command("doctor")
    .description("Verify end-to-end readiness and run DOM selector healthcheck on Google Flow")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const statusRes = await client.getStatus();
      let hcRes = null;
      if (statusRes.extensionConnected) {
        hcRes = await client.runHealthcheck().catch((e) => ({ error: e.message, entries: [] }));
      }
      if (opts.json) {
        console.log(JSON.stringify({ status: statusRes, healthcheck: hcRes }, null, 2));
        return;
      }
      console.log("=== Mahatachyons Flow Doctor ===");
      console.log(`[1] Local Bridge (:8791)      : OK`);
      console.log(`[2] Chrome Extension          : ${statusRes.extensionConnected ? "CONNECTED" : "NOT CONNECTED"}`);
      if (!statusRes.extensionConnected) {
        console.log("    -> Load ./extension as an unpacked extension in chrome://extensions");
        process.exitCode = 1;
        return;
      }
      const st = statusRes.status;
      console.log(`[3] Flow Tab Open             : ${st?.flowTabs?.length ? `YES (${st.flowTabs[0].url})` : "NO"}`);
      console.log(`[4] Logged Into Google        : ${st?.loggedIn === false ? "NO" : "YES"}`);
      if (hcRes?.error) {
        console.log(`[5] Selector Healthcheck      : WARN (${hcRes.error})`);
      } else if (hcRes?.entries) {
        const matched = hcRes.entries.filter((e) => e.matched).length;
        console.log(`[5] Selector Healthcheck      : ${matched}/${hcRes.entries.length} selectors matched on current view`);
      }
    });

  program
    .command("modes")
    .description("List all supported Google Flow generation modes and models")
    .option("--json", "Output raw JSON")
    .action((opts) => {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              modes: MODE_DESCRIPTIONS,
              models: FLOW_MODELS,
              aspectRatios: ASPECT_RATIOS,
              videoDurations: VIDEO_DURATIONS,
              videoResolutions: VIDEO_RESOLUTIONS,
              imageQualities: IMAGE_QUALITIES,
              videoQualities: VIDEO_QUALITIES
            },
            null,
            2
          )
        );
        return;
      }
      console.log("=== Supported Generation Modes ===");
      for (const [mode, info] of Object.entries(MODE_DESCRIPTIONS)) {
        console.log(`  ${mode.padEnd(28)} [${info.kind.padEnd(7)}] maxRefs=${info.maxImages}  ${info.summary}`);
      }
      console.log("\n=== Supported Models ===");
      console.log(`  ${FLOW_MODELS.join(", ")}`);
      console.log("\n=== Aspect Ratios ===");
      console.log(`  ${ASPECT_RATIOS.join(", ")}`);
    });

  program
    .command("bridge")
    .description("Run the local HTTP + WebSocket bridge server in the foreground")
    .action(async () => {
      const server = new BridgeServer();
      await server.start();
      console.log(`Mahatachyons Flow Bridge listening on http://127.0.0.1:${server.port}`);
    });

  const gen = program.command("generate").description("Create, inspect, wait on, or resume Flow generation jobs");

  gen
    .command("create")
    .description("Submit one or more Flow generation jobs")
    .option("-m, --mode <mode>", `Generation mode (${GENERATION_MODES.join("|")})`, "flow-image")
    .option("-p, --prompt <text>", "Prompt text")
    .option("--prompts-file <path>", "Text or JSON file with multiple prompts (batch mode)")
    .option("-i, --images <paths...>", "Local reference image/video file paths")
    .option("--asset-ref <names...>", "Attach existing project assets by name")
    .option("--character-ref <names...>", "Attach existing Flow characters by name")
    .option("--character-name <name>", "Character name (for flow-create-character / flow-set-voice)")
    .option("--voice <filter>", "Preset voice search filter (for flow-set-voice)")
    .option("--new-name <name>", "New asset title (for flow-rename-asset)")
    .option("--image-model <model>", `Model (${FLOW_MODELS.join("|")})`)
    .option("--aspect <ratio>", `Aspect ratio (${ASPECT_RATIOS.join("|")})`)
    .option("--video-option <duration>", `Video duration (${VIDEO_DURATIONS.join("|")})`)
    .option("--video-resolution <res>", `Video resolution (${VIDEO_RESOLUTIONS.join("|")})`)
    .option("--outputs-per-prompt <n>", "Outputs per prompt (1-4)", (v) => parseInt(v, 10))
    .option("--image-quality <q>", `Image download quality (${IMAGE_QUALITIES.join("|")})`)
    .option("--video-quality <q>", `Video download quality (${VIDEO_QUALITIES.join("|")})`)
    .option("--new-project", "Start in a newly created Flow project")
    .option("-o, --output-dir <dir>", "Subfolder inside ~/Downloads (default: flow-connector)")
    .option("--prefix <prefix>", "Filename prefix for downloaded files")
    .option("--wait", "Wait for all submitted jobs to finish and print output file paths")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const prompts = parsePromptsInput(opts.prompt, opts.promptsFile);
      if (prompts.length === 0) prompts.push("");

      const params = {
        ...(opts.imageModel ? { imageModel: opts.imageModel } : {}),
        ...(opts.aspect ? { aspectRatio: opts.aspect } : {}),
        ...(opts.videoOption ? { videoOption: opts.videoOption } : {}),
        ...(opts.videoResolution ? { videoResolution: opts.videoResolution } : {}),
        ...(opts.outputsPerPrompt ? { outputsPerPrompt: opts.outputsPerPrompt } : {}),
        ...(opts.imageQuality ? { downloadImageQuality: opts.imageQuality } : {}),
        ...(opts.videoQuality ? { downloadVideoQuality: opts.videoQuality } : {}),
        ...(opts.newProject ? { newProject: true } : {})
      };

      const runId = `run_${Date.now().toString(36)}`;
      const submittedJobs = [];

      for (let idx = 0; idx < prompts.length; idx++) {
        const jobParams = idx === 0 ? params : { ...params, newProject: false };
        const res = await client.createJob({
          mode: opts.mode,
          prompt: prompts[idx],
          params: jobParams,
          imagePaths: opts.images ?? [],
          assetRefs: opts.assetRef,
          characterRefs: opts.characterRef,
          characterName: opts.characterName,
          voiceFilter: opts.voice,
          newAssetName: opts.newName,
          outputDir: opts.outputDir,
          filenamePrefix: opts.prefix ? (prompts.length > 1 ? `${opts.prefix}-${idx + 1}` : opts.prefix) : undefined
        });
        submittedJobs.push(res.job);
      }

      const manifestEntries = submittedJobs.map((j) => ({
        jobId: j.id,
        mode: j.mode,
        prompt: j.prompt,
        params: j.params,
        imagePaths: j.imagePaths,
        status: j.status,
        resultFiles: j.resultFiles ?? []
      }));
      saveRunManifest(runId, manifestEntries, { mode: opts.mode });

      if (!opts.wait) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, runId, jobs: submittedJobs }, null, 2));
        } else {
          for (const j of submittedJobs) {
            console.log(`Enqueued ${j.id} (${j.mode}): ${j.prompt || "(no prompt)"}`);
          }
          console.log(`Run ID: ${runId}`);
        }
        return;
      }

      const finishedJobs = [];
      for (let i = 0; i < submittedJobs.length; i++) {
        const j = submittedJobs[i];
        const waitRes = await client.waitJob(j.id);
        finishedJobs.push(waitRes.job);
        manifestEntries[i].status = waitRes.job.status;
        manifestEntries[i].resultFiles = waitRes.job.resultFiles ?? [];
        manifestEntries[i].error = waitRes.job.error;
        saveRunManifest(runId, manifestEntries, { mode: opts.mode });
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, runId, jobs: finishedJobs }, null, 2));
        return;
      }

      for (const j of finishedJobs) {
        if (j.status === "done") {
          console.log(`✓ ${j.id} DONE`);
          for (const f of j.resultFiles ?? []) {
            console.log(`  -> ${f.path}${f.label ? ` (asset: ${f.label})` : ""}`);
          }
        } else {
          console.error(`✗ ${j.id} ${j.status.toUpperCase()}: ${j.error ?? "unknown error"}`);
          process.exitCode = 1;
        }
      }
    });

  gen
    .command("list")
    .description("List jobs in the queue")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const res = await client.listJobs();
      if (opts.json) {
        console.log(JSON.stringify(res.jobs, null, 2));
        return;
      }
      if (res.jobs.length === 0) {
        console.log("Queue is empty.");
        return;
      }
      for (const j of res.jobs) {
        console.log(
          `${j.id}  [${j.status.padEnd(9)}]  ${j.mode.padEnd(24)}  ${(j.prompt || "").slice(0, 60)}`
        );
      }
    });

  gen
    .command("get <jobId>")
    .description("Get details for a specific job")
    .option("--json", "Output JSON")
    .action(async (jobId, opts) => {
      const res = await client.getJob(jobId);
      if (opts.json) {
        console.log(JSON.stringify(res.job, null, 2));
        return;
      }
      console.log(res.job);
    });

  gen
    .command("wait <jobId>")
    .description("Wait for a job to finish")
    .option("--json", "Output JSON")
    .action(async (jobId, opts) => {
      const res = await client.waitJob(jobId);
      if (opts.json) {
        console.log(JSON.stringify(res.job, null, 2));
        return;
      }
      console.log(res.job);
    });

  gen
    .command("cancel <jobId>")
    .description("Cancel a queued or running job")
    .action(async (jobId) => {
      const res = await client.cancelJob(jobId);
      console.log(`Cancelled ${jobId}: status=${res.job?.status ?? "unknown"}`);
    });

  gen
    .command("runs")
    .description("List saved batch run manifests in ~/.mflow/runs")
    .action(() => {
      if (!fs.existsSync(RUNS_DIR)) {
        console.log("No saved runs found.");
        return;
      }
      const files = fs
        .readdirSync(RUNS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
      for (const f of files.slice(0, 25)) {
        const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
        const done = (data.entries ?? []).filter((e) => e.status === "done").length;
        console.log(`${data.runId}  (${data.updatedAt})  ${done}/${(data.entries ?? []).length} done`);
      }
    });

  gen
    .command("resume [runId]")
    .description("Re-submit unfinished or failed prompts from a saved batch run")
    .option("--wait", "Wait for resumed jobs to finish")
    .action(async (runId, opts) => {
      const manifest = loadRunManifest(runId);
      if (!manifest) {
        console.error("Run manifest not found.");
        process.exitCode = 1;
        return;
      }
      const pending = (manifest.entries ?? []).filter((e) => e.status !== "done");
      if (pending.length === 0) {
        console.log(`All ${manifest.entries.length} job(s) in ${manifest.runId} are already done.`);
        return;
      }
      console.log(`Resuming ${pending.length} unfinished job(s) from ${manifest.runId}…`);
      for (const entry of pending) {
        const res = await client.createJob({
          mode: entry.mode,
          prompt: entry.prompt,
          params: entry.params ?? {},
          imagePaths: entry.imagePaths ?? []
        });
        entry.jobId = res.job.id;
        entry.status = res.job.status;
        if (opts.wait) {
          const waited = await client.waitJob(res.job.id);
          entry.status = waited.job.status;
          entry.resultFiles = waited.job.resultFiles ?? [];
        }
      }
      saveRunManifest(manifest.runId, manifest.entries, { mode: manifest.mode });
      console.log(`Updated run manifest ${manifest.runId}`);
    });

  program
    .command("stop")
    .description("Immediately stop all running and queued jobs")
    .action(async () => {
      const res = await client.stopAll();
      console.log(`Stopped queue (${res.cancelled ?? 0} job(s) cancelled).`);
    });

  const qCmd = program.command("queue").description("Manage the extension job queue");
  qCmd
    .command("clear")
    .description("Clear finished jobs from the extension queue")
    .action(async () => {
      await client.clearQueue();
      console.log("Queue cleared.");
    });

  program
    .command("reload-extension")
    .description("Remotely reload the Chrome extension")
    .action(async () => {
      await client.reloadExtension();
      console.log("Reload signal sent to Chrome extension.");
    });

  program
    .command("merge <clips...>")
    .description("Concatenate video clips using ffmpeg (with optional crossfade and audio track)")
    .requiredOption("-o, --output <path>", "Output mp4 file path")
    .option("--audio <path>", "Optional background audio file")
    .action((clips, opts) => {
      const absClips = clips.map((c) => path.resolve(c));
      const listFile = path.join(os.tmpdir(), `mflow_concat_${Date.now()}.txt`);
      fs.writeFileSync(
        listFile,
        absClips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
      );
      try {
        const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
        if (opts.audio) {
          args.push("-i", path.resolve(opts.audio), "-c:v", "copy", "-c:a", "aac", "-shortest");
        } else {
          args.push("-c", "copy");
        }
        args.push(path.resolve(opts.output));
        execFileSync("ffmpeg", args, { stdio: "inherit" });
        console.log(`Merged ${absClips.length} clip(s) -> ${path.resolve(opts.output)}`);
      } finally {
        fs.rmSync(listFile, { force: true });
      }
    });

  program
    .command("clean <inputs...>")
    .description("Remove bottom-right watermark from generated images or videos")
    .option("--mode <mode>", "Cleaning method: delogo | crop | inpaint", "delogo")
    .option("-o, --output <path>", "Output file path (defaults to <input>-clean.<ext>)")
    .action((inputs, opts) => {
      const inpaintScript = path.resolve(__dirname, "../tools/inpaint.py");
      for (const input of inputs) {
        const absIn = path.resolve(input);
        const ext = path.extname(absIn);
        const absOut = opts.output
          ? path.resolve(opts.output)
          : `${absIn.slice(0, -ext.length)}-clean${ext}`;

        if (opts.mode === "inpaint" && fs.existsSync(inpaintScript)) {
          execFileSync("python3", [inpaintScript, absIn, absOut], { stdio: "inherit" });
        } else if (opts.mode === "crop") {
          execFileSync(
            "ffmpeg",
            ["-y", "-i", absIn, "-vf", "crop=iw:ih-56:0:0", absOut],
            { stdio: "inherit" }
          );
        } else {
          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-i",
              absIn,
              "-vf",
              "delogo=x=iw-170:y=ih-52:w=160:h=44",
              absOut
            ],
            { stdio: "inherit" }
          );
        }
        console.log(`Cleaned -> ${absOut}`);
      }
    });

  const skillCmd = program.command("skill").description("Manage the Mahatachyons Flow AI Agent Skill");
  skillCmd
    .command("install")
    .description("Install the flow-generate SKILL.md into Claude Code, Cursor, or Antigravity skills folder")
    .option("--dir <targetDir>", "Custom target skills directory")
    .action((opts) => {
      const srcSkill = path.resolve(__dirname, "../skills/flow-generate/SKILL.md");
      const targets = opts.dir
        ? [path.resolve(opts.dir, "flow-generate")]
        : [
            path.join(os.homedir(), ".claude", "skills", "flow-generate"),
            path.join(os.homedir(), ".agents", "skills", "flow-generate")
          ];
      for (const dir of targets) {
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, "SKILL.md");
        fs.copyFileSync(srcSkill, dest);
        console.log(`Installed skill -> ${dest}`);
      }
    });

  await program.parseAsync(argv);
}


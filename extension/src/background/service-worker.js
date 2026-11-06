// Mahatachyons Google Flow Connector — Background Service Worker (Unrestricted Edition)
import {
  FLOW_HOME_URL,
  FLOW_ORIGIN_PATTERNS,
  isFlowUrl,
  isVideoGenerationMode
} from "../shared/flow-url.js";
import { createLogger, getLogs, clearLogs } from "../shared/logger.js";
import { getTunable } from "../shared/selectors.js";

const BRIDGE_PORT = 8791;
const BRIDGE_HTTP = `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_WS = `ws://127.0.0.1:${BRIDGE_PORT}/ws`;
const KEEPALIVE_ALARM = "mflow-keepalive";
const QUEUE_STORAGE_KEY = "mflow:queue";
const PAUSED_STORAGE_KEY = "mflow:paused";
const SPEED_STORAGE_KEY = "mflow:speed";
const MAX_STORED_JOBS = 200;
const TERMINAL_RETENTION_MS = 24 * 3600 * 1000;
const SINGLE_DISPATCH_MODES = new Set([
  "flow-upload-assets",
  "flow-create-character",
  "flow-set-voice",
  "flow-extend-video",
  "flow-rename-asset"
]);

const bgLog = createLogger("bg");
const wsLog = createLogger("ws");
const dlLog = createLogger("download");

// Speed & Batching Table (Unrestricted — all 6 speeds unlocked)
const SPEED_PRESETS = {
  1: { batchSize: 1, maxOutputs: 4, gapMs: [3000, 6000], cooldownMs: [12000, 20000] },
  2: { batchSize: 2, maxOutputs: 4, gapMs: [3500, 6500], cooldownMs: [14000, 22000] },
  3: { batchSize: 3, maxOutputs: 6, gapMs: [4000, 7500], cooldownMs: [15000, 25000] },
  4: { batchSize: 4, maxOutputs: 8, gapMs: [4500, 8000], cooldownMs: [16000, 26000] },
  5: { batchSize: 6, maxOutputs: 10, gapMs: [4000, 7000], cooldownMs: [14000, 22000] },
  6: { batchSize: 8, maxOutputs: 12, gapMs: [2500, 4500], cooldownMs: [8000, 14000] }
};

async function getBatchSpeedConfig() {
  try {
    const stored = await chrome.storage.local.get(SPEED_STORAGE_KEY);
    const raw = Number(stored[SPEED_STORAGE_KEY]);
    const level = raw >= 1 && raw <= 6 ? Math.round(raw) : 4;
    return SPEED_PRESETS[level] ?? SPEED_PRESETS[4];
  } catch {
    return SPEED_PRESETS[4];
  }
}

// Model Fallback Chains on Quota Exhaustion
const MODEL_FALLBACKS = {
  "veo-3.1-quality": "veo-3.1-fast",
  "veo-3.1-fast": "veo-3.1-lite",
  "veo-3.1-lite": "omni-flash",
  "nano-banana-pro": "nano-banana-2",
  "nano-banana-2": "nano-banana-2-lite"
};

function getNextFallbackModel(job) {
  const current =
    job.params.imageModel ??
    (isVideoGenerationMode(job.mode) ? "omni-flash" : "nano-banana-2-lite");
  return MODEL_FALLBACKS[current] ?? null;
}

// Persistent Job Queue Manager
class JobQueueManager {
  constructor() {
    this.jobs = new Map();
    this.loaded = false;
    this.listeners = new Set();
  }

  async init() {
    if (this.loaded) return;
    const data = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
    const list = data[QUEUE_STORAGE_KEY] ?? [];
    for (const job of list) {
      if (job.status === "running") {
        job.status = "queued";
        job.stage = undefined;
        job.stageDetail = undefined;
      }
      this.jobs.set(job.id, job);
    }
    this.loaded = true;
    bgLog.info(`loaded ${this.jobs.size} job(s) from storage`);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async persist() {
    const now = Date.now();
    const all = [...this.jobs.values()]
      .filter((j) => {
        if (j.status === "queued" || j.status === "running") return true;
        return now - j.updatedAt < TERMINAL_RETENTION_MS;
      })
      .slice(-MAX_STORED_JOBS);

    this.jobs.clear();
    for (const j of all) this.jobs.set(j.id, j);
    await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: all });
    for (const fn of this.listeners) {
      try {
        fn(all);
      } catch {}
    }
  }

  async enqueue(input) {
    await this.init();
    const now = Date.now();
    const job = {
      id: input.id ?? `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      mode: input.mode,
      prompt: input.prompt,
      params: input.params ?? {},
      imagePaths: input.imagePaths ?? [],
      assetRefs: input.assetRefs,
      characterRefs: input.characterRefs,
      characterName: input.characterName,
      voiceFilter: input.voiceFilter,
      newAssetName: input.newAssetName,
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      createdAt: now,
      updatedAt: now,
      outputDir: input.outputDir,
      filenamePrefix: input.filenamePrefix,
      resultFiles: []
    };
    this.jobs.set(job.id, job);
    await this.persist();
    bgLog.info(`enqueued ${job.id} (${job.mode})`);
    return job;
  }

  nextQueued() {
    for (const j of this.jobs.values()) {
      if (j.status === "queued") return j;
    }
    return undefined;
  }

  nextCompatibleBatch(maxJobs, maxTotalOutputs) {
    const head = this.nextQueued();
    if (!head) return [];
    if (SINGLE_DISPATCH_MODES.has(head.mode)) return [head];

    const outputsOf = (j) => Math.max(1, Math.min(4, j.params.outputsPerPrompt ?? 1));
    const settingsSignature = (j) => {
      const p = j.params;
      return `${j.mode}|${p.imageModel ?? ""}|${p.aspectRatio ?? ""}|${p.videoOption ?? ""}|${p.videoResolution ?? ""}|${outputsOf(j)}`;
    };

    const headSig = settingsSignature(head);
    const batch = [head];
    let totalOutputs = outputsOf(head);

    for (const j of this.jobs.values()) {
      if (batch.length >= maxJobs) break;
      if (j.id === head.id || j.status !== "queued") continue;
      if (j.params.newProject) break;
      const count = outputsOf(j);
      if (totalOutputs + count > maxTotalOutputs) break;
      if (settingsSignature(j) === headSig) {
        batch.push(j);
        totalOutputs += count;
      }
    }
    return batch;
  }

  runningCount() {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "running") n++;
    }
    return n;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async setStage(id, stage, detail) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.stage = stage;
    j.stageDetail = detail;
    j.updatedAt = Date.now();
    await this.persist();
  }

  async markRunning(id, tabId) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.status = "running";
    j.stage = "preparing-page";
    j.stageDetail = undefined;
    j.tabId = tabId;
    j.attempts += 1;
    j.startedAt = Date.now();
    j.updatedAt = Date.now();
    await this.persist();
  }

  async markDone(id, files, warningNote) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.status = "done";
    j.stage = undefined;
    j.stageDetail = undefined;
    j.resultFiles = files;
    j.error = warningNote || undefined;
    j.finishedAt = Date.now();
    j.updatedAt = Date.now();
    await this.persist();
  }

  async markFailed(id, error, retryable = true) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.error = error;
    j.updatedAt = Date.now();
    if (retryable && j.attempts < j.maxAttempts) {
      j.status = "queued";
      j.stage = undefined;
      j.stageDetail = undefined;
      j.tabId = undefined;
      bgLog.warn(`job ${id} failed (attempt ${j.attempts}/${j.maxAttempts}), re-queued: ${error}`);
    } else {
      j.status = "failed";
      j.stage = undefined;
      j.stageDetail = undefined;
      j.finishedAt = Date.now();
      bgLog.error(`job ${id} permanently failed: ${error}`);
    }
    await this.persist();
  }

  async requeueForPause(id) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running") return;
    j.status = "queued";
    j.stage = undefined;
    j.stageDetail = undefined;
    j.tabId = undefined;
    j.attempts = Math.max(0, j.attempts - 1);
    j.updatedAt = Date.now();
    await this.persist();
  }

  async requeueWithFallbackModel(id, nextModel, reason) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running") return;
    const prev = j.params.imageModel ?? "default";
    j.params.imageModel = nextModel;
    j.status = "queued";
    j.stage = undefined;
    j.stageDetail = undefined;
    j.tabId = undefined;
    j.attempts = Math.max(0, j.attempts - 1);
    j.error = `${prev} hit quota (${reason}) — switched to ${nextModel}`;
    j.updatedAt = Date.now();
    bgLog.warn(`job ${id}: ${j.error}`);
    await this.persist();
  }

  async cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    if (j.status === "done" || j.status === "failed") return j;
    j.status = "cancelled";
    j.finishedAt = Date.now();
    j.updatedAt = Date.now();
    await this.persist();
    return j;
  }

  async clearFinished() {
    for (const [id, j] of this.jobs) {
      if (j.status !== "queued" && j.status !== "running") {
        this.jobs.delete(id);
      }
    }
    await this.persist();
  }

  async clearAll() {
    const count = this.jobs.size;
    this.jobs.clear();
    await this.persist();
    bgLog.info(`cleared all ${count} job(s)`);
    return count;
  }
}

const queue = new JobQueueManager();

// Unrestricted Plan / Usage Status Helper
function getUnlimitedUsageSummary() {
  return {
    plan: "pro",
    effectivePlan: "pro",
    trialEndsAt: null,
    trialDaysLeft: 999,
    trialActive: false,
    date: new Date().toISOString().slice(0, 10),
    videosUsed: 0,
    imagesUsed: 0,
    videosRemaining: 999999,
    imagesRemaining: 999999,
    limits: { videosPerDay: 999999, imagesPerDay: 999999 }
  };
}

// Chrome Debugger (CDP v1.3) Trusted Input Controller
const attachedDebuggerTabs = new Set();

chrome.debugger?.onDetach.addListener((source) => {
  if (source.tabId != null) attachedDebuggerTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedDebuggerTabs.delete(tabId);
});

async function ensureDebuggerAttached(tabId) {
  if (!chrome.debugger) {
    throw new Error("chrome.debugger API unavailable — reload the extension");
  }
  if (attachedDebuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedDebuggerTabs.add(tabId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Already attached")) {
      attachedDebuggerTabs.add(tabId);
      return;
    }
    throw err;
  }
}

async function detachAllDebuggers() {
  if (!chrome.debugger || attachedDebuggerTabs.size === 0) return;
  for (const tabId of [...attachedDebuggerTabs]) {
    attachedDebuggerTabs.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  }
}

async function sendCdpCommand(tabId, method, params) {
  await ensureDebuggerAttached(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    attachedDebuggerTabs.delete(tabId);
    await ensureDebuggerAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

async function dispatchTrustedClick(tabId, x, y, button = "left") {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const buttons = button === "right" ? 2 : 1;
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rx,
    y: ry
  });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rx,
    y: ry,
    button,
    buttons,
    clickCount: 1
  });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rx,
    y: ry,
    button,
    buttons: 0,
    clickCount: 1
  });
}

async function dispatchTrustedMove(tabId, x, y) {
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(x),
    y: Math.round(y)
  });
}

// Download Manager (Direct + 2K/1080p Flow Upscale Intercept)
let pendingFlowCapture = null;
const activeFlowDownloads = new Map();

function sanitizeFilenameSegment(str) {
  return (
    str
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.\.+/g, "_")
      .replace(/[<>:"|?*\x00-\x1f]/g, "_")
      .slice(0, 120) || "flow-connector"
  );
}

function resolveRelativeFolder(outputDir) {
  if (!outputDir) return "flow-connector";
  const norm = outputDir.replace(/\\/g, "/");
  const dlMatch = norm.match(/\/Downloads\/(.+?)\/?$/i);
  if (dlMatch) return sanitizeFilenameSegment(dlMatch[1]);
  if (!norm.startsWith("/") && !/^[a-zA-Z]:/.test(norm)) {
    return sanitizeFilenameSegment(norm);
  }
  const base = norm.split("/").filter(Boolean).pop() ?? "flow-connector";
  return `flow-connector/${sanitizeFilenameSegment(base)}`;
}

function inferExtension(url, kind, fallback = "bin") {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".mp4")) return "mp4";
  if (clean.endsWith(".webm")) return "webm";
  if (clean.endsWith(".png")) return "png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "jpg";
  if (clean.endsWith(".webp")) return "webp";
  if (kind === "video") return "mp4";
  if (kind === "image") return "png";
  return fallback;
}

if (chrome.downloads?.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (!pendingFlowCapture) return;
    const cap = pendingFlowCapture;
    pendingFlowCapture = null;
    clearTimeout(cap.timer);

    const ext =
      item.filename.split(".").pop()?.toLowerCase() ||
      (cap.kind === "video" ? "mp4" : "png");
    const targetFilename = `${cap.prefix}-${cap.index}.${ext}`;
    dlLog.info(`intercepted Flow upscale download #${item.id} -> ${targetFilename}`);
    activeFlowDownloads.set(item.id, { resolve: cap.resolve });
    suggest({ filename: targetFilename, conflictAction: "uniquify" });
  });
}

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    const entry = activeFlowDownloads.get(delta.id);
    if (!entry) return;
    if (delta.state?.current === "complete") {
      activeFlowDownloads.delete(delta.id);
      chrome.downloads.search({ id: delta.id }, (items) => {
        const path = items?.[0]?.filename;
        dlLog.info(`Flow upscale download complete: ${path}`);
        entry.resolve(
          path ? { ok: true, path } : { ok: false, error: "completed without filename" }
        );
      });
    } else if (delta.state?.current === "interrupted") {
      activeFlowDownloads.delete(delta.id);
      const reason = delta.error?.current ?? "interrupted";
      dlLog.error(`Flow upscale download failed: ${reason}`);
      entry.resolve({ ok: false, error: reason });
    }
  });
}

function captureNextFlowDownload(opts) {
  if (pendingFlowCapture) {
    clearTimeout(pendingFlowCapture.timer);
    pendingFlowCapture.resolve({ ok: false, error: "superseded by newer capture" });
    pendingFlowCapture = null;
  }
  const folder = resolveRelativeFolder(opts.outputDir);
  const prefix = sanitizeFilenameSegment(opts.filenamePrefix ?? opts.jobId);
  const fullPrefix = `${folder}/${prefix}`;
  const timeoutMs = opts.timeoutMs ?? 60000;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingFlowCapture?.timer === timer) pendingFlowCapture = null;
      dlLog.warn(`Flow upscale capture timed out after ${timeoutMs / 1000}s for ${opts.jobId}`);
      resolve({
        ok: false,
        error: `Flow did not start the download within ${Math.round(timeoutMs / 1000)}s`
      });
    }, timeoutMs);

    pendingFlowCapture = {
      jobId: opts.jobId,
      kind: opts.kind,
      prefix: fullPrefix,
      index: opts.index,
      resolve,
      timer
    };
  });
}

async function downloadDirectUrl(req) {
  const ext = inferExtension(req.url, req.kind);
  const folder = resolveRelativeFolder(req.outputDir);
  const prefix = sanitizeFilenameSegment(req.filenamePrefix ?? req.jobId);
  const filename = `${folder}/${prefix}-${req.index}.${ext}`;
  dlLog.info(`downloading ${req.kind} -> ${filename}`);

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: req.url, filename, conflictAction: "uniquify", saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || id === undefined) {
          reject(new Error(err?.message ?? "download failed to start"));
        } else {
          resolve(id);
        }
      }
    );
  });

  const finalPath = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onDelta);
      reject(new Error("download timed out after 180s"));
    }, 180000);

    const onDelta = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onDelta);
        chrome.downloads.search({ id: downloadId }, (items) => {
          resolve(items?.[0]?.filename ?? filename);
        });
      } else if (delta.state?.current === "interrupted") {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onDelta);
        reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown"}`));
      }
    };
    chrome.downloads.onChanged.addListener(onDelta);
  });

  dlLog.info(`saved ${finalPath}`);
  return finalPath;
}

// Tab Pool & Content Script Injection
const busyTabs = new Set();
let creatingFlowTab = null;

async function findFlowTabs() {
  const tabs = await chrome.tabs.query({ url: [...FLOW_ORIGIN_PATTERNS] });
  return tabs.filter((t) => t.id !== undefined && isFlowUrl(t.url));
}

async function ensureContentScriptReady(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { t: "page.status" });
    if (res?.ok) return true;
  } catch {}

  try {
    bgLog.info(`injecting content scripts into tab ${tabId}`);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/main-world-spy.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/automator-loader.js"]
    });
    await new Promise((r) => setTimeout(r, 400));
    const res = await chrome.tabs.sendMessage(tabId, { t: "page.status" });
    return !!res?.ok;
  } catch (err) {
    bgLog.warn(`failed to inject content script into tab ${tabId}`, err);
    return false;
  }
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timed out waiting for Flow tab to load"));
    }, timeoutMs);

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function acquireFlowTab() {
  const existing = await findFlowTabs();
  const free = existing.find((t) => !busyTabs.has(t.id));
  if (free?.id !== undefined) {
    await ensureContentScriptReady(free.id);
    return free.id;
  }

  if (existing.length === 0) {
    if (!creatingFlowTab) {
      creatingFlowTab = (async () => {
        bgLog.info("opening new Flow tab");
        const tab = await chrome.tabs.create({ url: FLOW_HOME_URL, active: true });
        if (tab.id === undefined) throw new Error("failed to create Flow tab");
        await waitForTabComplete(tab.id);
        return tab.id;
      })().finally(() => {
        creatingFlowTab = null;
      });
    }
    const tabId = await creatingFlowTab;
    if (!busyTabs.has(tabId)) {
      await ensureContentScriptReady(tabId);
      return tabId;
    }
  }
  return null;
}

// Local File Fetching from Bridge
async function fetchLocalFileAsDataUrl(filePath) {
  const res = await fetch(`${BRIDGE_HTTP}/files/by-path?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    throw new Error(`bridge file fetch failed (${res.status}) for ${filePath}`);
  }
  const blob = await res.blob();
  const mime = blob.type || "image/png";
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
  const name = filePath.split(/[\\/]/).pop() ?? "image.png";
  return { name, mime, dataUrl };
}

// WebSocket Bridge Client
let ws = null;
let bridgeConnected = false;
let reconnectTimer = null;

function sendToBridge(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastEvent(event) {
  sendToBridge({ type: "event", event });
  chrome.runtime.sendMessage({ t: "bg.event", event }).catch(() => {});
}

queue.onChange((jobs) => {
  broadcastEvent({ kind: "queue.updated", jobs });
});

function connectBridgeWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(BRIDGE_WS);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    bridgeConnected = true;
    wsLog.info("connected to local Mahatachyons Flow bridge");
    await queue.init();
    const status = await buildFullStatus();
    sendToBridge({
      type: "hello",
      version: chrome.runtime.getManifest().version,
      status,
      jobs: queue.list()
    });
    broadcastEvent({ kind: "status.updated", status });
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      handleBridgeCommand(msg);
    } catch (err) {
      wsLog.warn("invalid message from bridge", err);
    }
  };

  ws.onclose = () => {
    if (bridgeConnected) wsLog.info("disconnected from local bridge");
    bridgeConnected = false;
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridgeWebSocket();
  }, 3000);
}

async function handleBridgeCommand(msg) {
  const { reqId, cmd } = msg;
  const reply = (payload) => sendToBridge({ type: "response", reqId, ...payload });

  try {
    switch (cmd) {
      case "job.submit": {
        const job = await queue.enqueue(msg.job);
        reply({ ok: true, job });
        kickScheduler();
        break;
      }
      case "job.cancel": {
        const job = await queue.cancel(msg.jobId);
        if (job?.tabId !== undefined) {
          chrome.tabs.sendMessage(job.tabId, { t: "job.cancel", jobId: job.id }).catch(() => {});
        }
        reply({ ok: true, job });
        break;
      }
      case "queue.list": {
        await queue.init();
        reply({ ok: true, jobs: queue.list() });
        break;
      }
      case "queue.clear": {
        await queue.init();
        const cleared = await queue.clearAll();
        reply({ ok: true, cleared });
        break;
      }
      case "queue.stop": {
        const result = await stopAllRunningJobs();
        reply({ ok: true, ...result });
        break;
      }
      case "status.get": {
        reply({ ok: true, status: await buildFullStatus() });
        break;
      }
      case "healthcheck.run": {
        const result = await runHealthcheckOnActiveFlowTab();
        reply({ ok: true, ...result });
        break;
      }
      case "logs.get": {
        reply({ ok: true, logs: await getLogs() });
        break;
      }
      case "dom.dump": {
        const tabs = await findFlowTabs();
        if (tabs.length === 0 || tabs[0].id === undefined) {
          reply({ ok: false, error: "no Flow tab open" });
          break;
        }
        await ensureContentScriptReady(tabs[0].id);
        const dump = await chrome.tabs.sendMessage(tabs[0].id, {
          t: "dom.dump",
          selector: msg.selector,
          clickFirst: msg.clickFirst
        });
        reply({ ok: true, dump });
        break;
      }
      case "ext.reload": {
        reply({ ok: true, reloading: true });
        setTimeout(() => chrome.runtime.reload(), 150);
        break;
      }
      default:
        reply({ ok: false, error: `unknown command: ${cmd}` });
    }
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// Scheduler & Execution Loop
let schedulerRunning = false;
let queuePaused = false;
let cooldownUntil = 0;
let cooldownTimer = null;
let unusualStrikeCount = 0;
let hasCompletedBatchInRun = false;
const activeGroupTabByJobId = new Map();
const downloadCountByJobId = new Map();

chrome.storage.local.get(PAUSED_STORAGE_KEY).then((data) => {
  queuePaused = !!data[PAUSED_STORAGE_KEY];
});

function scheduleCooldownWakeup(delayMs) {
  cooldownUntil = Date.now() + delayMs;
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    kickScheduler();
  }, delayMs + 50);
}

async function stopAllRunningJobs() {
  await queue.init();
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  cooldownUntil = 0;
  unusualStrikeCount = 0;
  hasCompletedBatchInRun = false;

  const tabs = await findFlowTabs();
  await Promise.all(
    tabs.map((t) =>
      t.id !== undefined
        ? chrome.tabs.sendMessage(t.id, { t: "job.abort" }).catch(() => null)
        : null
    )
  );
  busyTabs.clear();
  activeGroupTabByJobId.clear();

  let cancelled = 0;
  for (const j of queue.list()) {
    if (j.status === "queued" || j.status === "running") {
      await queue.cancel(j.id);
      cancelled++;
    }
  }
  await detachAllDebuggers();
  bgLog.info(`stopped all jobs (${cancelled} cancelled)`);
  broadcastEvent({ kind: "status.updated", status: await buildFullStatus() });
  return { cancelled };
}

async function kickScheduler() {
  if (schedulerRunning || queuePaused) return;
  const remainingCooldown = cooldownUntil - Date.now();
  if (remainingCooldown > 0) {
    scheduleCooldownWakeup(remainingCooldown);
    return;
  }

  schedulerRunning = true;
  try {
    await queue.init();
    while (!queuePaused) {
      if (cooldownUntil > Date.now()) break;
      const speed = await getBatchSpeedConfig();
      const batch = queue.nextCompatibleBatch(speed.batchSize, speed.maxOutputs);
      if (batch.length === 0) break;

      if (hasCompletedBatchInRun) {
        const [minCd, maxCd] = speed.cooldownMs;
        const cd = Math.floor(minCd + Math.random() * (maxCd - minCd + 1));
        hasCompletedBatchInRun = false;
        bgLog.info(`cooling down ${(cd / 1000).toFixed(1)}s before next batch`);
        scheduleCooldownWakeup(cd);
        break;
      }

      const tabId = await acquireFlowTab();
      if (tabId === null) break;

      const preloadcandidates = queue
        .list()
        .filter((j) => j.status === "queued")
        .slice(0, 16);

      busyTabs.add(tabId);
      runBatchOnTab(batch, tabId, speed.gapMs, preloadcandidates)
        .finally(async () => {
          busyTabs.delete(tabId);
          hasCompletedBatchInRun = true;
          await queue.init();
          if (!queue.nextQueued() && queue.runningCount() === 0) {
            hasCompletedBatchInRun = false;
            await detachAllDebuggers();
          }
          kickScheduler();
        });
    }
  } finally {
    schedulerRunning = false;
  }
}

async function runBatchOnTab(batch, tabId, gapRange, preloadJobs) {
  const payload = [];
  for (const job of batch) {
    await queue.markRunning(job.id, tabId);
    activeGroupTabByJobId.set(job.id, tabId);
    downloadCountByJobId.set(job.id, 0);

    try {
      const images = [];
      for (const p of job.imagePaths) {
        images.push(await fetchLocalFileAsDataUrl(p));
      }
      payload.push({
        job,
        images,
        gap: { minMs: gapRange[0], maxMs: gapRange[1] }
      });
    } catch (err) {
      activeGroupTabByJobId.delete(job.id);
      await queue.markFailed(job.id, err instanceof Error ? err.message : String(err), false);
    }
  }

  if (payload.length === 0) return;

  const batchPaths = new Set(batch.flatMap((j) => j.imagePaths));
  const extraPaths = [...new Set(preloadJobs.flatMap((j) => j.imagePaths))]
    .filter((p) => !batchPaths.has(p))
    .slice(0, 12);
  const preloadImages = [];
  for (const p of extraPaths) {
    try {
      preloadImages.push(await fetchLocalFileAsDataUrl(p));
    } catch {}
  }

  bgLog.info(`dispatching batch of ${payload.length} job(s) to tab ${tabId}`);
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      t: "job.runGroup",
      payload,
      preload: preloadImages
    });
    if (res && !res.ok) {
      for (const { job } of payload) {
        if (activeGroupTabByJobId.has(job.id)) {
          activeGroupTabByJobId.delete(job.id);
          await queue.markFailed(job.id, res.error ?? "group dispatch failed", res.retryable ?? true);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const { job } of payload) {
      if (activeGroupTabByJobId.has(job.id)) {
        activeGroupTabByJobId.delete(job.id);
        await queue.markFailed(job.id, `tab communication lost: ${msg}`, true);
      }
    }
  }
}

async function handleJobResultFromContent(msg) {
  const { jobId, ok, files, error, retryable = true, haltQueue = false } = msg;
  activeGroupTabByJobId.delete(jobId);
  const job = queue.get(jobId);
  if (!job || job.status === "cancelled") return;

  if (ok) {
    unusualStrikeCount = 0;
    await queue.markDone(jobId, files ?? [], error);
    return;
  }

  if (error === "paused") {
    await queue.requeueForPause(jobId);
    return;
  }

  if (error && /usage limit|daily limit|quota/i.test(error)) {
    const fallback = getNextFallbackModel(job);
    if (fallback) {
      await queue.requeueWithFallbackModel(jobId, fallback, error);
      return;
    }
    queuePaused = true;
    await chrome.storage.local.set({ [PAUSED_STORAGE_KEY]: true });
    await queue.markFailed(jobId, `${error} (all models exhausted — queue paused)`, false);
    broadcastEvent({ kind: "status.updated", status: await buildFullStatus() });
    return;
  }

  if (error && /unusual|suspicious|automated|rate limit|try again later/i.test(error)) {
    unusualStrikeCount++;
    const strikeCooldowns = getTunable("strikeCooldownsMs", [60000, 150000, 300000]);
    if (unusualStrikeCount > strikeCooldowns.length) {
      queuePaused = true;
      await chrome.storage.local.set({ [PAUSED_STORAGE_KEY]: true });
      await queue.markFailed(jobId, `${error} — queue paused after ${unusualStrikeCount} strikes`, false);
      broadcastEvent({ kind: "status.updated", status: await buildFullStatus() });
      return;
    }
    const waitMs = strikeCooldowns[unusualStrikeCount - 1];
    bgLog.warn(`anti-bot toast strike #${unusualStrikeCount} — cooling down ${waitMs / 1000}s`);
    scheduleCooldownWakeup(waitMs);
    await queue.markFailed(jobId, error, true);
    return;
  }

  if (haltQueue) {
    queuePaused = true;
    await chrome.storage.local.set({ [PAUSED_STORAGE_KEY]: true });
  }
  await queue.markFailed(jobId, error ?? "unknown error", retryable);
}

// Status & Healthcheck Builders
async function buildFullStatus() {
  await queue.init();
  const tabs = await findFlowTabs();
  let pageStatus = null;
  if (tabs[0]?.id !== undefined) {
    try {
      await ensureContentScriptReady(tabs[0].id);
      pageStatus = await chrome.tabs.sendMessage(tabs[0].id, { t: "page.status" });
    } catch {}
  }

  const allJobs = queue.list();
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    bridgeConnected,
    paused: queuePaused,
    flowTabs: tabs.map((t) => ({
      id: t.id,
      url: t.url ?? "",
      title: t.title ?? "",
      active: !!t.active,
      busy: busyTabs.has(t.id)
    })),
    onFlowPage: !!pageStatus?.onFlow,
    loggedIn: pageStatus?.loggedIn ?? null,
    narrowViewport: !!pageStatus?.narrow,
    queueCounts: {
      queued: allJobs.filter((j) => j.status === "queued").length,
      running: allJobs.filter((j) => j.status === "running").length,
      done: allJobs.filter((j) => j.status === "done").length,
      failed: allJobs.filter((j) => j.status === "failed").length
    },
    usage: getUnlimitedUsageSummary()
  };
}

async function runHealthcheckOnActiveFlowTab() {
  const tabs = await findFlowTabs();
  if (tabs.length === 0 || tabs[0].id === undefined) {
    return {
      tabUrl: null,
      entries: [],
      error: "No Google Flow tab is open. Open https://labs.google/fx/tools/flow first."
    };
  }
  const tab = tabs[0];
  const ready = await ensureContentScriptReady(tab.id);
  if (!ready) {
    return {
      tabUrl: tab.url ?? null,
      entries: [],
      error: "Content script could not attach to the Flow tab. Refresh the Flow tab."
    };
  }
  const res = await chrome.tabs.sendMessage(tab.id, { t: "healthcheck.run" });
  return {
    tabUrl: tab.url ?? null,
    entries: res?.entries ?? [],
    diagnostics: res?.diagnostics
  };
}

// Runtime Message Listener (Content Scripts & Side Panel)
let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "mflow-sidepanel") {
    sidePanelPort = port;
    port.onDisconnect.addListener(() => {
      if (sidePanelPort === port) sidePanelPort = null;
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.t) {
      case "debugger.click": {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return sendResponse({ ok: false, error: "no sender tab" });
        await dispatchTrustedClick(tabId, msg.x, msg.y, msg.button ?? "left");
        return sendResponse({ ok: true });
      }
      case "debugger.move": {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return sendResponse({ ok: false, error: "no sender tab" });
        await dispatchTrustedMove(tabId, msg.x, msg.y);
        return sendResponse({ ok: true });
      }
      case "download.direct": {
        const job = queue.get(msg.jobId);
        const path = await downloadDirectUrl({
          jobId: msg.jobId,
          url: msg.url,
          kind: msg.kind,
          index: msg.index,
          outputDir: job?.outputDir,
          filenamePrefix: job?.filenamePrefix
        });
        return sendResponse({ ok: true, path });
      }
      case "download.captureFlow": {
        const job = queue.get(msg.jobId);
        const idx = downloadCountByJobId.get(msg.jobId) ?? 0;
        downloadCountByJobId.set(msg.jobId, idx + 1);
        const res = await captureNextFlowDownload({
          jobId: msg.jobId,
          kind: msg.kind,
          index: idx,
          outputDir: job?.outputDir,
          filenamePrefix: job?.filenamePrefix,
          timeoutMs: msg.timeoutMs
        });
        return sendResponse(res);
      }
      case "panel.closeForUpscale": {
        if (sidePanelPort) {
          try {
            sidePanelPort.postMessage({ t: "panel.closeSelf" });
            return sendResponse({ closed: true });
          } catch {}
        }
        return sendResponse({ closed: false });
      }
      case "job.progress": {
        await queue.setStage(msg.jobId, msg.stage, msg.message);
        return sendResponse({ ok: true });
      }
      case "job.result": {
        await handleJobResultFromContent(msg);
        return sendResponse({ ok: true });
      }
      case "job.submit": {
        const job = await queue.enqueue(msg.job);
        kickScheduler();
        return sendResponse({ ok: true, job });
      }
      case "job.cancel": {
        const job = await queue.cancel(msg.jobId);
        if (job?.tabId !== undefined) {
          chrome.tabs.sendMessage(job.tabId, { t: "job.cancel", jobId: job.id }).catch(() => {});
        }
        return sendResponse({ ok: true, job });
      }
      case "queue.list": {
        await queue.init();
        return sendResponse({ ok: true, jobs: queue.list() });
      }
      case "queue.clear": {
        await queue.init();
        await queue.clearFinished();
        return sendResponse({ ok: true, jobs: queue.list() });
      }
      case "queue.clearAll": {
        await queue.init();
        const cleared = await queue.clearAll();
        return sendResponse({ ok: true, cleared, jobs: [] });
      }
      case "queue.stop": {
        const res = await stopAllRunningJobs();
        return sendResponse({ ok: true, ...res });
      }
      case "queue.setPaused": {
        queuePaused = !!msg.paused;
        await chrome.storage.local.set({ [PAUSED_STORAGE_KEY]: queuePaused });
        if (queuePaused) {
          for (const tabId of busyTabs) {
            chrome.tabs.sendMessage(tabId, { t: "job.pause" }).catch(() => {});
          }
        } else {
          kickScheduler();
        }
        const status = await buildFullStatus();
        broadcastEvent({ kind: "status.updated", status });
        return sendResponse({ ok: true, paused: queuePaused, status });
      }
      case "status.get": {
        return sendResponse({ ok: true, status: await buildFullStatus() });
      }
      case "usage.get": {
        return sendResponse({ ok: true, usage: getUnlimitedUsageSummary() });
      }
      case "healthcheck.trigger": {
        const result = await runHealthcheckOnActiveFlowTab();
        return sendResponse({ ok: true, ...result });
      }
      case "logs.get": {
        return sendResponse({ ok: true, logs: await getLogs() });
      }
      case "logs.clear": {
        await clearLogs();
        return sendResponse({ ok: true });
      }
      case "flow.openTab": {
        const tabs = await findFlowTabs();
        if (tabs[0]?.id !== undefined) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          return sendResponse({ ok: true, tabId: tabs[0].id });
        }
        const created = await chrome.tabs.create({ url: FLOW_HOME_URL, active: true });
        return sendResponse({ ok: true, tabId: created.id });
      }
      default:
        return sendResponse({ ok: false, error: `unhandled message: ${msg?.t}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

// Sidepanel Open Behavior & Alarms
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    connectBridgeWebSocket();
    kickScheduler();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  bgLog.info("Mahatachyons Google Flow Connector installed (Unrestricted Pro Edition)");
  connectBridgeWebSocket();
});

connectBridgeWebSocket();
queue.init().then(() => kickScheduler());


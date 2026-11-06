import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BRIDGE_HOST, BRIDGE_PORT, BRIDGE_HTTP_URL, JobCreateSchema } from "./shared.mjs";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

export class BridgeServer {
  constructor(port = BRIDGE_PORT, host = BRIDGE_HOST) {
    this.port = port;
    this.host = host;
    this.extSocket = null;
    this.extVersion = null;
    this.lastStatus = null;
    this.jobsCache = new Map();
    this.pendingRequests = new Map();
    this.jobWaiters = new Map();
    this.allowedPaths = new Set();
    this.reqCounter = 0;

    this.httpServer = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
      if (url.pathname === "/ws") {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWsConnection(ws);
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  async stop() {
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge shutting down"));
    }
    this.pendingRequests.clear();
    if (this.extSocket) {
      try {
        this.extSocket.close();
      } catch {}
    }
    await new Promise((resolve) => this.httpServer.close(() => resolve()));
  }

  handleWsConnection(ws) {
    if (this.extSocket && this.extSocket.readyState === 1) {
      try {
        this.extSocket.close();
      } catch {}
    }
    this.extSocket = ws;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        this.onExtensionMessage(msg);
      } catch {}
    });

    ws.on("close", () => {
      if (this.extSocket === ws) {
        this.extSocket = null;
      }
    });
  }

  onExtensionMessage(msg) {
    if (msg.type === "hello") {
      this.extVersion = msg.version ?? "1.0.0";
      this.lastStatus = msg.status ?? null;
      if (Array.isArray(msg.jobs)) {
        this.syncJobsCache(msg.jobs);
      }
      return;
    }

    if (msg.type === "response" && msg.reqId) {
      const pending = this.pendingRequests.get(msg.reqId);
      if (pending) {
        this.pendingRequests.delete(msg.reqId);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
      return;
    }

    if (msg.type === "event" && msg.event) {
      const ev = msg.event;
      if (ev.kind === "queue.updated" && Array.isArray(ev.jobs)) {
        this.syncJobsCache(ev.jobs);
      } else if (ev.kind === "status.updated" && ev.status) {
        this.lastStatus = ev.status;
      }
    }
  }

  syncJobsCache(jobs) {
    this.jobsCache.clear();
    for (const j of jobs) {
      this.jobsCache.set(j.id, j);
      if (j.status === "done" || j.status === "failed" || j.status === "cancelled") {
        const waiters = this.jobWaiters.get(j.id);
        if (waiters) {
          this.jobWaiters.delete(j.id);
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve(j);
          }
        }
      }
    }
  }

  sendToExtension(cmd, payload = {}, timeoutMs = 25000) {
    if (!this.extSocket || this.extSocket.readyState !== 1) {
      return Promise.reject(
        new Error(
          "Mahatachyons Chrome extension is not connected to the local bridge. Make sure the extension is loaded in Chrome."
        )
      );
    }

    const reqId = `req_${++this.reqCounter}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`extension command '${cmd}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });
      this.extSocket.send(JSON.stringify({ reqId, cmd, ...payload }));
    });
  }

  waitForJobTerminal(jobId, timeoutMs = 25 * 60000) {
    const existing = this.jobsCache.get(jobId);
    if (
      existing &&
      (existing.status === "done" || existing.status === "failed" || existing.status === "cancelled")
    ) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.jobWaiters.get(jobId) ?? [];
        this.jobWaiters.set(
          jobId,
          list.filter((item) => item.timer !== timer)
        );
        reject(new Error(`timed out waiting for job ${jobId}`));
      }, timeoutMs);

      const list = this.jobWaiters.get(jobId) ?? [];
      list.push({ resolve, reject, timer });
      this.jobWaiters.set(jobId, list);
    });
  }

  sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(body);
  }

  async readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }

  async handleHttp(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      return this.sendJson(res, 200, {
        ok: true,
        bridge: "mahatachyons-flow-connector",
        port: this.port,
        extensionConnected: !!(this.extSocket && this.extSocket.readyState === 1),
        extensionVersion: this.extVersion
      });
    }

    if (req.method === "GET" && pathname === "/files/by-path") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return this.sendJson(res, 400, { ok: false, error: "missing path" });
      const resolved = path.resolve(filePath);
      if (!this.allowedPaths.has(resolved) || !fs.existsSync(resolved)) {
        return this.sendJson(res, 403, { ok: false, error: "file not registered or does not exist" });
      }
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    if (req.method === "GET" && pathname === "/status") {
      if (this.extSocket && this.extSocket.readyState === 1) {
        const extRes = await this.sendToExtension("status.get");
        return this.sendJson(res, 200, {
          ok: true,
          extensionConnected: true,
          status: extRes.status
        });
      }
      return this.sendJson(res, 200, {
        ok: true,
        extensionConnected: false,
        status: this.lastStatus
      });
    }

    if (req.method === "GET" && pathname === "/jobs") {
      if (this.extSocket && this.extSocket.readyState === 1) {
        const extRes = await this.sendToExtension("queue.list");
        if (Array.isArray(extRes.jobs)) this.syncJobsCache(extRes.jobs);
      }
      return this.sendJson(res, 200, {
        ok: true,
        jobs: [...this.jobsCache.values()].sort((a, b) => b.createdAt - a.createdAt)
      });
    }

    if (req.method === "POST" && pathname === "/jobs") {
      const body = await this.readJsonBody(req);
      const parsed = JobCreateSchema.parse(body);
      const resolvedPaths = parsed.imagePaths.map((p) => {
        const abs = path.resolve(p);
        if (!fs.existsSync(abs)) {
          throw new Error(`Input file not found: ${abs}`);
        }
        this.allowedPaths.add(abs);
        return abs;
      });
      const jobInput = { ...parsed, imagePaths: resolvedPaths };
      const extRes = await this.sendToExtension("job.submit", { job: jobInput });
      if (!extRes.ok) {
        return this.sendJson(res, 500, { ok: false, error: extRes.error ?? "failed to enqueue job" });
      }
      this.jobsCache.set(extRes.job.id, extRes.job);
      return this.sendJson(res, 200, { ok: true, job: extRes.job });
    }

    const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      if (this.extSocket && this.extSocket.readyState === 1) {
        const extRes = await this.sendToExtension("queue.list");
        if (Array.isArray(extRes.jobs)) this.syncJobsCache(extRes.jobs);
      }
      const job = this.jobsCache.get(jobId);
      if (!job) return this.sendJson(res, 404, { ok: false, error: `job not found: ${jobId}` });
      return this.sendJson(res, 200, { ok: true, job });
    }

    const waitMatch = pathname.match(/^\/jobs\/([^/]+)\/wait$/);
    if (req.method === "GET" && waitMatch) {
      const jobId = decodeURIComponent(waitMatch[1]);
      const timeoutMs = Number(url.searchParams.get("timeoutMs") || 25 * 60000);
      const job = await this.waitForJobTerminal(jobId, timeoutMs);
      return this.sendJson(res, 200, { ok: true, job });
    }

    const cancelMatch = pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const jobId = decodeURIComponent(cancelMatch[1]);
      const extRes = await this.sendToExtension("job.cancel", { jobId });
      return this.sendJson(res, 200, { ok: extRes.ok, job: extRes.job, error: extRes.error });
    }

    if (req.method === "POST" && pathname === "/stop") {
      const extRes = await this.sendToExtension("queue.stop");
      return this.sendJson(res, 200, extRes);
    }

    if (req.method === "POST" && pathname === "/queue/clear") {
      const extRes = await this.sendToExtension("queue.clear");
      this.jobsCache.clear();
      return this.sendJson(res, 200, extRes);
    }

    if (req.method === "POST" && pathname === "/reload-extension") {
      const extRes = await this.sendToExtension("ext.reload");
      return this.sendJson(res, 200, extRes);
    }

    if (req.method === "GET" && pathname === "/healthcheck") {
      const extRes = await this.sendToExtension("healthcheck.run", {}, 30000);
      return this.sendJson(res, 200, extRes);
    }

    if (req.method === "GET" && pathname === "/logs") {
      const extRes = await this.sendToExtension("logs.get");
      return this.sendJson(res, 200, extRes);
    }

    if (req.method === "POST" && pathname === "/dom") {
      const body = await this.readJsonBody(req);
      const extRes = await this.sendToExtension("dom.dump", body, 20000);
      return this.sendJson(res, 200, extRes);
    }

    return this.sendJson(res, 404, { ok: false, error: `not found: ${pathname}` });
  }
}

export class BridgeClient {
  constructor(baseUrl = BRIDGE_HTTP_URL) {
    this.baseUrl = baseUrl;
  }

  async isHealthy() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const data = await res.json();
      return !!data?.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning() {
    if (await this.isHealthy()) return;

    const thisFile = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [thisFile, "--daemon"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Failed to start local bridge on ${this.baseUrl}`);
  }

  async request(method, route, body, timeoutMs = 30000) {
    await this.ensureRunning();
    const res = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status} on ${route}`);
    }
    return data;
  }

  getHealth() {
    return this.request("GET", "/health");
  }

  getStatus() {
    return this.request("GET", "/status");
  }

  listJobs() {
    return this.request("GET", "/jobs");
  }

  getJob(id) {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}`);
  }

  createJob(job) {
    return this.request("POST", "/jobs", job);
  }

  waitJob(id, timeoutMs = 25 * 60000) {
    return this.request(
      "GET",
      `/jobs/${encodeURIComponent(id)}/wait?timeoutMs=${timeoutMs}`,
      undefined,
      timeoutMs + 5000
    );
  }

  cancelJob(id) {
    return this.request("POST", `/jobs/${encodeURIComponent(id)}/cancel`);
  }

  stopAll() {
    return this.request("POST", "/stop");
  }

  clearQueue() {
    return this.request("POST", "/queue/clear");
  }

  reloadExtension() {
    return this.request("POST", "/reload-extension");
  }

  runHealthcheck() {
    return this.request("GET", "/healthcheck", undefined, 35000);
  }

  getLogs() {
    return this.request("GET", "/logs");
  }
}

// Allow running bridge.mjs directly as background daemon
if (process.argv.includes("--daemon")) {
  const srv = new BridgeServer();
  srv.start().catch((err) => {
    console.error("Failed to start Mahatachyons Bridge:", err);
    process.exit(1);
  });
}


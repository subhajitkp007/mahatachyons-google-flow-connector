const LOG_STORAGE_KEY = "mflow:logs";
const MAX_LOGS = 2000;
const FLUSH_INTERVAL_MS = 500;

let pendingLogs = [];
let flushTimer = null;

async function flushLogs() {
  flushTimer = null;
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs;
  pendingLogs = [];
  try {
    const existing = (await chrome.storage.local.get(LOG_STORAGE_KEY))[LOG_STORAGE_KEY] ?? [];
    const merged = existing.concat(batch).slice(-MAX_LOGS);
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: merged });
  } catch {
    // Ignore storage errors during unload
  }
}

function serializeData(data) {
  if (data === undefined) return undefined;
  const replacer = (_, val) =>
    val instanceof Error
      ? { name: val.name, message: val.message, stack: val.stack }
      : val;
  try {
    const parsed = JSON.parse(JSON.stringify(data, replacer));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Object.keys(parsed).length === 0 &&
      String(data) !== "[object Object]"
    ) {
      return String(data);
    }
    return parsed;
  } catch {
    return String(data);
  }
}

function recordLog(entry) {
  pendingLogs.push(entry);
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
  }
  const prefix = `[mflow:${entry.ctx}] ${entry.msg}`;
  if (entry.level === "error") console.error(prefix, entry.data ?? "");
  else if (entry.level === "warn") console.warn(prefix, entry.data ?? "");
  else console.log(prefix, entry.data ?? "");
}

if (typeof addEventListener === "function") {
  addEventListener("pagehide", () => void flushLogs());
}

export function createLogger(ctx) {
  const make = (level) => (msg, data) =>
    recordLog({
      ts: Date.now(),
      level,
      ctx,
      msg,
      data: serializeData(data)
    });
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error")
  };
}

export async function getLogs() {
  const stored = (await chrome.storage.local.get(LOG_STORAGE_KEY))[LOG_STORAGE_KEY] ?? [];
  return stored.concat(pendingLogs);
}

export async function clearLogs() {
  pendingLogs = [];
  await chrome.storage.local.remove(LOG_STORAGE_KEY);
}


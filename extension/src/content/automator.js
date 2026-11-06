import {
  getSelectors,
  getTunable,
  isVideoGenerationMode,
  MODE_LIMITS,
  getMaxReferences,
  loadSelectorOverrides
} from "../shared/selectors.js";
import {
  extractAsbFromUrl,
  extractMediaIdFromContentUrl,
  isClipEditorUrl,
  isFlowUrl,
  buildFlowRootUrl,
  PROJECT_PATH_RE,
  buildFlowProjectUrl
} from "../shared/flow-url.js";
import { createLogger } from "../shared/logger.js";

const resolveLog = createLogger("resolve");
const actionLog = createLogger("actions");
const genLog = createLogger("generation");
const autoLog = createLogger("automator-flow");
const contentLog = createLogger("content");
const netLog = createLogger("net");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitterSleep = (min = 150, max = 350) => sleep(min + Math.random() * (max - min));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripExt = (s) => s.replace(/\.[^.]+$/, "");

function isVisible(el) {
  if (!el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function matchesText(el, regex) {
  const txt = (el.textContent ?? "").trim();
  return txt.length > 0 && txt.length < 200 && regex.test(txt);
}

export function queryStrategy(strategy, root = document) {
  switch (strategy.kind) {
    case "css": {
      const scope = strategy.within ? (root.querySelector(strategy.within) ?? undefined) : root;
      if (!scope) return [];
      const all = [...scope.querySelectorAll(strategy.css)];
      return strategy.hidden ? all.filter((el) => el.isConnected) : all.filter(isVisible);
    }
    case "text": {
      const re = new RegExp(strategy.text, "i");
      const selector = strategy.role
        ? `[role="${strategy.role}"], ${strategy.role === "button" ? "button" : strategy.role === "option" ? "option" : "*"}`
        : (strategy.tag ?? "button, a, [role], span, div, p");
      const matches = [...root.querySelectorAll(selector)].filter((el) => isVisible(el) && matchesText(el, re));
      return matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    }
    case "aria": {
      const sel = `${strategy.tag ?? ""}[aria-label*="${strategy.label}" i]`;
      return [...root.querySelectorAll(sel)].filter(isVisible);
    }
    case "testid": {
      const sel = strategy.prefix
        ? `[data-testid^="${strategy.id}"]`
        : `[data-testid="${strategy.id}"]`;
      return [...root.querySelectorAll(sel)].filter(isVisible);
    }
    default:
      return [];
  }
}

export function resolveSelector(key, root = document) {
  const strategies = getSelectors()[key];
  if (!strategies) {
    resolveLog.warn(`unknown selector key: ${key}`);
    return null;
  }
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const els = queryStrategy(strategy, root);
    if (els.length > 0) {
      return { el: els[0], strategy, strategyIndex: i };
    }
  }
  return null;
}

export function waitForSelector(key, opts = {}) {
  const { timeoutMs = 10000, root = document, required = true } = opts;
  return new Promise((resolve, reject) => {
    const immediate = resolveSelector(key, root);
    if (immediate) {
      resolveLog.debug(`resolved ${key} immediately via ${immediate.strategy.kind}#${immediate.strategyIndex}`);
      return resolve(immediate);
    }
    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(poller);
      clearTimeout(timer);
      if (found) {
        resolveLog.debug(`resolved ${key} via ${found.strategy.kind}#${found.strategyIndex}`);
        resolve(found);
      } else if (required) {
        resolveLog.error(`selector timeout: ${key} (${timeoutMs}ms)`);
        reject(new Error(`SELECTOR_TIMEOUT:${key}`));
      } else {
        resolve(null);
      }
    };
    const check = () => {
      const found = resolveSelector(key, root);
      if (found) finish(found);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-label", "data-testid"]
    });
    const poller = setInterval(check, 250);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function dispatchPointerSequence(el) {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0
  };
  el.dispatchEvent(new PointerEvent("pointerover", init));
  el.dispatchEvent(new PointerEvent("pointerenter", init));
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new PointerEvent("pointerup", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", init));
}

async function clickTrusted(el, button = "left", retriedBackdrop = false) {
  const holdRes = await chrome.runtime.sendMessage({ t: "debugger.hold" }).catch(() => null);
  if (holdRes?.fresh) await sleep(400);

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await jitterSleep();

  let rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    await sleep(400);
    rect = el.getBoundingClientRect();
  }
  if (rect.width < 1 || rect.height < 1) {
    throw new Error(
      `clickTrusted: <${el.tagName.toLowerCase()}> has no box on screen (${Math.round(rect.width)}x${Math.round(rect.height)})`
    );
  }

  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;

  const hitsTarget = (px, py) => {
    const topEl = document.elementFromPoint(px, py);
    return !!topEl && (topEl === el || el.contains(topEl) || topEl.contains(el));
  };

  if (!hitsTarget(x, y)) {
    const alt = [
      [rect.left + rect.width * 0.25, rect.top + rect.height / 2],
      [rect.left + rect.width * 0.75, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + rect.height * 0.25],
      [rect.left + rect.width / 2, rect.top + rect.height * 0.75]
    ].find(([px, py]) => hitsTarget(px, py));

    if (alt) {
      [x, y] = alt;
      actionLog.info(`clickTrusted: center covered — aiming at clear quadrant on <${el.tagName.toLowerCase()}>`);
    } else {
      const topEl = document.elementFromPoint(x, y);
      if (!retriedBackdrop && topEl instanceof HTMLElement && topEl.classList.contains("cdk-overlay-backdrop")) {
        actionLog.info("clickTrusted: dropdown backdrop covering target — dismissing and retrying");
        dispatchPointerSequence(topEl);
        await sleep(400);
        return clickTrusted(el, button, true);
      }
      const desc = topEl
        ? `<${topEl.tagName.toLowerCase()}${topEl.className ? ` class="${String(topEl.className).slice(0, 40)}"` : ""}>`
        : "nothing";
      throw new Error(
        `clickTrusted: (${Math.round(x)},${Math.round(y)}) is covered by ${desc}, not <${el.tagName.toLowerCase()}>`
      );
    }
  }

  const res = await chrome.runtime.sendMessage({
    t: "click.trusted",
    x,
    y,
    button
  });
  if (!res?.ok) {
    throw new Error(`clickTrusted failed: ${res?.error ?? "unknown error"}`);
  }
  await jitterSleep();
}

async function nudgePointer(el) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const points = [
    { x: cx - rect.width / 4, y: cy },
    { x: cx, y: cy },
    { x: cx + rect.width / 4, y: cy - rect.height / 4 }
  ];
  try {
    await chrome.runtime.sendMessage({ t: "pointer.move", points });
  } catch (err) {
    actionLog.warn("nudgePointer failed (non-fatal)", err);
  }
}

async function clickSynthetic(el) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await jitterSleep();
  dispatchPointerSequence(el);
  await jitterSleep();
}

async function typeText(el, text) {
  if (
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLInputElement) &&
    !el.isContentEditable
  ) {
    const inner = el.querySelector(
      '[contenteditable="true"], textarea, input[type="text"], input:not([type])'
    );
    if (inner) el = inner;
  }

  el.focus();
  await jitterSleep();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;

    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (el.isContentEditable) {
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    const matches = () => norm(el.textContent) === norm(text);
    const selectAll = async () => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await sleep(60);
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      await selectAll();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        })
      );
      await sleep(250);
      if (matches()) {
        actionLog.debug(`typeText: landed via paste (attempt ${attempt})`);
        return;
      }

      await selectAll();
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true
        })
      );
      await sleep(250);
      if (matches()) {
        actionLog.debug(`typeText: landed via beforeinput (attempt ${attempt})`);
        return;
      }

      if (attempt < 3) {
        el.focus();
        await sleep(600 * attempt);
      }
    }
    throw new Error("typeText: editor rejected text via paste and beforeinput");
  }

  throw new Error(`typeText: unsupported element <${el.tagName.toLowerCase()}>`);
}

function isDisabled(el) {
  return (
    el.disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    el.hasAttribute("disabled")
  );
}

async function submitEnter(el) {
  el.focus();
  await jitterSleep(150, 300);
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
  );
  await jitterSleep(100, 200);
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true
    })
  );
}

function readInputValue(el) {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
    ? el.value
    : (el.textContent ?? "");
}

async function populateFileInput(inputEl, files, dropFallbackEl) {
  const dt = new DataTransfer();
  for (const file of files) dt.items.add(file);
  if (inputEl) {
    inputEl.files = dt.files;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (dropFallbackEl) {
    const rect = dropFallbackEl.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer: dt
    };
    dropFallbackEl.dispatchEvent(new DragEvent("dragenter", init));
    dropFallbackEl.dispatchEvent(new DragEvent("dragover", init));
    dropFallbackEl.dispatchEvent(new DragEvent("drop", init));
    return;
  }
  throw new Error("populateFileInput: no file input or drop target available");
}

// Media & Network Spy State
const videoUrlById = new Map();
const firstSeenAtById = new Map();
const idByAsbToken = new Map();
const promptById = new Map();
const MAX_TRACKED_MEDIA = 4000;
let lastUploadDoneAt = 0;

function recordReadyMediaUrl(url) {
  const mediaId = /flow-content\.google\/(?:image|video)\/([^?/]+)/.exec(url)?.[1];
  if (mediaId && !firstSeenAtById.has(mediaId)) {
    firstSeenAtById.set(mediaId, Date.now());
    if (firstSeenAtById.size > MAX_TRACKED_MEDIA) {
      const oldest = firstSeenAtById.keys().next().value;
      if (oldest !== undefined) firstSeenAtById.delete(oldest);
    }
  }
  const videoId = /flow-content\.google\/video\/([^?/]+)/.exec(url)?.[1];
  if (videoId) {
    videoUrlById.set(videoId, url);
    if (videoUrlById.size > 2000) {
      const oldest = videoUrlById.keys().next().value;
      if (oldest !== undefined) videoUrlById.delete(oldest);
    }
  }
}

function recordMediaAsb(id, token) {
  idByAsbToken.set(token, id);
  if (idByAsbToken.size > MAX_TRACKED_MEDIA) {
    const oldest = idByAsbToken.keys().next().value;
    if (oldest !== undefined) idByAsbToken.delete(oldest);
  }
  if (!firstSeenAtById.has(id)) firstSeenAtById.set(id, Date.now());
}

function recordMediaPrompt(id, prompt) {
  promptById.set(id, prompt);
  if (promptById.size > MAX_TRACKED_MEDIA) {
    const oldest = promptById.keys().next().value;
    if (oldest !== undefined) promptById.delete(oldest);
  }
}

async function waitUploadNetworkDone(sinceMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastUploadDoneAt >= sinceMs) return true;
    await sleep(200);
  }
  return false;
}

function sortByDomOrder(items) {
  return [...items].sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function extractFallbackId(src) {
  const match = /\/(?:image|video)\/([0-9a-fA-F-]{8,})/.exec(src)?.[1];
  return match || (/[?&]name=([^&]+)/.exec(src)?.[1] ?? src);
}

function resolveTileMediaId(el, src) {
  const asb = extractAsbFromUrl(src);
  return (
    el.closest("[data-media-id]")?.getAttribute("data-media-id") ||
    extractMediaIdFromContentUrl(src) ||
    (asb && idByAsbToken.get(asb)) ||
    extractFallbackId(src)
  );
}

const pendingVideoGraceMap = new Map();

function stripMediaUrlType(src, base = location.href) {
  try {
    const u = new URL(src, base);
    if (u.searchParams.has("mediaUrlType")) {
      u.searchParams.delete("mediaUrlType");
      return u.href;
    }
    return src;
  } catch {
    return src;
  }
}

function inferMediaKind(src, el) {
  if (/\/video\//.test(src)) return "video";
  if (/\/image\//.test(src)) return "image";
  return el.tagName === "VIDEO" ? "video" : "image";
}

function scanAllMediaIds() {
  const selectors = getSelectors();
  const ids = new Set();
  for (const key of ["resultVideo", "resultImage"]) {
    for (const strat of selectors[key] ?? []) {
      for (const el of queryStrategy(strat)) {
        const src = el.currentSrc || el.src;
        if (src) ids.add(resolveTileMediaId(el, src));
      }
    }
  }
  return [...ids];
}

function scanVisibleMediaTiles() {
  const selectors = getSelectors();
  const list = [];
  const seen = new Set();
  for (const key of ["resultVideo", "resultImage"]) {
    for (const strat of selectors[key] ?? []) {
      for (const el of queryStrategy(strat)) {
        const src = el.currentSrc || el.src;
        if (!src) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const id = resolveTileMediaId(el, src);
        if (!seen.has(id)) {
          seen.add(id);
          list.push({ id, el });
        }
      }
    }
  }
  return sortByDomOrder(list);
}

function scrollResultsToTop() {
  let el = scanResultTiles()[0]?.el ?? null;
  while (el && el.scrollHeight <= el.clientHeight + 10) {
    el = el.parentElement;
  }
  if (el) el.scrollTop = 0;
}

function isResultsScrolledToTop() {
  let el = scanVisibleMediaTiles()[0]?.el ?? null;
  while (el && el.scrollHeight <= el.clientHeight + 10) {
    el = el.parentElement;
  }
  return !el || el.scrollTop < 40;
}

export function scanResultTiles() {
  const selectors = getSelectors();
  const items = [];
  for (const key of ["resultVideo", "resultImage"]) {
    for (const strat of selectors[key] ?? []) {
      for (const node of queryStrategy(strat)) {
        const rawSrc = node.currentSrc || node.src;
        const cleanSrc = rawSrc && stripMediaUrlType(rawSrc);
        const el = node.tagName === "SOURCE" ? (node.parentElement ?? node) : node;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1 || !cleanSrc) continue;

        const id = resolveTileMediaId(el, cleanSrc);
        const isAsbVideo =
          extractAsbFromUrl(cleanSrc) && (el.tagName === "VIDEO" || !!el.closest("flow-video-tile"));
        const streamUrl =
          el.tagName === "VIDEO" || cleanSrc.includes("=") ? cleanSrc : `${cleanSrc}=mm,22,15`;
        const resolvedVideoUrl = videoUrlById.get(id) ?? (isAsbVideo ? streamUrl : undefined);
        const isVideo = !!resolvedVideoUrl || !!el.closest("flow-video-tile");

        if (isVideo && !resolvedVideoUrl) continue;
        if (!resolvedVideoUrl) {
          const firstSeen = pendingVideoGraceMap.get(id);
          if (firstSeen === undefined) {
            pendingVideoGraceMap.set(id, Date.now());
            continue;
          }
          if (Date.now() - firstSeen < getTunable("videoGraceMs", 4000)) continue;
        }
        items.push({
          el,
          kind: isVideo ? "video" : inferMediaKind(cleanSrc, el),
          src: resolvedVideoUrl ?? cleanSrc,
          id
        });
      }
    }
  }
  const seen = new Set();
  const unique = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  return sortByDomOrder(unique);
}

// Toast Snapshots & Detectors
let baselineModerationEl = null;
let baselineModerationText = "";
const readToastText = (el) => (el.textContent ?? "").trim().slice(0, 300);

function snapshotModerationToast() {
  const found = resolveSelector("moderationToast");
  baselineModerationEl = found ? found.el : null;
  baselineModerationText = found ? readToastText(found.el) : "";
}

function checkModerationToast() {
  const found = resolveSelector("moderationToast");
  if (!found) return { blocked: false };
  const txt = readToastText(found.el);
  if (found.el === baselineModerationEl && txt === baselineModerationText) return { blocked: false };
  if (/polic|moderat|blocked|violat|unable|can.?t generate|not allowed|try (something|a different)/i.test(txt)) {
    return { blocked: true, message: txt };
  }
  return { blocked: false };
}

const USAGE_LIMIT_RE = /usage limit|daily limit|reached your/i;
let baselineUsageLimitEl = null;
let baselineUsageLimitText = "";
const isErrorTile = (el) => !!el.closest("flow-error-tile, .error-tile");

function queryUsageLimitElements() {
  for (const strat of getSelectors().usageLimitToast ?? []) {
    const matches = queryStrategy(strat).filter((el) => USAGE_LIMIT_RE.test(readToastText(el)));
    if (matches.length > 0) return matches;
  }
  return [];
}

function snapshotUsageLimitToast() {
  baselineUsageLimitEl = queryUsageLimitElements().find((el) => !isErrorTile(el)) ?? null;
  baselineUsageLimitText = baselineUsageLimitEl ? readToastText(baselineUsageLimitEl) : "";
}

function checkUsageLimitToast() {
  const el = queryUsageLimitElements().find((node) => !isErrorTile(node)) ?? null;
  if (!el) return { hit: false };
  const txt = readToastText(el);
  if (el === baselineUsageLimitEl && txt === baselineUsageLimitText) return { hit: false };
  return { hit: true, message: txt };
}

function queryUsageLimitTilesAbove(wallEl) {
  const tiles = queryUsageLimitElements().filter(isErrorTile);
  return wallEl
    ? tiles.filter((t) => t.compareDocumentPosition(wallEl) & Node.DOCUMENT_POSITION_FOLLOWING)
    : tiles;
}

function snapshotQuotaTilesAtHead() {
  const head = scanVisibleMediaTiles()[0];
  return { wallId: head?.id, count: queryUsageLimitTilesAbove(head?.el ?? null).length };
}

function checkNewQuotaTiles(snapshot) {
  const wallEl = snapshot.wallId
    ? (scanVisibleMediaTiles().find((t) => t.id === snapshot.wallId)?.el ?? null)
    : null;
  if (snapshot.wallId && !wallEl && !isResultsScrolledToTop()) return { count: 0 };
  const tiles = queryUsageLimitTilesAbove(wallEl);
  return {
    count: Math.max(0, tiles.length - snapshot.count),
    message: tiles[0] ? readToastText(tiles[0]) : undefined
  };
}

let baselineUnusualEl = null;
let baselineUnusualText = "";

function snapshotUnusualActivityToast() {
  const found = resolveSelector("unusualActivityToast");
  baselineUnusualEl = found ? found.el : null;
  baselineUnusualText = found ? readToastText(found.el) : "";
}

function checkUnusualActivityToast() {
  const found = resolveSelector("unusualActivityToast");
  if (!found) return { blocked: false };
  const txt = readToastText(found.el);
  if (found.el === baselineUnusualEl && txt === baselineUnusualText) return { blocked: false };
  if (/usage limit|daily limit/i.test(txt)) return { blocked: false };
  if (/unusual|suspicious|automated|rate limit|try again later|unusual traffic/i.test(txt)) {
    return { blocked: true, message: txt };
  }
  return { blocked: false };
}

let baselineUploadErrEl = null;
let baselineUploadErrText = "";

function snapshotUploadErrorToast() {
  const found = resolveSelector("uploadErrorToast");
  baselineUploadErrEl = found ? found.el : null;
  baselineUploadErrText = found ? readToastText(found.el).slice(0, 200) : "";
}

function checkUploadErrorToast() {
  const found = resolveSelector("uploadErrorToast");
  if (!found) return null;
  const txt = readToastText(found.el).slice(0, 200);
  if (found.el === baselineUploadErrEl && txt === baselineUploadErrText) return null;
  return txt || "upload failed";
}

// Uploaded Asset Tile Filter (~12 hex hash suffix)
const UPLOADED_HASH_RE = /~[0-9a-f]{12}(\.[a-z0-9]+)?$/i;
const isUploadedReferenceTile = (item) =>
  UPLOADED_HASH_RE.test(
    item.el.closest?.("flow-grid-tile-container")?.getAttribute("aria-label")?.trim() ?? ""
  );

const normalizePrompt = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

function matchMembersByPrompt(members, rpcPrompt) {
  const target = normalizePrompt(rpcPrompt);
  const memberPrompts = members.map((m) => normalizePrompt(m.job.prompt ?? ""));
  const exact = memberPrompts.flatMap((p, idx) => (p === target ? [idx] : []));
  if (exact.length > 0 || target.length < 20) return exact;
  return memberPrompts.flatMap((p, idx) => (p.startsWith(target) ? [idx] : []));
}

function collectGroupResults(opts) {
  const { members, baselineIds, timeoutMs, onJobDone, onJobFailed } = opts;
  const completed = members.map(() => false);
  const collectedUrls = members.map(() => []);
  const openIndices = () => members.flatMap((_, idx) => (completed[idx] ? [] : [idx]));
  const firstOpenIdx = () => openIndices()[0];
  const needsMore = (idx) => !completed[idx] && collectedUrls[idx].length < members[idx].expectedCount;

  const failMember = (idx, reason, retryable) => {
    completed[idx] = true;
    onJobFailed(members[idx].job, reason, retryable);
  };
  const failAllOpen = (reason, retryable) => {
    for (const idx of openIndices()) failMember(idx, reason, retryable);
  };
  const totalNeeded = () =>
    openIndices().reduce((sum, idx) => sum + members[idx].expectedCount - collectedUrls[idx].length, 0);

  let consumedQuotaTiles = 0;
  let totalCollectedCount = 0;
  const knownIds = new Set(baselineIds);
  const startedEmpty = knownIds.size === 0;
  const claimedIds = new Set();

  return new Promise((resolve) => {
    const startMs = Date.now();
    let done = false;
    let tickCount = 0;
    let lastProgressMs = Date.now();
    const videoPromptWaitMap = new Map();
    const isMultiMember = members.length > 1;
    let lastEditorCloseMs = 0;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poller);
      resolve();
    };

    const exitAccidentalClipEditor = () => {
      if (!isClipEditorUrl(location.href)) return;
      const now = Date.now();
      if (now - lastEditorCloseMs < 3000) return;
      lastEditorCloseMs = now;
      const doneBtn = resolveSelector("clipEditorDone");
      if (doneBtn) {
        genLog.warn("clip editor opened mid-run — clicking Done so results remain visible");
        doneBtn.el.click();
      }
    };

    const initialProjectPath = location.href.match(/\/project\/[^/?#]+/)?.[0];

    const poller = setInterval(() => {
      tickCount++;
      const currentProjectPath = location.href.match(/\/project\/[^/?#]+/)?.[0];
      if (initialProjectPath && currentProjectPath && currentProjectPath !== initialProjectPath) {
        failAllOpen("the Flow project changed mid-job", true);
        return finish();
      }
      if (opts.aborted?.()) {
        failAllOpen("stopped", false);
        return finish();
      }

      exitAccidentalClipEditor();

      const unusual = checkUnusualActivityToast();
      if (unusual.blocked && firstOpenIdx() !== undefined) {
        failMember(firstOpenIdx(), unusual.message ?? "unusual activity detected", true);
        snapshotUnusualActivityToast();
      }

      const usageHit = checkUsageLimitToast();
      if (usageHit.hit && firstOpenIdx() !== undefined) {
        failMember(firstOpenIdx(), usageHit.message ?? "usage limit reached", true);
        snapshotUsageLimitToast();
      }

      if (opts.limitTiles) {
        const quotaInfo = checkNewQuotaTiles(opts.limitTiles);
        for (
          let lastIdx = openIndices().pop();
          lastIdx !== undefined && !(quotaInfo.count - consumedQuotaTiles < members[lastIdx].expectedCount);
          lastIdx = openIndices().pop()
        ) {
          consumedQuotaTiles += members[lastIdx].expectedCount;
          failMember(lastIdx, quotaInfo.message ?? "usage limit reached", true);
        }
      }

      const mod = checkModerationToast();
      if (mod.blocked && firstOpenIdx() !== undefined) {
        failMember(firstOpenIdx(), mod.message ?? "content blocked by policy", false);
        snapshotModerationToast();
      }

      if (totalNeeded() > 0 && firstOpenIdx() !== undefined) {
        const targetKind = members[firstOpenIdx()].kind;
        const rendered = scanResultTiles();
        const freshHead = [];
        let cursor = 0;

        for (; cursor < rendered.length; cursor++) {
          const tile = rendered[cursor];
          if (claimedIds.has(tile.id)) continue;
          if (knownIds.has(tile.id)) break;
          if (isUploadedReferenceTile(tile)) continue;
          const seenAt = firstSeenAtById.get(tile.id);
          if (seenAt !== undefined && seenAt < (opts.since ?? startMs)) {
            knownIds.add(tile.id);
            continue;
          }
          if (!(startedEmpty && seenAt === undefined) && tile.kind === targetKind) {
            freshHead.push(tile);
          }
        }

        const belowCursor = rendered
          .slice(cursor)
          .filter((t) => !knownIds.has(t.id) && !claimedIds.has(t.id) && !isUploadedReferenceTile(t));
        const reclaimed = belowCursor.filter((t) => {
          const seenAt = firstSeenAtById.get(t.id);
          return seenAt !== undefined && seenAt >= (opts.since ?? startMs) && t.kind === targetKind;
        });
        if (reclaimed.length > 0) freshHead.push(...reclaimed);
        for (const old of belowCursor.filter((t) => !reclaimed.includes(t))) {
          knownIds.add(old.id);
        }

        const remainingByMember = members.map((m, idx) =>
          needsMore(idx) ? m.expectedCount - collectedUrls[idx].length : 0
        );
        const matchedByPrompt = [];
        const unmatched = [];

        for (const tile of freshHead) {
          if (matchedByPrompt.length + unmatched.length >= totalNeeded()) break;
          const rpcPrompt = promptById.get(tile.id);
          if (rpcPrompt === undefined && tile.kind === "video" && isMultiMember) {
            const firstWait = videoPromptWaitMap.get(tile.id) ?? Date.now();
            videoPromptWaitMap.set(tile.id, firstWait);
            if (Date.now() - firstWait < 6000) continue;
          }
          const candidateIndices = rpcPrompt === undefined ? [] : matchMembersByPrompt(members, rpcPrompt);
          const chosenIdx = candidateIndices.find((idx) => remainingByMember[idx] > 0);
          if (chosenIdx !== undefined) {
            remainingByMember[chosenIdx]--;
            matchedByPrompt.push([tile, chosenIdx]);
          } else if (candidateIndices.length > 0) {
            knownIds.add(tile.id);
          } else {
            unmatched.push(tile);
          }
        }

        const assignTile = (tile, memberIdx) => {
          claimedIds.add(tile.id);
          collectedUrls[memberIdx].push(new URL(tile.src, location.href).href);
          totalCollectedCount++;
        };

        for (const [tile, idx] of matchedByPrompt.reverse()) assignTile(tile, idx);
        for (const tile of unmatched.reverse()) {
          const idx = openIndices().find(needsMore);
          if (idx !== undefined) assignTile(tile, idx);
        }

        if (matchedByPrompt.length + unmatched.length > 0) {
          lastProgressMs = Date.now();
        }
      }

      for (const idx of openIndices()) {
        if (collectedUrls[idx].length >= members[idx].expectedCount) {
          completed[idx] = true;
          onJobDone(members[idx].job, collectedUrls[idx]);
        }
      }

      if (openIndices().length === 0) return finish();
      if (Date.now() - startMs > timeoutMs) {
        failAllOpen("generation timed out", true);
        return finish();
      }
      const stallMs = getTunable("stallMs", 120000);
      if (totalCollectedCount > 0 && Date.now() - lastProgressMs > stallMs) {
        failAllOpen("result never appeared for this prompt", true);
        return finish();
      }
    }, 500);
  });
}

// Healthcheck & Diagnostics
export function runSelectorHealthcheck() {
  const selectors = getSelectors();
  return Object.entries(selectors).map(([key, strategies]) => {
    for (let i = 0; i < strategies.length; i++) {
      const strat = strategies[i];
      const matches = queryStrategy(strat);
      if (matches.length > 0) {
        const snippet = matches[0].outerHTML.slice(0, 120).replace(/\s+/g, " ");
        return {
          key,
          matched: true,
          strategy: `${strat.kind}#${i} (${matches.length} match${matches.length > 1 ? "es" : ""})`,
          snippet
        };
      }
    }
    return { key, matched: false };
  });
}

export function collectPageDiagnostics() {
  const count = (sel) => document.querySelectorAll(sel).length;
  return {
    url: location.href,
    readyState: document.readyState,
    counts: {
      textarea: count("textarea"),
      contenteditable: count('[contenteditable="true"]'),
      fileInput: count('input[type="file"]'),
      button: count("button"),
      video: count("video"),
      img: count("img"),
      dialog: count('[role="dialog"]')
    }
  };
}

class AutomationError extends Error {
  constructor(message, retryable = true, haltQueue = false) {
    super(message);
    this.retryable = retryable;
    this.haltQueue = haltQueue;
  }
}

class DuplicateCharacterError extends Error {}

function reportStage(jobId, stage, message) {
  chrome.runtime.sendMessage({ t: "job.progress", jobId, stage, message }).catch(() => {});
}

async function dataUrlToFile(imgObj) {
  const blob = await (await fetch(imgObj.dataUrl)).blob();
  return new File([blob], imgObj.name, { type: imgObj.mime });
}

async function clickSelectorIfPresent(key) {
  const found = await waitForSelector(key, { timeoutMs: 3000, required: false });
  if (!found) {
    autoLog.warn(`option not found: ${key} — keeping page default`);
    return false;
  }
  await clickSynthetic(found.el);
  return true;
}

const MODEL_SELECTOR_MAP = {
  "nano-banana-pro": "modelOption_nanoBananaPro",
  "nano-banana-2": "modelOption_nanoBanana2",
  "nano-banana-2-lite": "modelOption_nanoBanana2Lite",
  "omni-flash": "modelOption_omniFlash",
  "veo-3.1-lite": "modelOption_veo31Lite",
  "veo-3.1-fast": "modelOption_veo31Fast",
  "veo-3.1-quality": "modelOption_veo31Quality"
};

const IMAGE_MODEL_LABELS = {
  "nano-banana-pro": "nano banana pro",
  "nano-banana-2": "nano banana 2",
  "nano-banana-2-lite": "nano banana 2 lite"
};

const VIDEO_SUBTAB_MAP = {
  "flow-text-to-video": "tabIngredients",
  "flow-frame-to-video": "tabFrames",
  "flow-ingredients-to-video": "tabIngredients",
  "flow-video-to-video": "tabIngredients"
};

const VALID_DURATIONS = new Set(["4s", "6s", "8s", "10s"]);
const VEO_FIXED_DURATION = "8s";
const isVeoModel = (m) => !!m?.startsWith("veo-");
const VALID_VIDEO_RATIOS = new Set(["16:9", "9:16"]);
const RATIO_PILL_LABELS = {
  "16:9": "16_9",
  "9:16": "9_16",
  "1:1": "square",
  "4:3": "landscape",
  "3:4": "portrait"
};

function parseSettingsPillText(text) {
  const [left = "", right = ""] = text.toLowerCase().split("crop_");
  const [ratioPart = "", countPart = ""] = right.split("x");
  const model = left
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(\d+) \d+\b/, "$1");
  return {
    model,
    ratio: ratioPart.trim(),
    count: countPart.trim(),
    video: model.startsWith("video"),
    duration: /\d+\s*s\b/.exec(left)?.[0].replace(/\s+/g, "") ?? "",
    resolution: /\b(360p|720p)\b/.exec(left)?.[1] ?? ""
  };
}

function getExpectedOutputs(job) {
  return Math.max(1, Math.min(4, job.params.outputsPerPrompt ?? 1));
}

async function ensureSettingsPanelOpen() {
  if (resolveSelector("settingsPanelOpen")) return true;
  const pill = await waitForSelector("settingsPill", { timeoutMs: 3000, required: false });
  if (!pill) return false;
  await clickSynthetic(pill.el);
  await jitterSleep(300, 500);
  return !!(await waitForSelector("settingsPanelOpen", { timeoutMs: 3000, required: false }));
}

async function applyFlowSettings(job) {
  const params = job.params;
  const isVideo = isVideoGenerationMode(job.mode);
  const count = getExpectedOutputs(job);
  const ratio = isVideo && !VALID_VIDEO_RATIOS.has(params.aspectRatio) ? undefined : params.aspectRatio;
  const veo = isVeoModel(params.imageModel);
  const duration = isVideo && !veo ? params.videoOption : undefined;
  const resolution =
    isVideo && !veo && params.videoResolution === "720p"
      ? "720p"
      : isVideo && !veo && params.videoResolution === "480p"
        ? "360p"
        : undefined;

  const desired = {
    model: !isVideo && params.imageModel ? IMAGE_MODEL_LABELS[params.imageModel] : undefined,
    ratio: ratio ? RATIO_PILL_LABELS[ratio] : undefined,
    count: String(count),
    duration: duration && VALID_DURATIONS.has(duration) ? duration : undefined,
    resolution
  };

  const pill = await waitForSelector("settingsPill", { timeoutMs: 4000, required: false });
  if (pill) {
    const current = parseSettingsPillText(pill.el.textContent ?? "");
    if (
      (!isVideo || (!params.imageModel && job.mode === "flow-text-to-video")) &&
      current.video === isVideo &&
      (!desired.model || current.model === desired.model) &&
      (!desired.ratio || current.ratio === desired.ratio) &&
      (!desired.duration || current.duration === desired.duration) &&
      (!desired.resolution || current.resolution === desired.resolution) &&
      current.count === desired.count
    ) {
      autoLog.info(`settings already match (${current.model} / ${current.ratio} / x${current.count})`);
      return;
    }
  }

  if (await ensureSettingsPanelOpen()) {
    reportStage(job.id, "applying-mode", job.mode);
    await clickSelectorIfPresent(isVideo ? "tabVideo" : "tabImage");
    await jitterSleep(300, 500);
  }

  const subTab = VIDEO_SUBTAB_MAP[job.mode];
  if (subTab && (await ensureSettingsPanelOpen())) {
    await clickSelectorIfPresent(subTab);
    await jitterSleep(300, 500);
  }

  if (params.imageModel && MODEL_SELECTOR_MAP[params.imageModel] && (await ensureSettingsPanelOpen())) {
    reportStage(job.id, "applying-settings", `model: ${params.imageModel}`);
    const modelPill = await waitForSelector("modelPill", { timeoutMs: 3000, required: false });
    if (modelPill) {
      await clickSynthetic(modelPill.el);
      await jitterSleep(200, 400);
    }
    await clickSelectorIfPresent(MODEL_SELECTOR_MAP[params.imageModel]);
    await jitterSleep(200, 400);
  }

  if (desired.duration && (await ensureSettingsPanelOpen())) {
    reportStage(job.id, "applying-settings", `duration: ${desired.duration}`);
    await clickSelectorIfPresent(`durationChip_${desired.duration}`);
    await jitterSleep(200, 400);
  }

  if (desired.resolution && (await ensureSettingsPanelOpen())) {
    reportStage(job.id, "applying-settings", `resolution: ${desired.resolution}`);
    await clickSelectorIfPresent(`resolutionChip_${desired.resolution}`);
    await jitterSleep(200, 400);
  }

  if (ratio && (await ensureSettingsPanelOpen())) {
    reportStage(job.id, "applying-settings", `aspect: ${ratio}`);
    await clickSelectorIfPresent(`aspectOption_${ratio.replace(":", "_")}`);
    await jitterSleep(200, 400);
  }

  if (await ensureSettingsPanelOpen()) {
    reportStage(job.id, "applying-settings", `outputs: x${count}`);
    await clickSelectorIfPresent(`outputCountChip_${count}`);
    await jitterSleep(200, 400);
  }

  for (let i = 1; i <= 3 && resolveSelector("settingsPanelOpen"); i++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await jitterSleep(300, 500);
    if (resolveSelector("settingsPanelOpen") && i === 2) {
      const p = resolveSelector("settingsPill");
      if (p) await clickSynthetic(p.el);
      await jitterSleep(300, 500);
    }
  }
  await jitterSleep(200, 400);
}

async function waitForEnabledSubmit(timeoutMs = 20000, composerEl) {
  await sleep(getTunable("submitSettleMs", 3000));
  if (composerEl) await nudgePointer(composerEl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sub = resolveSelector("submitButton");
    if (sub && !isDisabled(sub.el)) {
      const rect = sub.el.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) return sub;
    }
    await sleep(250);
  }
  return null;
}

// Queue Pause / Cancel State
let groupAborted = false;
let groupPaused = false;
const cancelledJobIds = new Set();

function checkAborted() {
  if (groupAborted) throw new AutomationError("stopped", false);
}

function checkUploadToastError() {
  const err = checkUploadErrorToast();
  if (err) throw new AutomationError(`Flow could not load the uploaded file: "${err}"`, true);
}

async function closeAnyOverlays() {
  const hasOverlay = () =>
    !!document.querySelector(".cdk-overlay-backdrop, flow-mobile-long-press-menu .backdrop") ||
    !!resolveSelector("assetSearchInput");
  for (let i = 0; i < 4 && hasOverlay(); i++) {
    document.activeElement?.blur?.();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
    );
    await jitterSleep(250, 400);
    const backdrop = document.querySelector(".cdk-overlay-backdrop, flow-mobile-long-press-menu .backdrop");
    if (backdrop) {
      backdrop.click();
      await jitterSleep(250, 400);
    }
  }
}

// Reference & Upload Management
const countAttachedChips = () =>
  document.querySelector("flow-prompt-box")
    ? document.querySelectorAll("flow-ingredient-bar .ingredient-bar-container > *").length
    : queryStrategy({ kind: "text", text: "^cancel", role: "button" }, document).length;

const getDialogRoot = (el) => el.closest('[role="dialog"], .cdk-overlay-pane') ?? document.body;
const getListboxContainer = (el) =>
  el.querySelector('[role="listbox"]') ??
  el.querySelector('[data-testid="virtuoso-item-list"]') ??
  el;

const readAssetOptionLabels = (el) => {
  const opts = getListboxContainer(getDialogRoot(el)).querySelectorAll('button[role="option"]');
  return new Set([...opts].map((o) => (o.textContent ?? "").trim()).filter(Boolean));
};

async function openAssetPicker(triggerKey = "attachButton") {
  const existing = resolveSelector("assetSearchInput");
  if (existing) return existing.el;
  const trigger = await waitForSelector(triggerKey, { timeoutMs: 5000, required: false });
  if (!trigger) throw new AutomationError(`could not find Flow's ${triggerKey} to open the asset panel`, true);
  await clickSynthetic(trigger.el);
  await jitterSleep(700, 1100);
  const searchInput = await waitForSelector("assetSearchInput", { timeoutMs: 5000, required: false });
  if (!searchInput) throw new AutomationError("the + button did not open Flow's asset panel", true);
  return searchInput.el;
}

function armMainWorldUpload(arm) {
  window.postMessage({ __mflowUpload: arm ? "arm" : "disarm" }, location.origin);
}

let uploadCounter = 0;

async function uploadFilesToPicker(pickerEl, files) {
  uploadCounter += files.length;
  snapshotUploadErrorToast();
  const dialog = getDialogRoot(pickerEl);
  let fileInput =
    queryStrategy({ kind: "css", css: 'input[type="file"]', hidden: true }, dialog)[0] ??
    resolveSelector("fileInput")?.el;

  if (!fileInput) {
    armMainWorldUpload(true);
    try {
      const uploadBtn = resolveSelector("uploadMediaButton", dialog) ?? resolveSelector("uploadMediaButton");
      if (!uploadBtn?.el) {
        throw new AutomationError("the asset panel has no Upload media button", false);
      }
      await nudgePointer(uploadBtn.el);
      await jitterSleep(200, 400);
      await clickTrusted(uploadBtn.el);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !fileInput) {
        fileInput = resolveSelector("parkedFileInput")?.el;
        if (!fileInput) await sleep(150);
      }
    } finally {
      armMainWorldUpload(false);
    }

    if (!fileInput) {
      await populateFileInput(null, files, dialog);
      await sleep(2500 + 700 * files.length);
      return;
    }
  }

  await populateFileInput(fileInput, files, dialog);
  fileInput.removeAttribute("data-mflow-parked");
  await sleep(1500 + 500 * files.length);
}

// Per-Project SHA-256 Deduplication Cache
const projectUploadsCache = new Map();
let cachedProjectId = "";

async function computeImageHash(imgObj) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imgObj.dataUrl));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildHashedFilename(name, hash) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}~${hash}${name.slice(dot)}` : `${name}~${hash}`;
}

async function syncProjectUploadsCache() {
  const pid = PROJECT_PATH_RE.exec(location.pathname)?.[1] ?? "";
  if (pid !== cachedProjectId) {
    projectUploadsCache.clear();
    cachedProjectId = pid;
    if (pid) {
      try {
        const key = `mflow:uploads:${pid}`;
        const stored = await chrome.storage.local.get(key);
        for (const [k, v] of Object.entries(stored[key] ?? {})) {
          projectUploadsCache.set(k, v);
        }
      } catch {}
    }
  }
}

async function saveProjectUploadEntry(hash, label) {
  projectUploadsCache.set(hash, label.replace(/(Image|Video)$/, "").trim());
  if (!cachedProjectId) return;
  try {
    const key = `mflow:uploads:${cachedProjectId}`;
    const entries = [...projectUploadsCache].slice(-500);
    await chrome.storage.local.set({ [key]: Object.fromEntries(entries) });
  } catch {}
}

function matchesUploadedRowLabel(rowText, fileName) {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const re = new RegExp(`^(image|videocam|movie)?${escapeRegex(base)}( \\(\\d+\\))?${escapeRegex(ext)}(Image|Video)?$`);
  return re.test(rowText.trim());
}

async function preloadGroupImages(images) {
  await syncProjectUploadsCache();
  const toUpload = new Map();
  for (const img of images) {
    const hash = await computeImageHash(img);
    if (!projectUploadsCache.has(hash) && !toUpload.has(hash)) {
      toUpload.set(hash, img);
    }
  }
  if (toUpload.size === 0) return;

  autoLog.info(`preloading ${toUpload.size} unique reference image(s) for batch`);
  const pickerEl = await openAssetPicker();
  const baselineLabels = readAssetOptionLabels(pickerEl);
  const files = await Promise.all(
    [...toUpload].map(([hash, img]) => dataUrlToFile({ ...img, name: buildHashedFilename(img.name, hash) }))
  );
  await uploadFilesToPicker(pickerEl, files);

  const uploaded = new Set();
  const start = Date.now();
  const deadline = start + 90000;
  while (Date.now() < deadline && uploaded.size < toUpload.size) {
    const currentPicker = await openAssetPicker().catch(() => pickerEl);
    const newLabels = [...readAssetOptionLabels(currentPicker)].filter((l) => !baselineLabels.has(l));
    if (newLabels.length === 0 && Date.now() - start > 20000) break;
    for (const [hash, img] of toUpload) {
      if (uploaded.has(hash)) continue;
      const hashedName = buildHashedFilename(img.name, hash);
      const matchedLabel = newLabels.find((l) => matchesUploadedRowLabel(l, hashedName));
      if (matchedLabel) {
        uploaded.add(hash);
        const base = stripExt(hashedName);
        await saveProjectUploadEntry(hash, matchedLabel.slice(Math.max(0, matchedLabel.indexOf(base))));
      }
    }
    if (uploaded.size < toUpload.size) await sleep(800);
  }
  await closeAnyOverlays();
}

async function clearLeftoverPromptReferences() {
  for (let i = 0; i < 12; i++) {
    const chip = resolveSelector("promptReferenceRemove");
    if (!chip) break;
    await clickSynthetic(chip.el);
    await jitterSleep(200, 400);
  }
}

async function attachAssetByName(name, timeoutMs = 10000, triggerKey = "attachButton", suffixFilter) {
  const beforeCount = countAttachedChips();
  const isAttached = () => countAttachedChips() > beforeCount;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const searchEl = await openAssetPicker(triggerKey);
    await typeText(searchEl, name);
    await jitterSleep(900, 1400);

    const listRoot = getListboxContainer(getDialogRoot(searchEl));
    const options = [...listRoot.querySelectorAll('button[role="option"]')];
    const match = options.find((btn) => {
      const txt = (btn.textContent ?? "").trim();
      if (suffixFilter && !txt.endsWith(suffixFilter)) return false;
      return txt.toLowerCase().includes(name.toLowerCase());
    });

    if (!match) return false;
    await clickSynthetic(match);
    await jitterSleep(700, 1100);

    if (!isAttached()) {
      const addBtn = await waitForSelector("addToPromptButton", { timeoutMs: 3000, required: false });
      if (addBtn) {
        await clickTrusted(addBtn.el);
        await jitterSleep(500, 900);
      }
    }
    for (let i = 0; i < 20 && !isAttached(); i++) await sleep(250);
    if (isAttached()) return true;
  }
  return false;
}

async function attachJobReferences(job, images) {
  const maxRefs = getMaxReferences(job.mode, job.params.imageModel);
  const uploads = images.slice(0, maxRefs);
  const existingRefs = (job.assetRefs ?? []).slice(0, maxRefs - uploads.length);

  if (uploads.length === 0 && existingRefs.length === 0) return;

  await syncProjectUploadsCache();
  const uncached = [];
  for (const img of uploads) {
    const hash = await computeImageHash(img);
    const cachedLabel = projectUploadsCache.get(hash);
    if (cachedLabel && (await attachAssetByName(cachedLabel, 10000))) {
      continue;
    }
    uncached.push({ img, hash, upName: buildHashedFilename(img.name, hash) });
  }

  if (uncached.length > 0) {
    const pickerEl = await openAssetPicker();
    await uploadFilesToPicker(
      pickerEl,
      await Promise.all(uncached.map(({ img, upName }) => dataUrlToFile({ ...img, name: upName })))
    );
    for (const { hash, upName } of uncached) {
      const base = stripExt(upName);
      if (await attachAssetByName(base, 30000)) {
        await saveProjectUploadEntry(hash, base);
      }
    }
  }

  for (const refName of existingRefs) {
    if (!(await attachAssetByName(refName, 10000))) {
      throw new AutomationError(`no Flow asset matches "${refName}"`, false);
    }
  }

  for (const charName of job.characterRefs ?? []) {
    if (!(await attachAssetByName(charName, 10000, "attachButton", "Character"))) {
      throw new AutomationError(`no Flow character matches "${charName}"`, false);
    }
  }

  await closeAnyOverlays();
}

// Upscale & Direct Download Handlers
const UPSCALE_CONFIG = {
  image: { option: "qualityOption_2k", label: "2K", fallback: "1K" },
  video: { option: "qualityOption_1080p", label: "1080p", fallback: "720p" }
};

let upscaleChain = Promise.resolve();

function requestUpscaledDownload(job, mediaUrl, kind) {
  const next = upscaleChain.then(() => performUpscaleDownload(job, mediaUrl, kind));
  upscaleChain = next.catch(() => {});
  return next;
}

function isNarrowMobileLayout() {
  return !!document.querySelector(".header-mobile, .header-container-mobile, flow-mobile-add-menu, .is-mobile");
}

async function performUpscaleDownload(job, mediaUrl, kind) {
  const { option, label } = UPSCALE_CONFIG[kind];
  const isNarrow = () => isNarrowMobileLayout() || !!document.querySelector("flow-project-page.mobile");

  if (isNarrow()) {
    const closedRes = await chrome.runtime.sendMessage({ t: "panel.closeForUpscale" }).catch(() => null);
    if (closedRes?.closed) {
      for (let i = 0; i < 20 && isNarrow(); i++) await sleep(250);
    }
    if (isNarrow()) {
      throw new Error(`Flow window is too narrow for ${label}; maximize the window`);
    }
  }

  const findTile = () => scanResultTiles().find((t) => new URL(t.src, location.href).href === mediaUrl);
  if (!findTile()) throw new Error("media tile is no longer on the page");

  try {
    let qualityOption = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 3 && !qualityOption; attempt++) {
      if (attempt > 1) await closeAnyOverlays();
      const tile = findTile();
      if (!tile) {
        await sleep(1000);
        continue;
      }
      try {
        await clickTrusted(tile.el, "right");
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        continue;
      }
      await sleep(500);
      const downloadMenu = queryStrategy({ kind: "text", text: "download", role: "menuitem" }, document)[0];
      if (downloadMenu) {
        await nudgePointer(downloadMenu);
        qualityOption = await waitForSelector(option, { timeoutMs: 5000, required: false });
        if (!qualityOption && kind === "image") {
          await clickTrusted(downloadMenu).catch(() => {});
          qualityOption = await waitForSelector(option, { timeoutMs: 3000, required: false });
        }
      }
    }

    if (!qualityOption) throw new Error(lastErr || `tile menu never showed Download > ${label}`);
    if (qualityOption.el.getAttribute("aria-disabled") === "true") {
      throw new Error(`Flow has ${label} disabled for this account`);
    }

    const timeoutMs =
      kind === "video" ? getTunable("videoUpscaleTimeoutMs", 300000) : getTunable("upscaleTimeoutMs", 60000);
    const capturePromise = chrome.runtime.sendMessage({
      t: "download.captureFlow",
      jobId: job.id,
      kind,
      timeoutMs
    });

    await jitterSleep(250, 400);
    await clickTrusted(qualityOption.el).catch(() => {});
    const res = await capturePromise;
    if (!res?.ok || !res.path) throw new Error(res?.error ?? "Flow delivered no upscaled file");
    return res.path;
  } finally {
    await closeAnyOverlays();
  }
}

async function downloadJobOutputs(job, urls, kind = isVideoGenerationMode(job.mode) ? "video" : "image", allowUpscale = false) {
  const results = [];
  if (kind === "video" && urls.length > 0) {
    await sleep(getTunable("videoSettleMs", 8000));
  }

  const labelByUrl = new Map();
  for (const tile of scanResultTiles()) {
    const aria = tile.el.closest("flow-grid-tile-container")?.getAttribute("aria-label")?.trim();
    if (aria) labelByUrl.set(new URL(tile.src, location.href).href, aria);
  }

  const prefs = await chrome.storage.local.get(["mflow:image2k", "mflow:video1080p"]).catch(() => ({}));
  const shouldUpscale =
    allowUpscale &&
    (kind === "image"
      ? job.params.downloadImageQuality === "2k" || !!prefs["mflow:image2k"]
      : job.params.downloadVideoQuality === "1080p" || !!prefs["mflow:video1080p"]);

  const { label: hiLabel, fallback: loLabel } = UPSCALE_CONFIG[kind];

  for (let i = 0; i < urls.length; i++) {
    let warningNote;
    if (shouldUpscale) {
      try {
        const path = await requestUpscaledDownload(job, urls[i], kind);
        const tileLabel = labelByUrl.get(urls[i]);
        results.push({ path, kind, ...(tileLabel ? { label: tileLabel } : {}) });
        continue;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        autoLog.warn(`${hiLabel} upscale failed for output ${i + 1} (${msg}) — falling back to ${loLabel}`);
        warningNote = `${hiLabel} upscale failed (${msg}), saved at ${loLabel}`;
      }
    }

    try {
      const res = await chrome.runtime.sendMessage({
        t: "download.direct",
        jobId: job.id,
        url: urls[i],
        kind,
        index: i
      });
      const tileLabel = labelByUrl.get(urls[i]);
      if (res?.ok && res.path) {
        results.push({
          path: res.path,
          kind,
          ...(tileLabel ? { label: tileLabel } : {}),
          ...(warningNote ? { note: warningNote } : {})
        });
      }
    } catch (err) {
      autoLog.warn(`download error for output ${i}`, err);
    }
  }
  return results;
}

// Page Preparation & Project Creation
function isOnGalleryPage() {
  return !PROJECT_PATH_RE.test(location.href);
}

async function createNewProjectFromGallery() {
  const btn = await waitForSelector("newProjectButton", { timeoutMs: 8000, required: false });
  if (!btn) {
    throw new AutomationError("no Flow project open, and New project button not found on gallery", true);
  }
  autoLog.info("creating a new project from gallery");
  await clickSynthetic(btn.el);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!isOnGalleryPage() && (await waitForSelector("promptInput", { timeoutMs: 500, required: false }))) {
      return;
    }
    await sleep(400);
  }
  throw new AutomationError("clicked New project but composer never appeared", true);
}

async function ensureProjectReady(job) {
  if (job?.params.newProject && !isOnGalleryPage() && job.attempts === 0) {
    location.href = buildFlowRootUrl(location.href);
    throw new AutomationError("navigating to gallery for a new project — retrying", true);
  }
  if (isOnGalleryPage()) {
    await createNewProjectFromGallery();
  }
  if (resolveSelector("loginIndicator")) {
    throw new AutomationError("not logged in to Google on flow.google.com", false);
  }
  snapshotUnusualActivityToast();
  snapshotModerationToast();
  snapshotUsageLimitToast();
}

async function submitStandardPrompt(member) {
  const { job, images } = member;
  if (cancelledJobIds.has(job.id)) throw new AutomationError("cancelled", false);

  await ensureProjectReady(job);
  reportStage(job.id, "applying-settings");
  await applyFlowSettings(job);
  await clearLeftoverPromptReferences();

  const uploadsBefore = uploadCounter;
  const idsBeforeUpload = new Set(scanAllMediaIds());
  const totalRefs = images.length + (job.assetRefs?.length ?? 0) + (job.characterRefs?.length ?? 0);

  if (totalRefs > 0) {
    reportStage(job.id, "attaching-images", `${totalRefs} reference(s)`);
    await attachJobReferences(job, images);
  }

  reportStage(job.id, "entering-prompt");
  const composer = await waitForSelector("promptInput", { timeoutMs: 10000 });
  await typeText(composer.el, job.prompt);
  await jitterSleep(400, 800);

  const isVideo = isVideoGenerationMode(job.mode);
  const uploadedAssetIds =
    uploadCounter > uploadsBefore
      ? scanResultTiles()
          .filter((t) => !idsBeforeUpload.has(t.id))
          .filter((t) => !isVideo || (t.kind !== "video" && !videoUrlById.has(t.id)))
          .map((t) => t.id)
      : [];

  if (cancelledJobIds.has(job.id)) throw new AutomationError("cancelled", false);

  const submitBtn = await waitForEnabledSubmit(20000, composer.el);
  if (submitBtn) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await nudgePointer(submitBtn.el);
      await clickTrusted(submitBtn.el);
      const cleared = await (async () => {
        const end = Date.now() + 4000;
        while (Date.now() < end) {
          if (readInputValue(composer.el).trim() === "") return true;
          await sleep(200);
        }
        return readInputValue(composer.el).trim() === "";
      })();
      if (cleared || attempt === 3) break;
      await jitterSleep(600, 1000);
    }
  } else {
    await submitEnter(composer.el);
  }

  reportStage(job.id, "generating");
  return uploadedAssetIds;
}

function sendJobResultToBackground(jobId, ok, files, error, retryable = true, haltQueue = false) {
  chrome.runtime
    .sendMessage({
      t: "job.result",
      jobId,
      ok,
      files,
      error,
      retryable,
      haltQueue
    })
    .catch(() => {});
}

async function runSingleJobHandler(job, fn) {
  try {
    checkAborted();
    const files = await fn();
    sendJobResultToBackground(job.id, true, files);
  } catch (err) {
    if (err instanceof DuplicateCharacterError) {
      sendJobResultToBackground(job.id, true, []);
      return;
    }
    const retryable = err instanceof AutomationError ? err.retryable : true;
    const haltQueue = err instanceof AutomationError ? err.haltQueue : false;
    sendJobResultToBackground(
      job.id,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      retryable,
      haltQueue
    );
  } finally {
    await closeAnyOverlays();
  }
}

async function executeCharacterCreation(member) {
  const { job, images } = member;
  const charName = job.characterName?.trim() ?? "";
  if (!charName) throw new AutomationError("characterName is required", false);

  await ensureProjectReady(job);
  const searchEl = await openAssetPicker();
  await typeText(searchEl, charName);
  await jitterSleep(700, 1100);
  const listRoot = getListboxContainer(getDialogRoot(searchEl));
  const exists = [...listRoot.querySelectorAll('button[role="option"]')].some((btn) => {
    const txt = (btn.textContent ?? "").trim();
    return txt.endsWith("Character") && txt.toLowerCase().includes(charName.toLowerCase());
  });
  await closeAnyOverlays();
  if (exists) {
    autoLog.info(`character "${charName}" already exists in project — skipping`);
    throw new DuplicateCharacterError();
  }

  let pickerEl = await openAssetPicker();
  const createBtn = await waitForSelector("createCharacterButton", { timeoutMs: 5000, required: false });
  if (!createBtn) throw new AutomationError("Create Character button not found in asset panel", true);
  await clickTrusted(createBtn.el);
  await jitterSleep(600, 1000);

  const nameInput = await waitForSelector("characterNameInput", { timeoutMs: 8000, required: false });
  if (!nameInput) throw new AutomationError("character name input did not appear", true);
  await typeText(nameInput.el, charName);
  await jitterSleep(300, 500);

  if (job.prompt?.trim()) {
    const descInput = resolveSelector("characterDescInput");
    if (descInput) {
      await typeText(descInput.el, job.prompt.trim());
      await jitterSleep(300, 500);
    }
  }

  if (images.length > 0) {
    const file = await dataUrlToFile(images[0]);
    const dialog = getDialogRoot(nameInput.el);
    await uploadFilesToPicker(dialog, [file]);
  }

  const submitBtn = await waitForSelector("characterDialogSubmit", { timeoutMs: 10000, required: false });
  if (!submitBtn) throw new AutomationError("Create/Render character submit button not found", true);
  await clickTrusted(submitBtn.el);

  reportStage(job.id, "generating", `rendering character "${charName}"`);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    checkAborted();
    const saveBtn = resolveSelector("saveCharacterButton");
    if (saveBtn && !isDisabled(saveBtn.el)) {
      await clickTrusted(saveBtn.el);
      await jitterSleep(800, 1400);
      break;
    }
    if (!resolveSelector("characterNameInput") && !resolveSelector("characterDialogSubmit")) {
      break;
    }
    await sleep(1000);
  }
  await closeAnyOverlays();
  return [];
}

async function executeSetVoice(job) {
  const charName = job.characterName?.trim() ?? "";
  if (!charName) throw new AutomationError("characterName is required", false);
  await ensureProjectReady(job);

  const searchEl = await openAssetPicker();
  await typeText(searchEl, charName);
  await jitterSleep(800, 1200);
  const listRoot = getListboxContainer(getDialogRoot(searchEl));
  const charRow = [...listRoot.querySelectorAll('button[role="option"]')].find((btn) =>
    (btn.textContent ?? "").toLowerCase().includes(charName.toLowerCase())
  );
  if (!charRow) throw new AutomationError(`character "${charName}" not found in asset panel`, false);

  const editBtn = resolveSelector("characterRowEditButton", charRow) ?? { el: charRow };
  await clickTrusted(editBtn.el);
  await jitterSleep(800, 1200);

  const selectVoice = await waitForSelector("selectVoiceButton", { timeoutMs: 8000, required: false });
  if (selectVoice) {
    await clickTrusted(selectVoice.el);
    await jitterSleep(700, 1100);
  }

  if (job.voiceFilter?.trim()) {
    const vSearch = await waitForSelector("voiceSearchInput", { timeoutMs: 5000, required: false });
    if (vSearch) {
      await typeText(vSearch.el, job.voiceFilter.trim());
      await jitterSleep(600, 900);
    }
  } else if (job.prompt?.trim()) {
    const customTab = resolveSelector("customVoiceTab");
    if (customTab) {
      await clickSynthetic(customTab.el);
      await jitterSleep(500, 800);
    }
    const vDesc = await waitForSelector("voicePromptInput", { timeoutMs: 5000, required: false });
    if (vDesc) {
      await typeText(vDesc.el, job.prompt.trim());
      await jitterSleep(400, 700);
    }
    const genVoice = await waitForSelector("generateVoiceButton", { timeoutMs: 5000, required: false });
    if (genVoice) {
      await clickTrusted(genVoice.el);
      await sleep(8000);
    }
  }

  const assignBtn = await waitForSelector("assignVoiceButton", { timeoutMs: 30000, required: false });
  if (!assignBtn) throw new AutomationError("Assign Voice button not found", true);
  await clickTrusted(assignBtn.el);
  await jitterSleep(600, 1000);

  const saveBtn = await waitForSelector("saveCharacterButton", { timeoutMs: 8000, required: false });
  if (saveBtn) {
    await clickTrusted(saveBtn.el);
    await jitterSleep(700, 1100);
  }
  await closeAnyOverlays();
  return [];
}

async function executeRenameAsset(job) {
  const oldName = job.assetRefs?.[0]?.trim() ?? "";
  const newName = job.newAssetName?.trim() ?? "";
  if (!oldName || !newName) throw new AutomationError("assetRef and newAssetName are required", false);

  await ensureProjectReady(job);
  const tile = scanResultTiles().find((t) => {
    const aria = t.el.closest("flow-grid-tile-container")?.getAttribute("aria-label") ?? "";
    return aria.toLowerCase().includes(oldName.toLowerCase());
  });
  if (!tile) throw new AutomationError(`tile "${oldName}" not found on canvas`, false);

  await clickTrusted(tile.el);
  await jitterSleep(800, 1200);
  const editBtn = await waitForSelector("assetTitleEditButton", { timeoutMs: 6000, required: false });
  if (!editBtn) throw new AutomationError("asset title edit button not found", true);
  await clickSynthetic(editBtn.el);
  await jitterSleep(300, 500);

  const titleInput = await waitForSelector("assetTitleInput", { timeoutMs: 5000, required: false });
  if (!titleInput) throw new AutomationError("asset title input not found", true);
  await typeText(titleInput.el, newName);
  await submitEnter(titleInput.el);
  await jitterSleep(500, 800);
  await closeAnyOverlays();
  return [];
}

async function executeExtendVideo(job) {
  const refName = job.assetRefs?.[0]?.trim() ?? "";
  if (!refName) throw new AutomationError("assetRef for the clip to extend is required", false);

  await ensureProjectReady(job);
  const baselineIds = scanAllMediaIds();
  const since = Date.now();

  const tile = scanResultTiles().find((t) => {
    const aria = t.el.closest("flow-grid-tile-container")?.getAttribute("aria-label") ?? "";
    return t.kind === "video" && aria.toLowerCase().includes(refName.toLowerCase());
  });
  if (!tile) throw new AutomationError(`video tile "${refName}" not found on canvas`, false);

  await clickTrusted(tile.el);
  await jitterSleep(1000, 1500);

  const extendTab = await waitForSelector("clipEditorExtendTab", { timeoutMs: 8000, required: false });
  if (!extendTab) throw new AutomationError("Extend tab not found in clip editor", true);
  await clickSynthetic(extendTab.el);
  await jitterSleep(400, 700);

  const dur = job.params.videoOption ?? "6s";
  await clickSelectorIfPresent(`extendDurationChip_${dur}`);
  await jitterSleep(200, 400);

  const composer = await waitForSelector("promptInput", { timeoutMs: 8000 });
  await typeText(composer.el, job.prompt);
  await jitterSleep(400, 700);

  const submitBtn = await waitForEnabledSubmit(15000, composer.el);
  if (submitBtn) {
    await clickTrusted(submitBtn.el);
  } else {
    await submitEnter(composer.el);
  }

  reportStage(job.id, "generating", "extending clip");
  let collected = [];
  await collectGroupResults({
    members: [{ job, expectedCount: 1, kind: "video" }],
    baselineIds,
    since,
    timeoutMs: 20 * 60000,
    aborted: () => groupAborted,
    onJobDone: (_j, urls) => {
      collected = urls;
    },
    onJobFailed: (_j, reason, retryable) => {
      throw new AutomationError(reason, retryable);
    }
  });

  const doneBtn = resolveSelector("clipEditorDone");
  if (doneBtn) await clickSynthetic(doneBtn.el);
  return await downloadJobOutputs(job, collected, "video", true);
}

async function executeJobGroup(payload, preloadImages = []) {
  if (payload.length === 0) return;
  groupAborted = false;
  groupPaused = false;
  await closeAnyOverlays();
  await ensureProjectReady(payload[0].job);

  const mode = payload[0].job.mode;
  if (mode === "flow-upload-assets") {
    for (const { job, images } of payload) {
      await runSingleJobHandler(job, async () => {
        await preloadGroupImages(images);
        return [];
      });
    }
    return;
  }
  if (mode === "flow-create-character") {
    for (const item of payload) {
      await runSingleJobHandler(item.job, () => executeCharacterCreation(item));
    }
    return;
  }
  if (mode === "flow-set-voice") {
    for (const { job } of payload) {
      await runSingleJobHandler(job, () => executeSetVoice(job));
    }
    return;
  }
  if (mode === "flow-rename-asset") {
    for (const { job } of payload) {
      await runSingleJobHandler(job, () => executeRenameAsset(job));
    }
    return;
  }
  if (mode === "flow-extend-video") {
    for (const { job } of payload) {
      await runSingleJobHandler(job, () => executeExtendVideo(job));
    }
    return;
  }

  try {
    await preloadGroupImages([...payload.flatMap((m) => m.images), ...preloadImages]);
  } catch (err) {
    autoLog.warn("batch preload failed — jobs will upload individually", err);
    await closeAnyOverlays();
  }

  scrollResultsToTop();
  await jitterSleep(400, 700);

  const baselineIds = scanAllMediaIds();
  const limitTiles = snapshotQuotaTilesAtHead();
  const groupStartMs = Date.now();
  const submittedMembers = [];

  for (const item of payload) {
    const { job } = item;
    if (groupPaused) {
      sendJobResultToBackground(job.id, false, undefined, "paused", true, false);
      continue;
    }
    try {
      checkAborted();
      const newUploadIds = await submitStandardPrompt(item);
      baselineIds.push(...newUploadIds);
      submittedMembers.push({
        job,
        expectedCount: getExpectedOutputs(job),
        kind: isVideoGenerationMode(job.mode) ? "video" : "image"
      });
    } catch (err) {
      const retryable = err instanceof AutomationError ? err.retryable : true;
      const haltQueue = err instanceof AutomationError ? err.haltQueue : false;
      sendJobResultToBackground(job.id, false, undefined, err instanceof Error ? err.message : String(err), retryable, haltQueue);
      await closeAnyOverlays();
      if (haltQueue) return;
    }

    if (item !== payload[payload.length - 1] && !groupPaused) {
      const gap = item.gap;
      await jitterSleep(gap?.minMs ?? 1500, gap?.maxMs ?? 3000);
    }
  }

  if (submittedMembers.length === 0) return;

  const downloadTasks = [];
  await collectGroupResults({
    members: submittedMembers,
    baselineIds,
    since: groupStartMs,
    limitTiles,
    timeoutMs: submittedMembers.some((m) => isVideoGenerationMode(m.job.mode)) ? 20 * 60000 : 5 * 60000,
    aborted: () => groupAborted,
    onJobDone: (job, urls) => {
      reportStage(job.id, "downloading", `${urls.length} result(s)`);
      downloadTasks.push(
        downloadJobOutputs(job, urls, undefined, true).then((files) => {
          if (files.length === 0 && urls.length > 0) {
            sendJobResultToBackground(job.id, false, undefined, "results rendered but download failed", true);
          } else {
            const notes = [...new Set(files.map((f) => f.note).filter(Boolean))];
            sendJobResultToBackground(job.id, true, files, notes.length ? notes.join("; ") : undefined);
          }
        })
      );
    },
    onJobFailed: (job, reason, retryable) => {
      sendJobResultToBackground(job.id, false, undefined, reason, retryable, false);
    }
  });

  await Promise.all(downloadTasks);
}

// Runtime Message Listener
loadSelectorOverrides();
let tabBusy = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.t === "page.status") {
    sendResponse({
      ok: true,
      onFlow: isFlowUrl(location.href),
      loggedIn: resolveSelector("loginIndicator") === null,
      mediaOnPage: scanResultTiles().length,
      narrow: isNarrowMobileLayout()
    });
    return false;
  }

  if (msg?.t === "healthcheck.run") {
    sendResponse({
      ok: true,
      entries: runSelectorHealthcheck(),
      diagnostics: collectPageDiagnostics()
    });
    return false;
  }

  if (msg?.t === "dom.dump") {
    (async () => {
      if (msg.clickFirst) {
        const el = document.querySelector(msg.clickFirst);
        if (el) {
          el.click();
          await sleep(1200);
        }
      }
      const roots = msg.selector ? [...document.querySelectorAll(msg.selector)] : [document.body];
      const items = [];
      for (const r of roots) {
        for (const el of r.querySelectorAll("*")) {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          const attrs = {};
          for (const a of el.attributes) {
            if (!/^_ngcontent|^_nghost|^mat-ripple/.test(a.name)) {
              attrs[a.name] = a.value.slice(0, 160);
            }
          }
          items.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 70),
            attrs
          });
          if (items.length >= 1200) break;
        }
      }
      sendResponse({ ok: true, url: location.href, roots: roots.length, items });
    })();
    return true;
  }

  if (msg?.t === "job.pause") {
    groupPaused = true;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.t === "job.cancel") {
    cancelledJobIds.add(msg.jobId);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.t === "job.abort") {
    groupAborted = true;
    sendResponse({ ok: true, busy: tabBusy });
    return false;
  }

  if (msg?.t === "job.runGroup") {
    if (!isFlowUrl(location.href)) {
      sendResponse({ ok: false, error: "not on flow.google.com", retryable: true });
      return false;
    }
    if (tabBusy) {
      sendResponse({ ok: false, error: "tab busy with another job", retryable: true });
      return false;
    }
    tabBusy = true;
    executeJobGroup(msg.payload, msg.preload ?? [])
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        contentLog.error(`group failed: ${errMsg}`);
        sendResponse({ ok: false, error: errMsg, retryable: true });
      })
      .finally(() => {
        tabBusy = false;
      });
    return true;
  }

  return false;
});

// Listen for MAIN-world network spy messages
window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data?.__mflowNet) return;
  const data = ev.data;
  if (data.kind === "upload-done") {
    lastUploadDoneAt = Date.now();
  }
  if (data.kind === "media-prompt" && typeof data.id === "string" && typeof data.prompt === "string") {
    recordMediaPrompt(data.id, data.prompt);
    return;
  }
  if (data.kind === "media-asb" && typeof data.id === "string" && typeof data.token === "string") {
    recordMediaAsb(data.id, data.token);
    return;
  }
  if (data.kind === "media-ready" && typeof data.url === "string" && !data.url.includes("\\")) {
    recordReadyMediaUrl(data.url);
  }
  netLog.info(
    `${data.kind} ${data.method ?? ""} ${data.status ?? ""} ${data.url}` +
      (data.body ? ` | req: ${data.body}` : "") +
      (data.resp ? ` | resp: ${data.resp}` : "") +
      (data.error ? ` | err: ${data.error}` : "")
  );
});

contentLog.info(`Mahatachyons Flow content script ready on ${location.pathname}`);

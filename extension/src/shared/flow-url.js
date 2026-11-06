export const FLOW_TAB_PATTERNS = [
  "https://flow.google.com/*",
  "https://labs.google/*"
];

export const FLOW_BASE_URL = "https://flow.google.com";
export const PROJECT_PATH_RE = /(?:\/fx\/tools\/flow)?\/project\/([^/?#]+)/;

export function isFlowUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host === "flow.google.com") return true;
    return u.host === "labs.google" && u.pathname.includes("/fx/tools/flow");
  } catch {
    return false;
  }
}

export function isClipEditorUrl(urlStr) {
  return /(?:\/fx\/tools\/flow)?\/project\/[^/]+\/(?:edit|scene)\/[^/?#]+/.test(urlStr);
}

export function extractAuthUserPrefix(urlStr) {
  return /^https?:\/\/[^/]+(\/u\/\d+)(?:\/|$)/.exec(urlStr ?? "")?.[1] ?? "";
}

export function buildFlowRootUrl(currentUrl) {
  return `${FLOW_BASE_URL}${extractAuthUserPrefix(currentUrl)}`;
}

export function buildFlowProjectUrl(projectId, currentUrl) {
  return `${buildFlowRootUrl(currentUrl)}/project/${projectId}`;
}

export function isFlowHostname(hostname) {
  return /^flow\.google\.com$/i.test(hostname) || /(^|\.)labs\.google$/i.test(hostname);
}

function unescapeRpcText(raw) {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .split("\\")
    .join("");
}

export function extractFlowMediaUrls(responseText) {
  const clean = unescapeRpcText(responseText);
  const re = /https:\/\/flow-content\.google\/(?:image|video)\/[^"',\s]+/g;
  return [...new Set(clean.match(re) ?? [])];
}

export function extractMediaPrompts(responseText) {
  const clean = responseText
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\+[nrt]/g, " ")
    .split("\\")
    .join("");
  const re = /\["([0-9a-f-]{36})",null,"[0-9a-f-]{36}",(?:null,)*\[\[null,\d+,(?:null,)*\d+,"([^"]+)"/g;
  return [...clean.matchAll(re)].map((m) => [m[1], m[2]]);
}

export function extractAsbTokens(responseText) {
  const clean = unescapeRpcText(responseText);
  const matches = [...clean.matchAll(/\["([0-9a-f-]{36})","[0-9a-f-]{36}","[0-9a-f-]{36}"/g)];
  const results = [];
  matches.forEach((m, idx) => {
    const slice = clean.slice(m.index, matches[idx + 1]?.index ?? clean.length);
    const token = extractAsbFromUrl(slice);
    const prompt = /\[\[\d+,\d+\],"([^"]+)"/.exec(slice)?.[1];
    if (token) {
      results.push(prompt ? [m[1], token, prompt] : [m[1], token]);
    }
  });
  return results;
}

export function extractAsbFromUrl(urlStr) {
  return /\/asb\/([\w-]+)/.exec(urlStr)?.[1];
}

export function extractMediaIdFromContentUrl(urlStr) {
  return /flow-content\.google\/(?:image|video)\/([^?/]+)/.exec(urlStr)?.[1];
}


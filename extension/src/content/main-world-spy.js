(() => {
  const FLOW_API_RE = /generate|create|image|flow|media|project|asset|poll|status|list/i;
  const MEDIA_REDIRECT_RE = /\/media\.getMediaUrlRedirect(\?|$)/i;
  const MAX_BODY_SLICE = 2000;
  const MAX_RESP_SLICE = 2000;
  const PARKED_ATTR = "data-mflow-parked";

  function isFlowHost(urlStr) {
    try {
      const host = new URL(urlStr, location.href).hostname;
      return /^flow\.google\.com$/i.test(host) || /(^|\.)labs\.google$/i.test(host);
    } catch {
      return false;
    }
  }

  function unescapeText(raw) {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .split("\\")
      .join("");
  }

  function extractMediaUrls(text) {
    const clean = unescapeText(text);
    const re = /https:\/\/flow-content\.google\/(?:image|video)\/[^"',\s]+/g;
    return [...new Set(clean.match(re) ?? [])];
  }

  function extractMediaPrompts(text) {
    const clean = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\+[nrt]/g, " ")
      .split("\\")
      .join("");
    const re = /\["([0-9a-f-]{36})",null,"[0-9a-f-]{36}",(?:null,)*\[\[null,\d+,(?:null,)*\d+,"([^"]+)"/g;
    return [...clean.matchAll(re)].map((m) => [m[1], m[2]]);
  }

  function extractAsbTokens(text) {
    const clean = unescapeText(text);
    const matches = [...clean.matchAll(/\["([0-9a-f-]{36})","[0-9a-f-]{36}","[0-9a-f-]{36}"/g)];
    const out = [];
    matches.forEach((m, idx) => {
      const slice = clean.slice(m.index, matches[idx + 1]?.index ?? clean.length);
      const token = /\/asb\/([\w-]+)/.exec(slice)?.[1];
      const prompt = /\[\[\d+,\d+\],"([^"]+)"/.exec(slice)?.[1];
      if (token) out.push(prompt ? [m[1], token, prompt] : [m[1], token]);
    });
    return out;
  }

  function emitNet(payload) {
    window.postMessage({ __mflowNet: true, ...payload }, window.location.origin);
  }

  // 1. Intercept window.fetch
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let reqBody = "";
    try {
      if (method !== "GET" && init?.body && typeof init.body === "string") {
        reqBody = init.body.slice(0, MAX_BODY_SLICE);
      } else if (method !== "GET" && input instanceof Request) {
        reqBody = (await input.clone().text()).slice(0, MAX_BODY_SLICE);
      }
    } catch {}

    const isUpload = method !== "GET" && /upload/i.test(url);
    if (isUpload) {
      emitNet({ kind: "upload-net", method, url: url.slice(0, 200) });
    }

    const startMs = Date.now();
    try {
      const res = await nativeFetch(input, init);
      if (isUpload) {
        emitNet({ kind: "upload-done", method, status: res.status, url: url.slice(0, 200) });
      }
      if (isFlowHost(url)) {
        if (method === "GET" && res.status === 200 && MEDIA_REDIRECT_RE.test(url)) {
          emitNet({ kind: "media-ready", url: new URL(url, location.href).href });
        }
        const matchesFlowApi = FLOW_API_RE.test(url);
        let respPreview = "";
        if (matchesFlowApi && !MEDIA_REDIRECT_RE.test(url)) {
          try {
            const text = await res.clone().text();
            for (const mediaUrl of extractMediaUrls(text)) {
              emitNet({ kind: "media-ready", url: mediaUrl });
            }
            for (const [id, prompt] of extractMediaPrompts(text)) {
              emitNet({ kind: "media-prompt", id, prompt });
            }
            for (const [id, token, prompt] of extractAsbTokens(text)) {
              emitNet({ kind: "media-asb", id, token });
              if (prompt) emitNet({ kind: "media-prompt", id, prompt });
            }
            respPreview = text.slice(0, MAX_RESP_SLICE);
          } catch {}
        }
        emitNet({
          kind: "fetch",
          method,
          url: url.slice(0, 200),
          status: res.status,
          ms: Date.now() - startMs,
          body: matchesFlowApi ? reqBody : "",
          resp: respPreview
        });
      }
      return res;
    } catch (err) {
      if (isFlowHost(url)) {
        emitNet({
          kind: "fetch-error",
          method,
          url: url.slice(0, 200),
          error: String(err)
        });
      }
      throw err;
    }
  };

  // 2. Intercept XMLHttpRequest
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mflowMeta = { method: String(method).toUpperCase(), url: String(url) };
    return nativeXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__mflowMeta;
    if (meta && meta.method !== "GET" && /upload/i.test(meta.url)) {
      emitNet({ kind: "upload-net", method: meta.method, url: meta.url.slice(0, 200) });
      this.addEventListener("loadend", () => {
        emitNet({
          kind: "upload-done",
          method: meta.method,
          status: this.status,
          url: meta.url.slice(0, 200)
        });
      });
    }
    if (meta && isFlowHost(meta.url)) {
      const isApi = FLOW_API_RE.test(meta.url);
      const isRedirect = MEDIA_REDIRECT_RE.test(meta.url);
      this.addEventListener("loadend", () => {
        if (meta.method === "GET" && this.status === 200 && isRedirect) {
          emitNet({ kind: "media-ready", url: new URL(meta.url, location.href).href });
        }
        if (isApi && !isRedirect) {
          const text = String(this.responseText ?? "");
          for (const mediaUrl of extractMediaUrls(text)) {
            emitNet({ kind: "media-ready", url: mediaUrl });
          }
          for (const [id, prompt] of extractMediaPrompts(text)) {
            emitNet({ kind: "media-prompt", id, prompt });
          }
          for (const [id, token, prompt] of extractAsbTokens(text)) {
            emitNet({ kind: "media-asb", id, token });
            if (prompt) emitNet({ kind: "media-prompt", id, prompt });
          }
        }
        emitNet({
          kind: "xhr",
          method: meta.method,
          url: meta.url.slice(0, 200),
          status: this.status,
          body: isApi && !isRedirect && typeof body === "string" ? body.slice(0, MAX_BODY_SLICE) : "",
          resp: isApi && !isRedirect ? String(this.responseText ?? "").slice(0, MAX_RESP_SLICE) : ""
        });
      });
    }
    return nativeXhrSend.call(this, body ?? null);
  };

  // 3. Intercept WebSocket
  const NativeWebSocket = window.WebSocket;
  const WrappedWebSocket = function (url, protocols) {
    const ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    const urlStr = String(url);
    emitNet({ kind: "ws-open", url: urlStr.slice(0, 200) });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data) => {
      if (typeof data === "string") {
        emitNet({ kind: "ws-send", url: urlStr.slice(0, 120), body: data.slice(0, 700) });
      }
      return nativeSend(data);
    };
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string" && /error|fail|unusual|suspicious|rate limit|blocked/i.test(ev.data)) {
        emitNet({ kind: "ws-recv", url: urlStr.slice(0, 120), resp: ev.data.slice(0, 300) });
      }
    });
    return ws;
  };
  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(WrappedWebSocket, {
    CONNECTING: NativeWebSocket.CONNECTING,
    OPEN: NativeWebSocket.OPEN,
    CLOSING: NativeWebSocket.CLOSING,
    CLOSED: NativeWebSocket.CLOSED
  });
  window.WebSocket = WrappedWebSocket;

  // 4. Intercept File Input Pickers when Upload is Armed
  let uploadArmed = false;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || typeof ev.data?.__mflowUpload !== "string") return;
    uploadArmed = ev.data.__mflowUpload === "arm";
    emitNet({
      kind: uploadArmed ? "upload-armed" : "upload-disarmed",
      url: location.pathname
    });
  });

  function parkFileInput(inputEl, source) {
    inputEl.style.display = "none";
    document.body.appendChild(inputEl);
    inputEl.setAttribute(PARKED_ATTR, "");
    emitNet({
      kind: "upload-input-parked",
      url: `${source} accept=${inputEl.accept || "*"}`
    });
  }

  const nativeClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function () {
    const isFileInput = this.tagName === "INPUT" && this.type === "file";
    if (isFileInput && !uploadArmed) {
      emitNet({ kind: "upload-observed", url: `click accept=${this.accept || "*"}` });
    }
    if (uploadArmed && isFileInput) {
      parkFileInput(this, "click");
      emitNet({ kind: "upload-click-swallowed", url: this.accept || "*" });
      return;
    }
    return nativeClick.call(this);
  };

  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    const isFileClick = ev?.type === "click" && this?.tagName === "INPUT" && this.type === "file";
    if (!uploadArmed && isFileClick) {
      emitNet({ kind: "upload-observed", url: "dispatchEvent click" });
    }
    if (uploadArmed && isFileClick) {
      parkFileInput(this, "dispatchEvent");
      emitNet({ kind: "upload-click-swallowed", url: `dispatchEvent ${this.accept || "*"}` });
      return true;
    }
    return nativeDispatchEvent.call(this, ev);
  };

  const nativeCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName, options) {
    const el = nativeCreateElement(tagName, options);
    if (String(tagName).toLowerCase() === "input") {
      setTimeout(() => {
        if (el.type === "file" && !uploadArmed) {
          emitNet({
            kind: "upload-observed",
            url: `createElement input[type=file] accept=${el.accept || "*"}`
          });
        }
        if (uploadArmed && el.type === "file" && !el.hasAttribute(PARKED_ATTR)) {
          parkFileInput(el, "createElement");
        }
      }, 0);
    }
    return el;
  };

  const nativeShowPicker = HTMLInputElement.prototype.showPicker;
  if (typeof nativeShowPicker === "function") {
    HTMLInputElement.prototype.showPicker = function () {
      if (!uploadArmed && this.type === "file") {
        emitNet({ kind: "upload-observed", url: `showPicker accept=${this.accept || "*"}` });
      }
      if (uploadArmed && this.type === "file") {
        parkFileInput(this, "showPicker");
        emitNet({ kind: "upload-click-swallowed", url: `showPicker ${this.accept || "*"}` });
        return;
      }
      return nativeShowPicker.call(this);
    };
  }

  const nativeShowOpenFilePicker = window.showOpenFilePicker;
  if (typeof nativeShowOpenFilePicker === "function") {
    window.showOpenFilePicker = (...args) => {
      if (uploadArmed) {
        emitNet({ kind: "upload-picker-unsupported", url: "showOpenFilePicker" });
        return Promise.reject(new DOMException("aborted by mflow-connector", "AbortError"));
      }
      return nativeShowOpenFilePicker.apply(window, args);
    };
  }

  console.debug("[mflow-connector] MAIN-world result capture & file-picker interceptor active");
})();


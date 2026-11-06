// Mahatachyons Google Flow Connector — Side Panel Controller

const SPEED_DESCRIPTIONS = {
  1: "Level 1 (Safe) — 1 prompt / batch (max 4 outputs)",
  2: "Level 2 — 2 prompts / batch (max 4 outputs)",
  3: "Level 3 — 3 prompts / batch (max 6 outputs)",
  4: "Level 4 (Fast) — 4 prompts / batch (max 8 outputs)",
  5: "Level 5 — 6 prompts / batch (max 10 outputs)",
  6: "Level 6 (Turbo) — 8 prompts / batch (max 12 outputs)"
};

// Connect port so background can request temporary close if narrow viewport needs 2K/1080p menu
const bgPort = chrome.runtime.connect({ name: "mflow-sidepanel" });
bgPort.onMessage.addListener((msg) => {
  if (msg?.t === "panel.closeSelf") {
    window.close();
  }
});

// Tab switching
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    panels.forEach((p) => p.classList.toggle("active", p.id === `tab-${target}`));
    if (target === "diagnostics") refreshLogs();
  });
}

// Status & Queue Rendering
let currentPaused = false;

function updateStatusUI(status) {
  if (!status) return;
  currentPaused = !!status.paused;
  const pauseBtn = document.getElementById("pause-btn");
  pauseBtn.textContent = currentPaused ? "Resume Queue" : "Pause Queue";

  const bridgeDot = document.getElementById("bridge-dot");
  const bridgeLabel = document.getElementById("bridge-label");
  if (status.bridgeConnected) {
    bridgeDot.className = "dot ok";
    bridgeLabel.textContent = "Bridge: Connected (:8791)";
  } else {
    bridgeDot.className = "dot warn";
    bridgeLabel.textContent = "Bridge: Standby (Extension Ready)";
  }

  const flowDot = document.getElementById("flow-dot");
  const flowLabel = document.getElementById("flow-label");
  if (status.onFlowPage && status.loggedIn !== false) {
    flowDot.className = "dot ok";
    flowLabel.textContent = `Flow: Ready (${status.flowTabs?.length ?? 1} tab)`;
  } else if (status.flowTabs?.length > 0) {
    flowDot.className = "dot warn";
    flowLabel.textContent = "Flow: Sign in required";
  } else {
    flowDot.className = "dot err";
    flowLabel.textContent = "Flow: No tab open";
  }

  if (status.queueCounts) {
    document.getElementById("count-running").textContent = String(status.queueCounts.running ?? 0);
    document.getElementById("count-queued").textContent = String(status.queueCounts.queued ?? 0);
    document.getElementById("count-done").textContent = String(status.queueCounts.done ?? 0);
    document.getElementById("count-failed").textContent = String(status.queueCounts.failed ?? 0);
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderJobs(jobs = []) {
  const running = jobs.filter((j) => j.status === "running").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  document.getElementById("count-running").textContent = String(running);
  document.getElementById("count-queued").textContent = String(queued);
  document.getElementById("count-done").textContent = String(done);
  document.getElementById("count-failed").textContent = String(failed);

  const container = document.getElementById("job-list");
  if (jobs.length === 0) {
    container.innerHTML = `<div class="empty-state">No jobs in queue. Submit via <code>mflow generate create</code>, MCP, or the Quick Run tab.</div>`;
    return;
  }

  container.innerHTML = jobs
    .slice(0, 60)
    .map((job) => {
      const stageBadge = job.stage
        ? ` · ${escapeHtml(job.stage)}${job.stageDetail ? ` (${escapeHtml(job.stageDetail)})` : ""}`
        : "";
      const filesHtml =
        job.resultFiles?.length > 0
          ? `<div class="job-files">${job.resultFiles.map((f) => escapeHtml(f.path)).join("<br/>")}</div>`
          : "";
      const errHtml = job.error ? `<div class="job-error">${escapeHtml(job.error)}</div>` : "";
      const canCancel = job.status === "queued" || job.status === "running";

      return `
        <div class="job-card">
          <div class="job-head">
            <span class="job-mode">${escapeHtml(job.mode)}${stageBadge}</span>
            <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
          </div>
          <div class="job-prompt">${escapeHtml(job.prompt || job.characterName || "(no prompt)")}</div>
          ${filesHtml}
          ${errHtml}
          <div class="job-meta">
            <span>${escapeHtml(job.id)} · attempt ${job.attempts}/${job.maxAttempts}</span>
            ${canCancel ? `<button class="btn btn-danger btn-xs" data-cancel="${escapeHtml(job.id)}">Cancel</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const jobId = btn.getAttribute("data-cancel");
      await chrome.runtime.sendMessage({ t: "job.cancel", jobId });
      refreshAll();
    });
  });
}

async function refreshAll() {
  const [statusRes, queueRes] = await Promise.all([
    chrome.runtime.sendMessage({ t: "status.get" }).catch(() => null),
    chrome.runtime.sendMessage({ t: "queue.list" }).catch(() => null)
  ]);
  if (statusRes?.ok) updateStatusUI(statusRes.status);
  if (queueRes?.ok) renderJobs(queueRes.jobs);
}

// Listen for live background events
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.t === "bg.event") {
    if (msg.event?.kind === "queue.updated") renderJobs(msg.event.jobs);
    if (msg.event?.kind === "status.updated") updateStatusUI(msg.event.status);
  }
});

// Toolbar Actions
document.getElementById("open-flow-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ t: "flow.openTab" });
});

document.getElementById("pause-btn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ t: "queue.setPaused", paused: !currentPaused });
  if (res?.ok) updateStatusUI(res.status);
});

document.getElementById("stop-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ t: "queue.stop" });
  refreshAll();
});

document.getElementById("clear-done-btn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ t: "queue.clear" });
  if (res?.ok) renderJobs(res.jobs);
});

// Quick Run Composer
document.getElementById("quick-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = document.getElementById("q-mode").value;
  const imageModel = document.getElementById("q-model").value || undefined;
  const aspectRatio = document.getElementById("q-aspect").value || undefined;
  const outputsPerPrompt = Number(document.getElementById("q-count").value) || 1;
  const videoOption = document.getElementById("q-duration").value || undefined;
  const promptEl = document.getElementById("q-prompt");
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const prefs = await chrome.storage.local.get(["mflow:newProject"]);
  await chrome.runtime.sendMessage({
    t: "job.submit",
    job: {
      mode,
      prompt,
      params: {
        imageModel,
        aspectRatio,
        outputsPerPrompt,
        videoOption,
        newProject: !!prefs["mflow:newProject"]
      }
    }
  });
  promptEl.value = "";
  document.querySelector('[data-tab="queue"]').click();
  refreshAll();
});

// Settings Controls
const speedSlider = document.getElementById("speed-slider");
const speedBadge = document.getElementById("speed-badge");
const speedDesc = document.getElementById("speed-desc");
const toggle2k = document.getElementById("toggle-2k");
const toggle1080p = document.getElementById("toggle-1080p");
const toggleNewProject = document.getElementById("toggle-new-project");

function updateSpeedLabel(val) {
  const level = Number(val) || 4;
  speedBadge.textContent = `${level}x`;
  speedDesc.textContent = SPEED_DESCRIPTIONS[level] ?? SPEED_DESCRIPTIONS[4];
}

chrome.storage.local
  .get(["mflow:speed", "mflow:image2k", "mflow:video1080p", "mflow:newProject"])
  .then((data) => {
    const speed = Number(data["mflow:speed"]) || 4;
    speedSlider.value = String(speed);
    updateSpeedLabel(speed);
    toggle2k.checked = !!data["mflow:image2k"];
    toggle1080p.checked = !!data["mflow:video1080p"];
    toggleNewProject.checked = !!data["mflow:newProject"];
  });

speedSlider.addEventListener("input", () => {
  const level = Number(speedSlider.value);
  updateSpeedLabel(level);
  chrome.storage.local.set({ "mflow:speed": level });
});

toggle2k.addEventListener("change", () => {
  chrome.storage.local.set({ "mflow:image2k": toggle2k.checked });
});

toggle1080p.addEventListener("change", () => {
  chrome.storage.local.set({ "mflow:video1080p": toggle1080p.checked });
});

toggleNewProject.addEventListener("change", () => {
  chrome.storage.local.set({ "mflow:newProject": toggleNewProject.checked });
});

document.getElementById("copy-setup-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const setupText = [
    "Use Mahatachyons Google Flow Connector (`mflow` CLI or `mflow-mcp` MCP server) to generate images and videos on Google Flow:",
    "1. Check readiness: `mflow doctor`",
    "2. Generate an image: `mflow generate create -m flow-image -p \"your prompt\" --wait`",
    "3. Generate a video: `mflow generate create -m flow-text-to-video -p \"your prompt\" --wait`"
  ].join("\n");
  await navigator.clipboard.writeText(setupText);
  btn.textContent = "Copied to Clipboard!";
  setTimeout(() => {
    btn.textContent = "Copy Agent Setup Prompt";
  }, 1800);
});

// Diagnostics Controls
async function refreshLogs() {
  const res = await chrome.runtime.sendMessage({ t: "logs.get" }).catch(() => null);
  const view = document.getElementById("logs-view");
  const logs = res?.logs ?? [];
  if (logs.length === 0) {
    view.textContent = "No logs recorded yet.";
    return;
  }
  view.textContent = logs
    .slice(-150)
    .reverse()
    .map((l) => {
      const time = new Date(l.ts).toISOString().slice(11, 23);
      return `[${time}] [${l.level.toUpperCase()}] [${l.scope}] ${l.msg}${l.data ? ` ${l.data}` : ""}`;
    })
    .join("\n");
}

document.getElementById("refresh-logs-btn").addEventListener("click", refreshLogs);

document.getElementById("copy-logs-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const res = await chrome.runtime.sendMessage({ t: "logs.get" }).catch(() => null);
  await navigator.clipboard.writeText(JSON.stringify(res?.logs ?? [], null, 2));
  btn.textContent = "Copied!";
  setTimeout(() => {
    btn.textContent = "Copy";
  }, 1500);
});

document.getElementById("clear-logs-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ t: "logs.clear" });
  refreshLogs();
});

document.getElementById("run-hc-btn").addEventListener("click", async () => {
  const container = document.getElementById("hc-results");
  container.classList.remove("hidden");
  container.textContent = "Running selector healthcheck on active Flow tab…";
  const res = await chrome.runtime.sendMessage({ t: "healthcheck.trigger" }).catch(() => null);
  if (!res?.ok || res.error) {
    container.innerHTML = `<div class="hc-miss">${escapeHtml(res?.error ?? "Healthcheck failed")}</div>`;
    return;
  }
  const entries = res.entries ?? [];
  const matched = entries.filter((e) => e.matched).length;
  container.innerHTML =
    `<div style="margin-bottom:6px;font-weight:700">Matched ${matched}/${entries.length} selectors on ${escapeHtml(res.tabUrl)}</div>` +
    entries
      .map(
        (e) =>
          `<div class="hc-row"><span>${escapeHtml(e.key)}</span><span class="${e.matched ? "hc-ok" : "hc-miss"}">${
            e.matched ? `OK (${escapeHtml(e.strategy)})` : "not visible"
          }</span></div>`
      )
      .join("");
});

refreshAll();
setInterval(refreshAll, 3000);


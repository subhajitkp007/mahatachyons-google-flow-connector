# Mahatachyons Google Flow Connector

An **unrestricted, self-hosted** Chrome Extension + Local Bridge + CLI (`mflow`) + MCP Server (`mflow-mcp`) + AI Agent Skill for automating **Google Flow** (`labs.google/fx/tools/flow` & `flow.google.com` — **Veo 3.1**, **Omni Flash**, **Nano Banana Pro / 2**).

## What's Unlocked Out of the Box

| Capability | Commercial Extension (Free Tier) | Mahatachyons Flow Connector |
| :--- | :--- | :--- |
| **Daily Quota** | Capped at 30 videos / 40 images per day | **Unlimited** (no local or cloud counter) |
| **Batching & Speed** | Locked to `batchSize = 1` + forced 20–25s delay | **Up to 8 prompts/batch (12 outputs)**, Speed 1x–6x Turbo |
| **2K Image Upscaling** | Pro subscription only | **Unlocked** (`--image-quality 2k` or Side Panel toggle) |
| **1080p Video Upscaling** | Pro subscription only | **Unlocked** (`--video-quality 1080p` or Side Panel toggle) |
| **Side Panel Keep-Open Gate** | Pauses queue after 10s if side panel closes | **Removed** — runs freely in the background |
| **External Telemetry / License Calls** | Calls `flowconnector.workers.dev` & `flowconnector.dev` | **Zero external calls** — 100% local (`127.0.0.1:8791`) |

---

## Project Structure

```text
.
├── bin/
│   ├── mflow.mjs                 # CLI binary (`mflow` / `flow-auto`)
│   └── mflow-mcp.mjs             # MCP stdio server binary (`mflow-mcp` / `flow-auto-mcp`)
├── src/
│   ├── shared.mjs                # Modes, models, parameters & Zod schemas
│   ├── bridge.mjs                # Local HTTP + WebSocket bridge on 127.0.0.1:8791
│   ├── cli.mjs                   # Commander CLI implementation
│   └── mcp.mjs                   # Model Context Protocol (MCP) server
├── extension/                    # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── background/service-worker.js
│       ├── content/main-world-spy.js
│       ├── content/automator-loader.js
│       ├── content/automator.js
│       ├── shared/flow-url.js
│       ├── shared/logger.js
│       ├── shared/selectors.js
│       └── sidepanel/            # Side panel UI (Queue, Quick Run, Settings, Diagnostics)
├── skills/
│   └── flow-generate/SKILL.md    # Agent skill for Antigravity, Claude Code, Cursor, Codex
└── tools/
    └── inpaint.py                # Bottom-right watermark inpainter
```

---

## Quick Start

### 1. Install Dependencies & Link CLI

```bash
cd /Users/subhajitmahata/Desktop/github/automation/mahatachyons-google-flow-connector
npm install
npm link
```

This makes `mflow`, `mflow-mcp`, `flow-auto`, and `flow-auto-mcp` available globally in your terminal.

### 2. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select:
   ```text
   /Users/subhajitmahata/Desktop/github/automation/mahatachyons-google-flow-connector/extension
   ```
4. Open [Google Flow](https://labs.google/fx/tools/flow) and sign in with your Google account.

### 3. Verify Readiness

```bash
mflow doctor
```

---

## CLI Usage (`mflow`)

### Generate Images

```bash
# Text to Image (Nano Banana Pro, 2K upscale)
mflow generate create \
  -m flow-image \
  -p "futuristic glass observatory on Europa, cinematic lighting" \
  --image-model nano-banana-pro \
  --aspect 16:9 \
  --image-quality 2k \
  --wait

# Reference Image to Image
mflow generate create \
  -m flow-image \
  -p "restyle this character in claymation stop-motion aesthetic" \
  -i ./portrait.png \
  --wait
```

### Generate Videos

```bash
# Text to Video (Veo 3.1 Quality, 1080p HD upscale)
mflow generate create \
  -m flow-text-to-video \
  -p "fpv drone flying through a canyon waterfall at sunrise" \
  --image-model veo-3.1-quality \
  --aspect 16:9 \
  --video-quality 1080p \
  --wait

# Start + End Frames to Video
mflow generate create \
  -m flow-frame-to-video \
  -p "smooth camera orbit around the subject" \
  -i ./start.png ./end.png \
  --wait
```

### Batch Prompts from a File

```bash
mflow generate create -m flow-image --prompts-file ./prompts.txt --outputs-per-prompt 2 --wait
```

### Post-Processing (`merge` & `clean`)

```bash
# Concatenate video clips
mflow merge scene1.mp4 scene2.mp4 -o movie.mp4

# Clean bottom-right watermark
mflow clean movie.mp4 --mode delogo -o movie-clean.mp4
```

---

## MCP Server Configuration

Add `mflow-mcp` to your MCP client configuration (Claude Desktop, Claude Code, Cursor, Antigravity):

```json
{
  "mcpServers": {
    "mahatachyons-flow": {
      "command": "node",
      "args": ["/Users/subhajitmahata/Desktop/github/automation/mahatachyons-google-flow-connector/bin/mflow-mcp.mjs"]
    }
  }
}
```

### Install the Agent Skill

```bash
mflow skill install
```


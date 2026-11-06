---
name: flow-generate
description: Generate AI images and videos on Google Flow (Veo 3.1, Omni Flash, Nano Banana Pro/2) using the Mahatachyons Google Flow Connector (`mflow` CLI or `flow_generate` MCP tool). Supports text-to-image, reference-to-image, text-to-video, frames-to-video, ingredients-to-video, character creation, voice assignment, clip extension, 2K/1080p upscaling, and multi-clip merging.
---

# Mahatachyons Google Flow Connector Skill (`mflow`)

Use `mflow` (or `flow-auto`) to drive the user's logged-in Google Flow browser tab (`https://labs.google/fx/tools/flow`) with zero API keys and unlimited local batching.

## 1. Quick Readiness Check

Before submitting jobs, verify the bridge and Chrome extension are connected:

```bash
mflow doctor
```

## 2. Generating Images (`flow-image`)

```bash
# Single image (Nano Banana Pro, 16:9, 2K upscaled download)
mflow generate create \
  -m flow-image \
  -p "cinematic cyberpunk alley in rain, neon reflections, 35mm anamorphic" \
  --image-model nano-banana-pro \
  --aspect 16:9 \
  --image-quality 2k \
  --wait

# With up to 8 local reference images
mflow generate create \
  -m flow-image \
  -p "place this product on a volcanic black-sand beach at golden hour" \
  -i ./product.png \
  --aspect 16:9 \
  --wait
```

## 3. Generating Videos (`flow-text-to-video`, `flow-frame-to-video`, `flow-ingredients-to-video`)

```bash
# Text to Video (Veo 3.1 Quality, 1080p upscale)
mflow generate create \
  -m flow-text-to-video \
  -p "aerial drone shot over bioluminescent waves crashing against sea cliffs at night" \
  --image-model veo-3.1-quality \
  --aspect 16:9 \
  --video-quality 1080p \
  --wait

# Start & End Frame to Video
mflow generate create \
  -m flow-frame-to-video \
  -p "smooth camera push-in as the lantern ignites" \
  -i ./start-frame.png ./end-frame.png \
  --aspect 16:9 \
  --wait

# Ingredients / Character Consistency Video
mflow generate create \
  -m flow-ingredients-to-video \
  -p "the explorer walks across a misty suspension bridge" \
  -i ./hero.png ./bridge.png \
  --aspect 16:9 \
  --wait
```

## 4. Characters, Voices & Clip Extension

```bash
# Create a reusable character
mflow generate create -m flow-create-character --character-name "Aria" -p "young astronaut in weathered white suit" --wait

# Assign a voice to a character
mflow generate create -m flow-set-voice --character-name "Aria" --voice "warm female" --wait

# Extend an existing video clip on the Flow canvas
mflow generate create -m flow-extend-video --asset-ref "scene-1" -p "camera pans up to reveal the orbital ring" --video-option 6s --wait
```

## 5. Post-Processing (`merge` & `clean`)

```bash
# Merge multiple video clips into a single MP4
mflow merge clip1.mp4 clip2.mp4 -o final.mp4

# Strip bottom-right watermark
mflow clean final.mp4 --mode delogo -o final-clean.mp4
```


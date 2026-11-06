import { z } from "zod";

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = Number(process.env.MFLOW_PORT || process.env.FLOW_AUTO_PORT || 8791);
export const BRIDGE_HTTP_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const BRIDGE_WS_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;

export const GENERATION_MODES = [
  "flow-text-to-video",
  "flow-frame-to-video",
  "flow-ingredients-to-video",
  "flow-video-to-video",
  "flow-image",
  "text-to-image",
  "image-to-image",
  "flow-upload-assets",
  "flow-create-character",
  "flow-set-voice",
  "flow-extend-video",
  "flow-rename-asset"
];

export const FLOW_MODELS = [
  "nano-banana-pro",
  "nano-banana-2",
  "nano-banana-2-lite",
  "omni-flash",
  "veo-3.1-lite",
  "veo-3.1-fast",
  "veo-3.1-quality"
];

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
export const VIDEO_DURATIONS = ["4s", "6s", "8s", "10s"];
export const VIDEO_RESOLUTIONS = ["480p", "720p"];
export const IMAGE_QUALITIES = ["1k", "2k"];
export const VIDEO_QUALITIES = ["720p", "1080p"];

export const MODE_DESCRIPTIONS = {
  "flow-image": {
    kind: "image",
    maxImages: 8,
    summary: "Generate images from text and up to 8 reference images/characters."
  },
  "text-to-image": {
    kind: "image",
    maxImages: 0,
    summary: "Alias for flow-image without reference images."
  },
  "image-to-image": {
    kind: "image",
    maxImages: 8,
    summary: "Alias for flow-image with reference images."
  },
  "flow-text-to-video": {
    kind: "video",
    maxImages: 0,
    summary: "Generate video clips from a text prompt (Omni Flash or Veo 3.1)."
  },
  "flow-frame-to-video": {
    kind: "video",
    maxImages: 2,
    summary: "Animate between a start frame and optional end frame."
  },
  "flow-ingredients-to-video": {
    kind: "video",
    maxImages: 4,
    summary: "Generate video using up to 4 ingredient images or characters."
  },
  "flow-video-to-video": {
    kind: "video",
    maxImages: 1,
    summary: "Transform or restyle a reference video."
  },
  "flow-upload-assets": {
    kind: "utility",
    maxImages: 10,
    summary: "Pre-upload reference files into the current Flow project."
  },
  "flow-create-character": {
    kind: "utility",
    maxImages: 1,
    summary: "Create a named Flow character from a prompt or portrait photo."
  },
  "flow-set-voice": {
    kind: "utility",
    maxImages: 0,
    summary: "Assign a preset or custom voice to a Flow character."
  },
  "flow-extend-video": {
    kind: "video",
    maxImages: 0,
    summary: "Extend an existing video clip on the Flow canvas."
  },
  "flow-rename-asset": {
    kind: "utility",
    maxImages: 0,
    summary: "Rename an asset tile on the Flow canvas."
  }
};

export const JobParamsSchema = z.object({
  imageModel: z.enum(FLOW_MODELS).optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  videoOption: z.enum(VIDEO_DURATIONS).optional(),
  videoResolution: z.enum(VIDEO_RESOLUTIONS).optional(),
  outputsPerPrompt: z.number().int().min(1).max(4).optional(),
  downloadImageQuality: z.enum(IMAGE_QUALITIES).optional(),
  downloadVideoQuality: z.enum(VIDEO_QUALITIES).optional(),
  newProject: z.boolean().optional()
});

export const JobCreateSchema = z.object({
  id: z.string().optional(),
  mode: z.enum(GENERATION_MODES).default("flow-image"),
  prompt: z.string().default(""),
  params: JobParamsSchema.default({}),
  imagePaths: z.array(z.string()).default([]),
  assetRefs: z.array(z.string()).optional(),
  characterRefs: z.array(z.string()).optional(),
  characterName: z.string().optional(),
  voiceFilter: z.string().optional(),
  newAssetName: z.string().optional(),
  outputDir: z.string().optional(),
  filenamePrefix: z.string().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional()
});


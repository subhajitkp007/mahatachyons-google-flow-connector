import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeClient } from "./bridge.mjs";
import {
  GENERATION_MODES,
  FLOW_MODELS,
  ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  IMAGE_QUALITIES,
  VIDEO_QUALITIES
} from "./shared.mjs";

export async function startMcpServer() {
  const client = new BridgeClient();
  const server = new McpServer({
    name: "mahatachyons-flow-connector",
    version: "1.0.0"
  });

  server.tool(
    "flow_generate",
    "Generate images or videos on Google Flow (Veo 3.1 / Nano Banana Pro / Omni Flash) via the Mahatachyons Chrome extension.",
    {
      mode: z.enum(GENERATION_MODES).default("flow-image").describe("Google Flow generation mode"),
      prompt: z.string().default("").describe("Text prompt for generation"),
      imagePaths: z.array(z.string()).optional().describe("Local file paths for reference images/frames/videos"),
      assetRefs: z.array(z.string()).optional().describe("Existing project asset names to attach"),
      characterRefs: z.array(z.string()).optional().describe("Existing project character names to attach"),
      characterName: z.string().optional().describe("Character name for flow-create-character or flow-set-voice"),
      voiceFilter: z.string().optional().describe("Preset voice filter for flow-set-voice"),
      newAssetName: z.string().optional().describe("New asset name for flow-rename-asset"),
      imageModel: z.enum(FLOW_MODELS).optional().describe("Flow model to select"),
      aspectRatio: z.enum(ASPECT_RATIOS).optional().describe("Aspect ratio"),
      videoOption: z.enum(VIDEO_DURATIONS).optional().describe("Video duration"),
      videoResolution: z.enum(VIDEO_RESOLUTIONS).optional().describe("Video resolution"),
      outputsPerPrompt: z.number().int().min(1).max(4).optional().describe("Number of outputs (1-4)"),
      downloadImageQuality: z.enum(IMAGE_QUALITIES).optional().describe("1k or 2k upscaled download"),
      downloadVideoQuality: z.enum(VIDEO_QUALITIES).optional().describe("720p or 1080p upscaled download"),
      newProject: z.boolean().optional().describe("Start in a fresh Flow project"),
      outputDir: z.string().optional().describe("Subfolder under ~/Downloads"),
      filenamePrefix: z.string().optional().describe("Prefix for saved files"),
      wait: z.boolean().default(true).describe("Wait for generation to complete before returning")
    },
    async (args) => {
      const created = await client.createJob({
        mode: args.mode,
        prompt: args.prompt,
        imagePaths: args.imagePaths ?? [],
        assetRefs: args.assetRefs,
        characterRefs: args.characterRefs,
        characterName: args.characterName,
        voiceFilter: args.voiceFilter,
        newAssetName: args.newAssetName,
        outputDir: args.outputDir,
        filenamePrefix: args.filenamePrefix,
        params: {
          imageModel: args.imageModel,
          aspectRatio: args.aspectRatio,
          videoOption: args.videoOption,
          videoResolution: args.videoResolution,
          outputsPerPrompt: args.outputsPerPrompt,
          downloadImageQuality: args.downloadImageQuality,
          downloadVideoQuality: args.downloadVideoQuality,
          newProject: args.newProject
        }
      });

      if (!args.wait) {
        return {
          content: [{ type: "text", text: JSON.stringify(created.job, null, 2) }]
        };
      }

      const finished = await client.waitJob(created.job.id);
      return {
        content: [{ type: "text", text: JSON.stringify(finished.job, null, 2) }],
        isError: finished.job.status !== "done"
      };
    }
  );

  server.tool(
    "flow_status",
    "Get the status of the local bridge, Mahatachyons Chrome extension, Google Flow tab, and job queue.",
    {},
    async () => {
      const res = await client.getStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    }
  );

  server.tool(
    "flow_list_jobs",
    "List queued, running, completed, and failed Flow jobs.",
    {},
    async () => {
      const res = await client.listJobs();
      return {
        content: [{ type: "text", text: JSON.stringify(res.jobs, null, 2) }]
      };
    }
  );

  server.tool(
    "flow_get_job",
    "Inspect a specific Flow job by ID.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const res = await client.getJob(jobId);
      return {
        content: [{ type: "text", text: JSON.stringify(res.job, null, 2) }]
      };
    }
  );

  server.tool(
    "flow_cancel_job",
    "Cancel a queued or running Flow job by ID.",
    { jobId: z.string() },
    async ({ jobId }) => {
      const res = await client.cancelJob(jobId);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    }
  );

  server.tool(
    "flow_stop",
    "Emergency stop all running and queued Flow jobs.",
    {},
    async () => {
      const res = await client.stopAll();
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    }
  );

  server.tool(
    "flow_healthcheck",
    "Run a DOM selector healthcheck on the open Google Flow tab.",
    {},
    async () => {
      const res = await client.runHealthcheck();
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}


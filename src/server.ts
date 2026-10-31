import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, TranscriptDockClient, validIdempotencyKey, waitForJob, waitForVideoDiscovery } from "./client.js";
import type { CreateVideoDiscoveryInput } from "./client.js";

function jsonContent(value: unknown, retrieval = "Repeat the same tool call to fetch a fresh bounded result.") {
  const text = JSON.stringify(value, null, 2) ?? "null";
  if (text.length <= MAX_OUTPUT_CHARS) {
    // Hosts that read structuredContent get the object; others get the text.
    const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    return { content: [{ type: "text" as const, text }], ...(structured ? { structuredContent: structured } : {}) };
  }
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        truncated: true,
        returned_characters: MAX_PREVIEW_CHARS,
        total_characters: text.length,
        retrieval,
        preview: text.slice(0, MAX_PREVIEW_CHARS),
      }, null, 2),
    }],
  };
}

function textContent(text: string, retrieval = "Repeat the same tool call to fetch a fresh bounded result.") {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { content: [{ type: "text" as const, text }] };
  }
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        truncated: true,
        returned_characters: MAX_PREVIEW_CHARS,
        total_characters: text.length,
        retrieval,
        preview: text.slice(0, MAX_PREVIEW_CHARS),
      }, null, 2),
    }],
  };
}

function errorContent(error: unknown, client: TranscriptDockClient) {
  const message = client.redactText(error instanceof ApiError ? error.describe() : (error as Error).message);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const VIDEO_DISCOVERY_RETRIEVAL = "Call get_video_discovery with the id to refresh its state.";
const JOB_RETRIEVAL = "Call get_job with the returned job id to refresh its state.";
const TRANSCRIPT_RETRIEVAL = "Call get_transcript again with a bounded format (text, srt, or vtt).";
const MAX_OUTPUT_CHARS = 24_000;
const MAX_PREVIEW_CHARS = 12_000;
const discoveryLimitSchema = z.number().int().min(1).max(50);
const discoveryCursorSchema = z.string().min(1).max(4096);
const discoveryTimeoutSchema = z.number().int().min(1).max(300);
const discoveryIdSchema = z.string().uuid();
const discoveryQuerySchema = z.string().min(1).max(200);
const discoveryChannelSchema = z.string().min(1).max(256);
const discoveryPlaylistSchema = z.string().min(1).max(256);
const discoveryUserSchema = z.string().min(1).max(256);
const videoAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

async function runVideoDiscovery(
  client: TranscriptDockClient,
  input: CreateVideoDiscoveryInput,
  timeoutSeconds?: number,
) {
  const created = await client.createVideoDiscovery(input, randomUUID());
  const result = await waitForVideoDiscovery(client, created.id, timeoutSeconds ?? 60);
  if (result.timed_out) {
    return jsonContent({ ...result.discovery, timed_out: true, retrieval: VIDEO_DISCOVERY_RETRIEVAL }, VIDEO_DISCOVERY_RETRIEVAL);
  }
  if (result.discovery.status === "failed") {
    return { ...jsonContent(result.discovery, VIDEO_DISCOVERY_RETRIEVAL), isError: true as const };
  }
  return jsonContent(result.discovery, VIDEO_DISCOVERY_RETRIEVAL);
}

export interface ServerOptions {
  /** Upper bound for any single tool wait; remote (HTTP) hosting sets this under the function time cap. */
  maxWaitSeconds?: number;
}

export function createServer(client: TranscriptDockClient, options: ServerOptions = {}): McpServer {
  const clampWait = (requested: number) => Math.min(requested, options.maxWaitSeconds ?? Infinity);
  const server = new McpServer({ name: "transcriptdock", version: "0.1.2" }, {
    instructions: [
      "TranscriptDock returns transcripts for YouTube and TikTok videos: existing captions (1 credit per transcript) or AI transcription of the audio (2 credits per started minute) when a workspace has it enabled.",
      "For a single video URL call get_video_transcript: it submits, waits and returns the text in one step.",
      "Use transcribe + wait_for_job + get_transcript only when you need the job id early or want SRT/VTT/segments later.",
      "Results over the output cap are truncated with a preview; ask for format text to keep transcripts compact.",
      "Discovery tools (search_youtube, list_channel_videos, get_channel_latest_videos, search_channel_videos, list_playlist_videos, list_tiktok_user_videos) find videos; they do not transcribe.",
    ].join(" "),
  });

  // Captions remain the default. language and max_credits only matter for auto and
  // transcribe modes. The API enforces the deployment capability and plan gates.
  server.registerTool(
    "transcribe",
    {
      description: "Submit a YouTube or TikTok URL to TranscriptDock and return the created job. captions_only costs 1 credit; auto uses captions when the video has them (1 credit) and AI transcription otherwise; transcribe always runs AI transcription (2 credits per started minute, paid plans).",
      inputSchema: {
        url: z.string().url().describe("YouTube or TikTok video URL."),
        mode: z.enum(["captions_only", "auto", "transcribe"]).optional().describe("Default captions_only (1 credit). auto: captions if present, else AI transcription. transcribe: always AI transcription (2 credits per started minute)."),
        language: z.string().max(35).optional().describe("Spoken language hint for AI transcription (BCP 47, e.g. en). Omit to auto detect."),
        max_credits: z.number().int().min(1).optional().describe("Cap for one AI transcription job; the job fails with BUDGET_EXCEEDED before any charge if the measured cost is higher."),
        idempotency_key: z.string().refine(validIdempotencyKey, "idempotency_key must be 8 to 128 printable ASCII characters").describe("Stable printable ASCII key for this submission."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const,
    },
    async ({ url, mode, language, max_credits, idempotency_key }) => {
      try {
        const job = await client.createJob({ url, mode: mode ?? "captions_only", language: language ?? null, max_credits: max_credits ?? null }, idempotency_key);
        return jsonContent(job, JOB_RETRIEVAL);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "get_video_transcript",
    {
      description: "Get the transcript of a YouTube or TikTok video in one step: submits a job, waits for it (long polling), and returns the transcript text (or srt/vtt/segments). Use this for 'what does this video say' questions. Default mode captions_only (1 credit); pass mode auto to fall back to AI transcription when the video has no captions. Same video and options are served from cache without a new charge.",
      inputSchema: {
        url: z.string().url().describe("YouTube or TikTok video URL."),
        mode: z.enum(["captions_only", "auto", "transcribe"]).optional().describe("Default captions_only (1 credit). auto: captions if present, else AI transcription (2 credits per started minute, paid plans)."),
        format: z.enum(["text", "srt", "vtt", "segments"]).optional().describe("text (default) is the most compact; segments returns timed JSON."),
        timeout_seconds: z.number().int().min(5).max(600).optional().describe("Give up after this many seconds (default 120) and return the job state instead."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const,
    },
    async ({ url, mode, format, timeout_seconds }) => {
      try {
        const input = { url, mode: mode ?? "captions_only", language: null, max_credits: null } as const;
        // Deterministic key: the same URL and mode from the same agent replays the job.
        const key = `mcp-${createHash("sha256").update(`${input.mode}:${url}`).digest("hex").slice(0, 32)}`;
        const resolved = format ?? "text";
        const read = async (resultId: string) => resolved === "segments"
          ? jsonContent(await client.getTranscript(resultId), TRANSCRIPT_RETRIEVAL)
          : textContent(await client.exportTranscript(resultId, resolved === "text" ? "txt" : resolved), TRANSCRIPT_RETRIEVAL);
        const fresh = () => client.createJob(input, `${key}-${Date.now()}`);
        let created = await client.createJob(input, key);
        // The stable key replays for 48h; a replayed failure gets a fresh submission.
        let isFresh = created.status === "failed";
        if (isFresh) created = await fresh();
        for (;;) {
          const result = await waitForJob(client, created.id, clampWait(timeout_seconds ?? 120), { serverWaitSeconds: 25, pollIntervalMs: 1000 });
          if (result.timed_out || result.job.status !== "succeeded" || !result.job.result_id) {
            return { ...jsonContent({ ...result.job, timed_out: result.timed_out, retrieval: JOB_RETRIEVAL }, JOB_RETRIEVAL), isError: (result.job.status === "failed") as true };
          }
          try {
            return await read(result.job.result_id);
          } catch (error) {
            // A replayed job can point at a transcript the user deleted since; submit once more.
            if (isFresh || !(error instanceof ApiError && error.code === "NOT_FOUND")) throw error;
            created = await fresh();
            isFresh = true;
          }
        }
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "get_job",
    {
      description: "Look up a TranscriptDock job's status, stage, error, and billing by ID.",
      inputSchema: {
        job_id: z.string().uuid().describe("The job ID returned by transcribe or list_jobs."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    },
    async ({ job_id }) => {
      try {
        const job = await client.getJob(job_id);
        return jsonContent(job, JOB_RETRIEVAL);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "get_transcript",
    {
      description: "Fetch a completed transcript by ID, as normalized JSON segments or as a text/SRT/VTT export.",
      inputSchema: {
        transcript_id: z.string().uuid().describe("The transcript ID from a succeeded job's result_id."),
        format: z
          .enum(["text", "segments", "srt", "vtt"])
          .optional()
          .describe("segments (default) returns the full normalized JSON result. text, srt, and vtt return the corresponding export file body."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    },
    async ({ transcript_id, format }) => {
      try {
        const resolved = format ?? "segments";
        if (resolved === "segments") {
          const transcript = await client.getTranscript(transcript_id);
          return jsonContent(transcript, TRANSCRIPT_RETRIEVAL);
        }
        const exportFormat = resolved === "text" ? "txt" : resolved;
        const body = await client.exportTranscript(transcript_id, exportFormat);
        return textContent(body, TRANSCRIPT_RETRIEVAL);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "list_jobs",
    {
      description: "List jobs for the workspace, newest first, with cursor pagination.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100. Defaults to 20."),
        cursor: z.string().optional().describe("Opaque cursor from a previous list_jobs call's next_cursor."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    },
    async ({ limit, cursor }) => {
      try {
        const jobs = await client.listJobs({ limit, cursor });
        return jsonContent(jobs, "Pass next_cursor unchanged to list_jobs for the next page. The cursor is opaque.");
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "wait_for_job",
    {
      description: "Wait for a job to reach a terminal status (succeeded, failed, or cancelled) using API long polling, then return it.",
      inputSchema: {
        job_id: z.string().uuid().describe("The job ID to wait on."),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(1800)
          .optional()
          .describe("Give up after this many seconds and return the last known job state. Defaults to 300, max 1800."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    },
    async ({ job_id, timeout_seconds }) => {
      try {
        const job = await waitForJob(client, job_id, clampWait(timeout_seconds ?? 300), { serverWaitSeconds: 25, pollIntervalMs: 1000 });
        return jsonContent(job, JOB_RETRIEVAL);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "search_youtube",
    {
      description: "Search YouTube videos by query and return the listing. Pass cursor unchanged for the next page.",
      inputSchema: {
        query: discoveryQuerySchema.describe("Search text from 1 to 200 characters."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50."),
        cursor: discoveryCursorSchema.optional().describe("Opaque cursor from a previous call."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ query, limit, cursor, timeout_seconds }) => {
      try {
        return await runVideoDiscovery(client, { kind: "youtube_search", query, limit, cursor }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "list_channel_videos",
    {
      description: "List videos from one YouTube channel and return the listing. Pass cursor unchanged for the next page.",
      inputSchema: {
        channel: discoveryChannelSchema.describe("Channel handle or channel id."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50."),
        cursor: discoveryCursorSchema.optional().describe("Opaque cursor from a previous call."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ channel, limit, cursor, timeout_seconds }) => {
      try {
        return await runVideoDiscovery(client, { kind: "youtube_channel_videos", channel, limit, cursor }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "get_channel_latest_videos",
    {
      description: "Get the latest videos from one YouTube channel. The channel videos tab is newest first.",
      inputSchema: {
        channel: discoveryChannelSchema.describe("Channel handle or channel id."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50. Defaults to 10."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ channel, limit, timeout_seconds }) => {
      try {
        return await runVideoDiscovery(client, { kind: "youtube_channel_videos", channel, limit: limit ?? 10 }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "search_channel_videos",
    {
      description: "Search videos within one YouTube channel and return the listing. Pass cursor unchanged for the next page.",
      inputSchema: {
        channel: discoveryChannelSchema.describe("Channel handle or channel id."),
        query: discoveryQuerySchema.describe("Search text from 1 to 200 characters."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50."),
        cursor: discoveryCursorSchema.optional().describe("Opaque cursor from a previous call."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ channel, query, limit, cursor, timeout_seconds }) => {
      try {
        return await runVideoDiscovery(client, { kind: "youtube_channel_search", channel, query, limit, cursor }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "list_playlist_videos",
    {
      description: "List videos from one YouTube playlist and return the listing. Pass cursor unchanged for the next page.",
      inputSchema: {
        playlist: discoveryPlaylistSchema.describe("Playlist id."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50."),
        cursor: discoveryCursorSchema.optional().describe("Opaque cursor from a previous call."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ playlist, limit, cursor, timeout_seconds }) => {
      try {
        return await runVideoDiscovery(client, { kind: "youtube_playlist_videos", playlist, limit, cursor }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "list_tiktok_user_videos",
    {
      description: "List TikTok videos for one user. TikTok search is not available. TikTok returns at most 10 videos from its embed page and no further pages. Set include_details to also fetch each video page for full stats, dates, hashtags, and music.",
      inputSchema: {
        user: discoveryUserSchema.describe("TikTok @handle (the @ is added when missing) or profile URL."),
        limit: discoveryLimitSchema.optional().describe("Page size from 1 to 50."),
        include_details: z.boolean().optional().describe("Fetch each video page for full TikTok data. Limit is capped at 10."),
        timeout_seconds: discoveryTimeoutSchema.optional().describe("Timeout from 1 to 300 seconds. Defaults to 60."),
      },
      annotations: videoAnnotations,
    },
    async ({ user, limit, include_details, timeout_seconds }) => {
      try {
        // The API wants @handle or a profile URL; agents often send the bare handle.
        const handle = /^[A-Za-z0-9._]+$/.test(user) ? `@${user}` : user;
        return await runVideoDiscovery(client, { kind: "tiktok_user_videos", user: handle, limit, include_details }, timeout_seconds);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  server.registerTool(
    "get_video_discovery",
    {
      description: "Get one video discovery by ID, including status, videos, cursor, and error.",
      inputSchema: {
        id: discoveryIdSchema.describe("The video discovery ID returned by a listing tool."),
      },
      annotations: videoAnnotations,
    },
    async ({ id }) => {
      try {
        return jsonContent(await client.getVideoDiscovery(id), VIDEO_DISCOVERY_RETRIEVAL);
      } catch (error) {
        return errorContent(error, client);
      }
    }
  );

  return server;
}

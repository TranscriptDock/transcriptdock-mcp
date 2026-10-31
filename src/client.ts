import { z } from "zod";

const USER_AGENT = "transcriptdock-mcp/0.1.3";
const MAX_WAIT_SECONDS = 1800;
const MAX_VIDEO_WAIT_SECONDS = 300;
const platformSchema = z.enum(["youtube", "tiktok", "instagram", "upload", "direct"]);
const modeSchema = z.enum(["captions_only", "auto", "transcribe"]);
const jobStatusSchema = z.enum(["queued", "processing", "awaiting_provider", "succeeded", "failed", "cancelled"]);
const apiErrorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), retry_after_seconds: z.number().int().positive().optional(), details: z.record(z.string(), z.unknown()).optional() }).passthrough();
const jobSchema = z.object({
  id: z.string(), status: jobStatusSchema, stage: z.enum(["resolve", "captions", "acquire_audio", "submit_asr", "wait_asr", "finalize"]).nullable(), result_id: z.string().nullable(), error: apiErrorSchema.nullable(),
  billing: z.object({ credits_reserved: z.number(), credits_charged: z.number(), kind: z.enum(["captions", "ai_transcription", "cached"]) }),
  source: z.object({ platform: platformSchema.optional(), media_id: z.string().nullable().optional(), canonical_url: z.string().nullable().optional(), title: z.string().nullable().optional(), upload_id: z.string().nullable().optional() }).passthrough().optional(),
  options: z.object({ mode: modeSchema.optional(), language: z.string().nullable().optional(), caption_preference: z.string().optional() }).passthrough().optional(), created_at: z.string(),
}).passthrough();
const jobListSchema = z.object({ items: z.array(jobSchema), next_cursor: z.string().nullable() }).passthrough();
const capabilityPlatformSchema = z.object({ captions_only: z.boolean(), auto: z.boolean(), transcribe: z.boolean(), social_acquisition_fee: z.boolean(), native_captions: z.enum(["unverified_disabled", "supported"]).optional() }).passthrough();
const capabilitiesSchema = z.object({ youtube: capabilityPlatformSchema, tiktok: capabilityPlatformSchema, instagram: capabilityPlatformSchema, upload: capabilityPlatformSchema, direct: capabilityPlatformSchema, max_duration_ms: z.number(), max_media_bytes: z.number(), export_formats: z.array(z.string()), recognition_profiles: z.array(z.string()) }).passthrough();
const transcriptSchema = z.object({
  id: z.string(), source: z.object({ platform: platformSchema, media_id: z.string(), canonical_url: z.string().nullable().optional(), title: z.string().nullable().optional() }).passthrough(),
  source_origin: z.enum(["creator_captions", "platform_captions", "speech_recognition"]), language: z.string().nullable(), text: z.string(), segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough()),
  words: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), confidence: z.number().optional() }).passthrough()).nullable(), timing_granularity: z.enum(["word", "segment", "none"]), duration_seconds: z.number().nullable(),
  recognition: z.object({ profile: z.string().optional(), model: z.string().optional(), quality_status: z.enum(["validated_language", "provider_supported", "experimental_language"]).optional() }).passthrough().nullable(), extraction_version: z.string(), created_at: z.string(),
}).passthrough();
const exportFormatSchema = z.enum(["txt", "json", "srt", "vtt"]);
const videoDiscoveryKindSchema = z.enum(["youtube_search", "youtube_channel_videos", "youtube_channel_search", "youtube_playlist_videos", "tiktok_user_videos"]);
const videoDiscoveryStatusSchema = z.enum(["queued", "processing", "succeeded", "failed"]);
const videoDiscoveryVideoSchema = z.object({
  platform: z.enum(["youtube", "tiktok"]), video_id: z.string(), url: z.string(), title: z.string().nullable(), channel_id: z.string().nullable(), channel_title: z.string().nullable(), duration_s: z.number().int().nullable(), published_at: z.string().nullable(), published_text: z.string().nullable(), view_count: z.number().int().nullable(), view_count_text: z.string().nullable(), thumbnail_url: z.string().nullable(),
}).passthrough();
const videoDiscoverySchema = z.object({
  id: z.string(), kind: videoDiscoveryKindSchema, status: videoDiscoveryStatusSchema, request: z.record(z.string(), z.unknown()), videos: z.array(videoDiscoveryVideoSchema), next_cursor: z.string().nullable(), error: apiErrorSchema.nullable(), created_at: z.string(), updated_at: z.string(), expires_at: z.string(),
}).passthrough();

export type Job = z.infer<typeof jobSchema>;
export type JobList = z.infer<typeof jobListSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type JobMode = z.infer<typeof modeSchema>;
export type VideoDiscoveryKind = z.infer<typeof videoDiscoveryKindSchema>;
export type VideoDiscoveryStatus = z.infer<typeof videoDiscoveryStatusSchema>;
export type VideoDiscoveryVideo = z.infer<typeof videoDiscoveryVideoSchema>;
export type VideoDiscovery = z.infer<typeof videoDiscoverySchema>;
export interface CreateVideoDiscoveryInput { kind: VideoDiscoveryKind; query?: string; channel?: string; playlist?: string; user?: string; limit?: number; cursor?: string; include_details?: boolean; }
export interface CreateJobInput { url: string; mode: JobMode; language: string | null; max_credits: number | null; }
export interface ClientConfig { apiKey: string; baseUrl: string; }

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly requestId?: string, readonly retryAfterSeconds?: number, readonly details?: Record<string, unknown>) { super(message); this.name = "ApiError"; }
  describe(): string { return this.requestId ? `${this.code}: ${this.message} (request ${this.requestId})` : `${this.code}: ${this.message}`; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.slice(1).every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}
export function validateBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("TRANSCRIPTDOCK_BASE_URL must be a valid HTTPS URL or an explicit loopback HTTP URL."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("TRANSCRIPTDOCK_BASE_URL cannot contain credentials, a query, or a fragment.");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) throw new Error("TRANSCRIPTDOCK_BASE_URL must use HTTPS. HTTP is allowed only for loopback local development.");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const apiKey = env.TRANSCRIPTDOCK_API_KEY;
  if (!apiKey) throw new Error("TRANSCRIPTDOCK_API_KEY is required. Set it in the MCP server environment.");
  if (/[\r\n]/.test(apiKey)) throw new Error("TRANSCRIPTDOCK_API_KEY cannot contain line breaks.");
  if (!env.TRANSCRIPTDOCK_BASE_URL) throw new Error("TRANSCRIPTDOCK_BASE_URL is required and must be an HTTPS URL.");
  return { apiKey, baseUrl: validateBaseUrl(env.TRANSCRIPTDOCK_BASE_URL) };
}
export function validIdempotencyKey(value: string): boolean { return value.length >= 8 && value.length <= 128 && /^[\x20-\x7E]+$/.test(value); }
function parseJson(value: string): unknown { try { return value.trim() ? JSON.parse(value) : undefined; } catch { return undefined; } }
function toApiError(bodyText: string, status: number): ApiError {
  const parsed = parseJson(bodyText); const envelope = isRecord(parsed) ? parsed : undefined; const error = envelope && isRecord(envelope.error) ? envelope.error : undefined;
  return new ApiError(error && typeof error.code === "string" ? error.code : "HTTP_ERROR", error && typeof error.message === "string" ? error.message : `Request failed with status ${status}.`, error && typeof error.retryable === "boolean" ? error.retryable : status >= 500 || status === 429, envelope && typeof envelope.request_id === "string" ? envelope.request_id : undefined, typeof error?.retry_after_seconds === "number" ? error.retry_after_seconds : undefined, isRecord(error?.details) ? error.details : undefined);
}
function normalizeTranscriptWords(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.words)) return value;
  return { ...value, words: value.words.map((word) => {
    if (!isRecord(word) || word.start !== undefined || word.end !== undefined || typeof word.start_ms !== "number" || typeof word.end_ms !== "number") return word;
    const { start_ms, end_ms, ...rest } = word;
    return { ...rest, start: start_ms / 1000, end: end_ms / 1000 };
  }) };
}

export class TranscriptDockClient {
  constructor(private readonly config: ClientConfig, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  redactText(value: string): string { return value.split(this.config.apiKey).join("[REDACTED]").replace(/td_live_[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/https?:\/\/[^\s"'<>]+[?&](?:token|signature|sig|x-amz-signature|x-amz-credential|api[_-]?key)=[^\s&"'<>]*/gi, "[REDACTED_URL]"); }
  private headers(init?: RequestInit): Headers { const headers = new Headers(init?.headers); headers.set("authorization", `Bearer ${this.config.apiKey}`); headers.set("accept", "application/json"); headers.set("user-agent", USER_AGENT); if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json"); return headers; }
  private async requestText(path: string, init?: RequestInit): Promise<string> {
    let response: Response;
    let bodyText: string;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, { ...init, headers: this.headers(init) });
      bodyText = await response.text();
    } catch {
      throw new ApiError("NETWORK_ERROR", "Could not reach TranscriptDock.", true);
    }
    if (!response.ok) throw toApiError(bodyText, response.status);
    return bodyText;
  }
  private async requestJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, prepare: (value: unknown) => unknown = (value) => value): Promise<T> {
    const bodyText = await this.requestText(path, init);
    const parsed = schema.safeParse(prepare(parseJson(bodyText)));
    if (!parsed.success) throw new ApiError("INVALID_RESPONSE", "TranscriptDock returned a response outside its public contract.", false);
    return parsed.data;
  }
  listCapabilities(): Promise<Capabilities> { return this.requestJson("/v1/capabilities", capabilitiesSchema); }
  createJob(input: CreateJobInput, idempotencyKey: string): Promise<Job> { if (!validIdempotencyKey(idempotencyKey)) throw new Error("idempotency_key must be 8 to 128 printable ASCII characters."); const body: Record<string, unknown> = { source: { url: input.url }, mode: input.mode, language: input.language }; if (input.max_credits !== null) body.max_credits = input.max_credits; return this.requestJson("/v1/jobs", jobSchema, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) }); }
  getJob(jobId: string, waitSeconds = 0): Promise<Job> { return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}${waitSeconds > 0 ? `?wait=${waitSeconds}` : ""}`, jobSchema); }
  listJobs(params: { limit?: number; cursor?: string } = {}): Promise<JobList> { const query = new URLSearchParams(); if (params.cursor !== undefined) query.set("cursor", params.cursor); if (params.limit !== undefined) query.set("limit", String(params.limit)); return this.requestJson(`/v1/jobs${query.size ? `?${query.toString()}` : ""}`, jobListSchema); }
  getTranscript(transcriptId: string): Promise<Transcript> { return this.requestJson(`/v1/transcripts/${encodeURIComponent(transcriptId)}`, transcriptSchema, undefined, normalizeTranscriptWords); }
  exportTranscript(transcriptId: string, format: ExportFormat): Promise<string> { return this.requestText(`/v1/transcripts/${encodeURIComponent(transcriptId)}/export?format=${format}`); }
  cancelJob(jobId: string): Promise<Job> { return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, jobSchema, { method: "POST" }); }
  retryJob(jobId: string, idempotencyKey: string, maxCredits: number | null): Promise<Job> { if (!validIdempotencyKey(idempotencyKey)) throw new Error("idempotency_key must be 8 to 128 printable ASCII characters."); return this.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/retry`, jobSchema, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(maxCredits === null ? {} : { max_credits: maxCredits }) }); }
  createVideoDiscovery(input: CreateVideoDiscoveryInput, idempotencyKey: string): Promise<VideoDiscovery> { if (!validIdempotencyKey(idempotencyKey)) throw new Error("idempotency_key must be 8 to 128 printable ASCII characters."); const body: Record<string, unknown> = { kind: input.kind }; if (input.query !== undefined) body.query = input.query; if (input.channel !== undefined) body.channel = input.channel; if (input.playlist !== undefined) body.playlist = input.playlist; if (input.user !== undefined) body.user = input.user; if (input.limit !== undefined) body.limit = input.limit; if (input.cursor !== undefined) body.cursor = input.cursor; if (input.include_details !== undefined) body.include_details = input.include_details; return this.requestJson("/v1/video-discoveries", videoDiscoverySchema, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) }); }
  getVideoDiscovery(discoveryId: string): Promise<VideoDiscovery> { return this.requestJson(`/v1/video-discoveries/${encodeURIComponent(discoveryId)}`, videoDiscoverySchema); }
}

export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const TERMINAL_VIDEO_DISCOVERY_STATUSES = new Set(["succeeded", "failed"]);
export interface WaitResult { job: Job; timed_out: boolean; }
export interface WaitVideoDiscoveryResult { discovery: VideoDiscovery; timed_out: boolean; }
export interface WaitOptions { pollIntervalMs?: number; sleep?: (milliseconds: number) => Promise<void>; now?: () => number; /** GET /v1/jobs/{id}?wait= long poll held by the API per request. */ serverWaitSeconds?: number; }
export async function waitForJob(client: TranscriptDockClient, jobId: string, timeoutSeconds: number, options: WaitOptions = {}): Promise<WaitResult> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_SECONDS) throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_WAIT_SECONDS}.`);
  const pollIntervalMs = options.pollIntervalMs ?? 3000; if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("poll interval must be a positive integer.");
  const wait = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))); const now = options.now ?? Date.now; const deadline = now() + timeoutSeconds * 1000; const maxPolls = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) { const job = await client.getJob(jobId, Math.max(0, Math.min(options.serverWaitSeconds ?? 0, Math.floor((deadline - now()) / 1000)))); if (TERMINAL_JOB_STATUSES.has(job.status)) return { job, timed_out: false }; if (attempt === maxPolls - 1 || now() >= deadline) return { job, timed_out: true }; await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now()))); }
  throw new Error("Polling stopped at its safety limit without a final job state.");
}
export async function waitForVideoDiscovery(client: TranscriptDockClient, discoveryId: string, timeoutSeconds: number, options: WaitOptions = {}): Promise<WaitVideoDiscoveryResult> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_VIDEO_WAIT_SECONDS) throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_VIDEO_WAIT_SECONDS}.`);
  const pollIntervalMs = options.pollIntervalMs ?? 2000; if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("poll interval must be a positive integer.");
  const wait = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))); const now = options.now ?? Date.now; const deadline = now() + timeoutSeconds * 1000; const maxPolls = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) { const discovery = await client.getVideoDiscovery(discoveryId); if (TERMINAL_VIDEO_DISCOVERY_STATUSES.has(discovery.status)) return { discovery, timed_out: false }; if (attempt === maxPolls - 1 || now() >= deadline) return { discovery, timed_out: true }; await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now()))); }
  throw new Error("Polling stopped at its safety limit without a final discovery state.");
}

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { TranscriptDockClient, loadConfig, validateBaseUrl } from "../src/client.js";

const API_KEY = "td_live_launch_safety_secret";

const job = {
  id: "11111111-1111-4111-8111-111111111111", status: "queued", stage: null, result_id: null, error: null,
  billing: { credits_reserved: 0, credits_charged: 0, kind: "captions" },
  source: { platform: "youtube", canonical_url: "https://www.youtube.com/watch?v=example" },
  options: { mode: "captions_only", language: null, caption_preference: "prefer_creator" }, created_at: "2026-09-14T00:00:00.000Z",
};

const bigTranscript = {
  id: "22222222-2222-4222-8222-222222222222",
  source: { platform: "youtube", media_id: "example", canonical_url: "https://www.youtube.com/watch?v=example", title: "Example" },
  source_origin: "creator_captions", language: "en", text: "x".repeat(30_000),
  segments: [{ start: 0, end: 60, text: "x".repeat(30_000) }],
  words: null, timing_granularity: "segment", duration_seconds: 60,
  recognition: null, extraction_version: "test", created_at: "2026-09-14T00:00:00.000Z",
};

const response = (body: unknown, status = 200) => new Response(
  typeof body === "string" ? body : JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } },
);

async function connected(fetchImpl: typeof fetch) {
  const apiClient = new TranscriptDockClient({ apiKey: API_KEY, baseUrl: "https://api.example.test" }, fetchImpl);
  const server = createServer(apiClient);
  const client = new Client({ name: "launch-safety-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const textOf = (result: unknown) => {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content.find((item) => item.type === "text");
  if (!content?.text) throw new Error("tool did not return text content");
  return content.text;
};

test("transcribe defaults to captions and every tool carries annotations", async () => {
  const client = await connected(async () => response(job, 202));
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const transcribe = byName.get("transcribe");
  assert.ok(transcribe, "transcribe tool is registered");
  const props = Object.keys(transcribe!.inputSchema.properties ?? {});
  assert.equal(props.includes("language"), true);
  assert.equal(props.includes("max_credits"), true);
  assert.deepEqual((transcribe!.inputSchema.properties?.mode as { enum: string[] }).enum, ["captions_only", "auto", "transcribe"]);
  assert.equal(transcribe!.annotations?.idempotentHint, true);
  assert.equal(transcribe!.annotations?.readOnlyHint, false);
  for (const name of ["get_job", "get_transcript", "list_jobs", "wait_for_job", "get_video_discovery"]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} must be readOnly`);
    assert.equal(byName.get(name)?.annotations?.idempotentHint, true, `${name} must be idempotent`);
  }
  await client.close();
});

test("oversized transcript JSON is truncated with a retrieval hint, never raw", async () => {
  const client = await connected(async () => response(bigTranscript));
  const result = await client.callTool({
    name: "get_transcript",
    arguments: { transcript_id: "22222222-2222-4222-8222-222222222222", format: "segments" },
  });
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(textOf(result)) as { truncated?: boolean; total_characters?: number; retrieval?: string; preview?: string };
  assert.equal(parsed.truncated, true);
  assert.ok((parsed.total_characters ?? 0) > 24_000);
  assert.match(parsed.retrieval ?? "", /get_transcript/);
  assert.ok((parsed.preview ?? "").length <= 12_000);
  await client.close();
});

test("oversized export text is truncated with a retrieval hint", async () => {
  const client = await connected(async () => response("y".repeat(30_000)));
  const result = await client.callTool({
    name: "get_transcript",
    arguments: { transcript_id: "22222222-2222-4222-8222-222222222222", format: "text" },
  });
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(textOf(result)) as { truncated?: boolean; total_characters?: number; retrieval?: string };
  assert.equal(parsed.truncated, true);
  assert.ok((parsed.total_characters ?? 0) >= 30_000);
  assert.match(parsed.retrieval ?? "", /bounded/);
  await client.close();
});

test("tool errors never leak the API key", async () => {
  const client = await connected(async () => response({
    error: { code: "FORBIDDEN", message: `Bearer ${API_KEY} rejected`, retryable: false },
    request_id: "33333333-3333-4333-8333-333333333333",
  }, 403));
  const result = await client.callTool({
    name: "get_job",
    arguments: { job_id: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(result.isError, true);
  assert.equal(textOf(result).includes(API_KEY), false);
  await client.close();
});

test("explicit base URL is required and unsafe URLs are rejected", () => {
  assert.throws(() => loadConfig({ TRANSCRIPTDOCK_API_KEY: API_KEY }), /BASE_URL/);
  assert.throws(() => validateBaseUrl("http://api.example.test"), /HTTPS/);
  assert.throws(() => validateBaseUrl("https://user:x@api.example.test"), /credentials/);
  assert.equal(validateBaseUrl("https://transcriptdock.com"), "https://transcriptdock.com");
  assert.equal(validateBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

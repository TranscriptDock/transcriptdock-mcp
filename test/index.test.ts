import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { TranscriptDockClient } from "../src/client.js";

const job = {
  id: "11111111-1111-4111-8111-111111111111", status: "queued", stage: null, result_id: null, error: null,
  billing: { credits_reserved: 0, credits_charged: 0, kind: "captions" },
  source: { platform: "youtube", canonical_url: "https://www.youtube.com/watch?v=example" },
  options: { mode: "captions_only", language: null, caption_preference: "prefer_creator" }, created_at: "2026-09-14T00:00:00.000Z",
};
const response = (body: unknown, status = 202) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The tool exposes AI options while defaulting to captions. The API enforces
// deployment capabilities, workspace plan and the optional credit cap.
async function connected(fetchImpl: typeof fetch) {
  const apiClient = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, fetchImpl);
  const server = createServer(apiClient);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test("transcribe tool exposes the supported job options", async () => {
  const client = await connected(async () => response(job));
  const { tools } = await client.listTools();
  const transcribe = tools.find((t) => t.name === "transcribe");
  assert.ok(transcribe, "transcribe tool is registered");
  const properties = Object.keys(transcribe!.inputSchema.properties ?? {});
  assert.deepEqual(properties.sort(), ["idempotency_key", "language", "max_credits", "mode", "url"]);
  await client.close();
});

test("transcribe defaults mode to captions_only and never sends language or max_credits", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const client = await connected(async (_url, init) => {
    sentBody = JSON.parse((init?.body as string) ?? "{}");
    return response(job);
  });
  const result = await client.callTool({
    name: "transcribe",
    arguments: { url: "https://www.youtube.com/watch?v=example", idempotency_key: "mcp_test_key_1" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(sentBody?.mode, "captions_only");
  assert.equal(sentBody?.language, null);
  assert.equal("max_credits" in (sentBody ?? {}), false);
  await client.close();
});

test("get_video_transcript submits, long polls with ?wait=, and returns the text export", async () => {
  const calls: string[] = [];
  const done = { ...job, status: "succeeded", result_id: "22222222-2222-4222-8222-222222222222" };
  const client = await connected(async (url, init) => {
    const u = String(url); calls.push(`${init?.method ?? "GET"} ${u.replace("https://api.example.test", "")}`);
    if (u.endsWith("/v1/jobs")) return response(job);
    if (u.includes("/v1/jobs/") && u.includes("wait=25")) return response(done, 200);
    if (u.includes("/export?format=txt")) return new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } });
    return response({ error: { code: "NOT_FOUND" } }, 404);
  });
  const result = await client.callTool({ name: "get_video_transcript", arguments: { url: "https://www.youtube.com/watch?v=example" } });
  assert.equal(result.isError, undefined);
  assert.equal((result.content as { text: string }[])[0]!.text, "hello world");
  assert.deepEqual(calls, ["POST /v1/jobs", `GET /v1/jobs/${job.id}?wait=25`, `GET /v1/transcripts/${done.result_id}/export?format=txt`]);
  await client.close();
});

test("server publishes instructions and structuredContent for object results", async () => {
  const client = await connected(async () => response(job, 200));
  assert.match(client.getInstructions() ?? "", /get_video_transcript/);
  const result = await client.callTool({ name: "get_job", arguments: { job_id: job.id } });
  assert.equal((result.structuredContent as { id: string }).id, job.id);
  await client.close();
});

test("get_video_transcript resubmits with a fresh key when the replayed job had failed", async () => {
  const keys: string[] = [];
  const failed = { ...job, status: "failed", error: { code: "SOURCE_BLOCKED", message: "blocked", retryable: true } };
  const done = { ...job, id: "33333333-3333-4333-8333-333333333333", status: "succeeded", result_id: "22222222-2222-4222-8222-222222222222" };
  const client = await connected(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/jobs")) { keys.push(new Headers(init?.headers).get("idempotency-key") ?? ""); return response(keys.length === 1 ? failed : job, keys.length === 1 ? 200 : 202); }
    if (u.includes("/v1/jobs/")) return response(done, 200);
    if (u.includes("/export?format=txt")) return new Response("ok text", { status: 200 });
    return response({ error: { code: "NOT_FOUND" } }, 404);
  });
  const result = await client.callTool({ name: "get_video_transcript", arguments: { url: "https://www.youtube.com/watch?v=example" } });
  assert.equal(result.isError, undefined);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  await client.close();
});

test("get_video_transcript resubmits once when the replayed job's transcript was deleted", async () => {
  const keys: string[] = [];
  const replayed = { ...job, status: "succeeded", result_id: "44444444-4444-4444-8444-444444444444" };
  const fresh = { ...job, id: "33333333-3333-4333-8333-333333333333", status: "succeeded", result_id: "22222222-2222-4222-8222-222222222222" };
  const client = await connected(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/jobs")) { keys.push(new Headers(init?.headers).get("idempotency-key") ?? ""); return response(keys.length === 1 ? replayed : fresh, 200); }
    if (u.includes(`/v1/jobs/${replayed.id}`)) return response(keys.length === 1 ? replayed : fresh, 200);
    if (u.includes(`/v1/jobs/${fresh.id}`)) return response(fresh, 200);
    if (u.includes(`/v1/transcripts/${fresh.result_id}/export`)) return new Response("fresh text", { status: 200 });
    return response({ error: { code: "NOT_FOUND", message: "gone", retryable: false } }, 404);
  });
  const result = await client.callTool({ name: "get_video_transcript", arguments: { url: "https://www.youtube.com/watch?v=example" } });
  assert.equal(result.isError, undefined);
  assert.equal((result.content as { text: string }[])[0]!.text, "fresh text");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  await client.close();
});

test("get_video_transcript reports NOT_FOUND when even the fresh transcript is missing", async () => {
  let posts = 0;
  const done = { ...job, status: "succeeded", result_id: "44444444-4444-4444-8444-444444444444" };
  const client = await connected(async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/jobs")) { posts += 1; return response(done, 200); }
    if (u.includes("/v1/jobs/")) return response(done, 200);
    return response({ error: { code: "NOT_FOUND", message: "gone", retryable: false } }, 404);
  });
  const result = await client.callTool({ name: "get_video_transcript", arguments: { url: "https://www.youtube.com/watch?v=example" } });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /NOT_FOUND/);
  assert.equal(posts, 2);
  await client.close();
});

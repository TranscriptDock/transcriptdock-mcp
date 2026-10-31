import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TranscriptDockClient, waitForVideoDiscovery } from "../src/client.js";
import { createServer } from "../src/index.js";

const DISCOVERY_ID = "44444444-4444-4444-8444-444444444444";
const discovery = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: DISCOVERY_ID, kind: "youtube_search", status, request: { kind: "youtube_search", query: "fixture query", limit: 20 },
  videos: status === "succeeded" ? [{ platform: "youtube", video_id: "abc123", url: "https://www.youtube.com/watch?v=abc123", title: "Fixture video", channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", channel_title: "Fixture channel", duration_s: 61, published_at: null, published_text: "3 days ago", view_count: null, view_count_text: "1.2M views", thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg" }] : [],
  next_cursor: status === "succeeded" ? "opaque/next" : null,
  error: status === "failed" ? { code: "SOURCE_NOT_FOUND", message: "Not found", retryable: false } : null,
  created_at: "2026-09-14T12:00:00.000Z", updated_at: "2026-09-14T12:00:00.000Z", expires_at: "2026-09-15T12:00:00.000Z", ...overrides,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const textOf = (result: unknown) => {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content.find((item) => item.type === "text");
  if (!content?.text) throw new Error("tool did not return text content");
  return content.text;
};
async function connected(fetchImpl: typeof fetch) {
  const apiClient = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, fetchImpl);
  const server = createServer(apiClient);
  const client = new Client({ name: "video-discovery-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test("createVideoDiscovery posts each kind body with an idempotency header", async () => {
  const cases: Array<Record<string, unknown>> = [
    { kind: "youtube_search", query: "cats", limit: 5 },
    { kind: "youtube_channel_videos", channel: "@veritasium", limit: 5 },
    { kind: "youtube_channel_search", channel: "@veritasium", query: "cats", limit: 5 },
    { kind: "youtube_playlist_videos", playlist: "PLxxxxxxxxxxxxxxxxxx", limit: 5 },
    { kind: "tiktok_user_videos", user: "@tiktokuser", limit: 5, include_details: true },
  ];
  for (const body of cases) {
    let header: string | null = null;
    let sent: Record<string, unknown> | undefined;
    const client = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async (_url, init) => {
      header = new Headers(init?.headers).get("idempotency-key");
      sent = JSON.parse((init?.body as string) ?? "{}");
      return response(discovery("queued", { kind: body.kind }));
    });
    await client.createVideoDiscovery(body as never, "video_key_12345");
    assert.equal(header, "video_key_12345");
    assert.deepEqual(sent, body);
  }
});

test("cursor is forwarded unchanged", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async (_url, init) => {
    sent = JSON.parse((init?.body as string) ?? "{}");
    return response(discovery("queued"));
  });
  await client.createVideoDiscovery({ kind: "youtube_search", query: "cats", cursor: "opaque/abc" }, "video_key_12345");
  assert.equal(sent?.cursor, "opaque/abc");
});

test("waitForVideoDiscovery stops on succeeded and on failed, and times out", async () => {
  const ok = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async () => response(discovery("succeeded")));
  assert.equal((await waitForVideoDiscovery(ok, DISCOVERY_ID, 60, { pollIntervalMs: 10, sleep: async () => undefined })).timed_out, false);
  const failed = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async () => response(discovery("failed")));
  const failedResult = await waitForVideoDiscovery(failed, DISCOVERY_ID, 60, { pollIntervalMs: 10, sleep: async () => undefined });
  assert.equal(failedResult.timed_out, false);
  assert.equal(failedResult.discovery.status, "failed");
  let calls = 0;
  const slow = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async () => { calls += 1; return response(discovery("processing")); });
  const timed = await waitForVideoDiscovery(slow, DISCOVERY_ID, 1, { pollIntervalMs: 1000, now: () => 0, sleep: async () => undefined });
  assert.equal(timed.timed_out, true);
  assert.equal(calls, 2);
});

test("search_youtube polls to succeeded and forwards cursor unchanged", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = await connected(async (url, init) => {
    if (String(url).endsWith("/v1/video-discoveries") && init?.method === "POST") { sent = JSON.parse((init?.body as string) ?? "{}"); return response(discovery("queued", { kind: sent.kind }), 202); }
    return response(discovery("succeeded"));
  });
  const result = await client.callTool({ name: "search_youtube", arguments: { query: "cats", limit: 5, cursor: "opaque/abc" } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(textOf(result)).videos.length, 1);
  assert.equal(sent?.cursor, "opaque/abc");
  await client.close();
});

test("get_channel_latest_videos sends no cursor and defaults limit to 10", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = await connected(async (url, init) => {
    if (String(url).endsWith("/v1/video-discoveries") && init?.method === "POST") { sent = JSON.parse((init?.body as string) ?? "{}"); return response(discovery("queued", { kind: "youtube_channel_videos" }), 202); }
    return response(discovery("succeeded", { kind: "youtube_channel_videos" }));
  });
  const result = await client.callTool({ name: "get_channel_latest_videos", arguments: { channel: "@veritasium" } });
  assert.equal(result.isError, undefined);
  assert.equal(sent?.kind, "youtube_channel_videos");
  assert.equal(sent?.limit, 10);
  assert.equal("cursor" in (sent ?? {}), false);
  await client.close();
});

test("failed discovery returns isError with the error object", async () => {
  const client = await connected(async (url, init) => {
    if (String(url).endsWith("/v1/video-discoveries") && init?.method === "POST") return response(discovery("queued"), 202);
    return response(discovery("failed"));
  });
  const result = await client.callTool({ name: "list_playlist_videos", arguments: { playlist: "PLxxxxxxxxxxxxxxxxxx" } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(textOf(result)).error.code, "SOURCE_NOT_FOUND");
  await client.close();
});

test("timeout returns timed_out with the retrieval hint", async () => {
  const client = await connected(async (url, init) => {
    if (String(url).endsWith("/v1/video-discoveries") && init?.method === "POST") return response(discovery("queued"), 202);
    return response(discovery("processing"));
  });
  const result = await client.callTool({ name: "search_youtube", arguments: { query: "cats", timeout_seconds: 1 } });
  assert.equal(result.isError, undefined);
  assert.equal((JSON.parse(textOf(result)) as { timed_out?: boolean }).timed_out, true);
  assert.match(textOf(result), /get_video_discovery/);
  await client.close();
});

test("get_video_discovery reads one discovery by id", async () => {
  let path = "";
  const client = await connected(async (url) => { path = String(url); return response(discovery("succeeded")); });
  const result = await client.callTool({ name: "get_video_discovery", arguments: { id: DISCOVERY_ID } });
  assert.equal(result.isError, undefined);
  assert.match(path, new RegExp(`/v1/video-discoveries/${DISCOVERY_ID}`));
  await client.close();
});

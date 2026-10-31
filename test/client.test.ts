import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, loadConfig, TranscriptDockClient, validateBaseUrl, waitForJob } from "../src/client.js";

const job = {
  id: "11111111-1111-4111-8111-111111111111", status: "processing", stage: "resolve", result_id: null, error: null,
  billing: { credits_reserved: 0, credits_charged: 0, kind: "captions" },
  source: { platform: "youtube", canonical_url: "https://www.youtube.com/watch?v=example" },
  options: { mode: "auto", language: null, caption_preference: "prefer_creator" }, created_at: "2026-09-12T12:00:00.000Z",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("requires an explicit safe base URL", () => {
  assert.equal(validateBaseUrl("https://api.example.test/"), "https://api.example.test");
  assert.equal(validateBaseUrl("http://localhost:4310/api/"), "http://localhost:4310/api");
  assert.throws(() => loadConfig({ TRANSCRIPTDOCK_API_KEY: "td_live_test_secret" }), /BASE_URL/);
  assert.throws(() => validateBaseUrl("http://api.example.test"), /HTTPS/);
  assert.throws(() => validateBaseUrl("https://user:password@api.example.test"), /credentials/);
});

test("uses a caller supplied idempotency key and validates job responses", async () => {
  let headers: Headers | undefined;
  const client = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async (_url, init) => {
    headers = new Headers(init?.headers);
    return response(job, 202);
  });
  await client.createJob({ url: "https://www.youtube.com/watch?v=example", mode: "auto", language: null, max_credits: 100 }, "mcp_create_1");
  assert.equal(headers?.get("idempotency-key"), "mcp_create_1");
  assert.equal(headers?.get("authorization"), "Bearer td_live_test_secret");
  assert.throws(() => client.createJob({ url: "https://x.test", mode: "auto", language: null, max_credits: 100 }, "short"), /idempotency_key/);
});

test("does not expose API keys in mapped errors", async () => {
  const apiKey = "td_live_test_secret";
  const client = new TranscriptDockClient({ apiKey, baseUrl: "https://api.example.test" }, async () => response({ error: { code: "FORBIDDEN", message: `Bearer ${apiKey}`, retryable: false }, request_id: "22222222-2222-4222-8222-222222222222" }, 403));
  await assert.rejects(() => client.getJob(job.id), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(client.redactText(error.message).includes(apiKey), false);
    return true;
  });
});

test("bounds polling by its calculated safety limit", async () => {
  let calls = 0;
  const client = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async () => { calls += 1; return response(job); });
  const result = await waitForJob(client, job.id, 1, { pollIntervalMs: 1000, now: () => 0, sleep: async () => undefined });
  assert.equal(result.timed_out, true);
  assert.equal(calls, 2);
});

test("JSON calls and exports map interrupted response bodies to retryable network errors", async () => {
  const client = new TranscriptDockClient({ apiKey: "td_live_test_secret", baseUrl: "https://api.example.test" }, async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("connection closed")); } });
    return new Response(body);
  });
  for (const call of [() => client.getJob(job.id), () => client.exportTranscript(job.id, "txt")]) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "NETWORK_ERROR");
      assert.equal(error.retryable, true);
      return true;
    });
  }
});

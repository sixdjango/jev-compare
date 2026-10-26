import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { APIConnectionError, APIError, AuthenticationError, RateLimitError } from "@typesafe-ai/sdk";
import { createClient, loadImage, proxyFetch, ProxyUrlError, summarizeError } from "../dist/index.mjs";

const KEY = "sk-live-SUPERSECRET123";
const env = { JEV_KEY: KEY };

/** Fails a request the way the SDK does, through `fetch`, and returns what it threw. */
async function failThrough(fetch) {
  const client = createClient({ apiKey: KEY, proxy: false, clientOptions: { fetch, retry: { maxRetries: 0 }, timeout: 5000 } });
  try {
    await client.systemOne({ model: "jev-preview", state: { text: "x" }, questions: { q: { type: "noul", question: "?", instructions: "hi" } } });
  } catch (error) {
    return error;
  }
  assert.fail("expected the request to fail");
}

test("API errors keep status and request ID, and drop the API key and tokens", () => {
  const error = new AuthenticationError(
    401,
    { error: { message: `invalid key ${KEY} (Authorization: Bearer ${KEY}) via https://u:pw1234@x.test/?token=abc` } },
    new Headers({ "x-typesafe-request-id": "req_123" }),
  );
  const summary = summarizeError(error, { env });
  assert.equal(summary.kind, "auth");
  assert.equal(summary.name, "AuthenticationError");
  assert.equal(summary.status, 401);
  assert.equal(summary.requestId, "req_123");
  assert.match(summary.hint, /JEV_KEY/);
  const text = JSON.stringify(summary);
  for (const secret of [KEY, "pw1234", "token=abc"]) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
});

test("HTTP 451 suggests a proxy, or another exit when one is set", () => {
  const error = APIError.fromResponse(451, "unavailable", new Headers());
  assert.equal(summarizeError(error, { env }).kind, "region");
  assert.match(summarizeError(error, { env, proxy: false }).hint, /ALL_PROXY/);
  assert.match(summarizeError(error, { env, proxy: "http://127.0.0.1:7890", locale: "zh" }).hint, /代理出口/);
});

test("rate limits carry the retry delay", () => {
  const error = new RateLimitError(429, "slow down", new Headers({ "retry-after": "3" }));
  const summary = summarizeError(error, { env });
  assert.equal(summary.kind, "rate_limit");
  assert.equal(summary.retryAfterMs, 3000);
  assert.match(summary.hint, /3 s/);
});

test("an unreachable proxy is told apart from an unreachable API, with credentials redacted", async () => {
  const proxy = "http://alice:hunter22@127.0.0.1:9";
  const error = await failThrough(proxyFetch(proxy));
  assert.ok(error instanceof APIConnectionError);
  const summary = summarizeError(error, { env, proxy });
  assert.equal(summary.kind, "proxy");
  assert.equal(summary.code, "ECONNREFUSED");
  assert.equal(summary.proxy, "http://***@127.0.0.1:9");
  assert.match(summary.hint, /reach the proxy/);
  assert.ok(!JSON.stringify(summary).includes("hunter22"));

  const direct = summarizeError(error, { env, proxy: false });
  assert.equal(direct.kind, "network");
  assert.equal(direct.proxy, undefined);
});

test("a proxy that rejects credentials is reported as a proxy auth failure", async (t) => {
  const server = createServer();
  server.on("connect", (req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const proxy = `http://bob:wrongpass@127.0.0.1:${server.address().port}`;
  const summary = summarizeError(await failThrough(proxyFetch(proxy)), { env, proxy });
  assert.equal(summary.kind, "proxy");
  assert.match(summary.hint, /credentials/);
  assert.ok(!JSON.stringify(summary).includes("wrongpass"));
});

test("bad proxy URLs, images and paths are classified", async () => {
  assert.throws(() => proxyFetch("socks5://127.0.0.1:1080"), ProxyUrlError);
  let error;
  try {
    proxyFetch("socks5://127.0.0.1:1080");
  } catch (e) {
    error = e;
  }
  const summary = summarizeError(error, { env, locale: "zh" });
  assert.equal(summary.kind, "proxy");
  assert.match(summary.hint, /mixed-port/);
  const missing = await loadImage("does-not-exist.png").catch((e) => e);
  assert.equal(summarizeError(missing, { env }).kind, "invalid_input");
  assert.equal(summarizeError(new RangeError("threshold must be between 0 and 1"), { env }).kind, "invalid_input");
  assert.deepEqual(summarizeError("boom", { env }), { kind: "unknown", name: "string", message: "boom", causes: [] });
});

test("a proxy given without a scheme is redacted too", () => {
  const proxy = "carol:pa55word@127.0.0.1:7890";
  const summary = summarizeError(new Error(`via ${proxy}`), { env, proxy });
  assert.equal(summary.proxy, "http://***@127.0.0.1:7890");
  assert.ok(!JSON.stringify(summary).includes("pa55word"), JSON.stringify(summary));
  assert.throws(() => proxyFetch("carol:pa55word@127.0.0.1:bad"), (e) => !e.message.includes("pa55word"));
});

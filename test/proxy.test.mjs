import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { proxyFetch, resolveProxy } from "../dist/index.mjs";

test("resolveProxy prefers the option, then HTTPS_PROXY, then HTTP_PROXY", () => {
  const env = { HTTP_PROXY: "http://h:1", https_proxy: "http://s:2" };
  assert.equal(resolveProxy("http://o:3", env), "http://o:3");
  assert.equal(resolveProxy(undefined, env), "http://s:2");
  assert.equal(resolveProxy(undefined, { http_proxy: "http://h:1" }), "http://h:1");
  assert.equal(resolveProxy(false, env), undefined);
  assert.equal(resolveProxy(undefined, {}), undefined);
});

test("proxyFetch tunnels requests through the proxy", async (t) => {
  const target = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  const tunnels = [];
  // A CONNECT proxy that sends every tunnel to the local target, whatever host was asked for.
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    tunnels.push(req.url);
    const upstream = connect(target.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  for (const server of [target, proxy]) {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
  }
  const fetch = proxyFetch(`http://127.0.0.1:${proxy.address().port}`);
  const res = await fetch("http://api.example.test/v1/ping", { method: "POST", body: "{}" });
  assert.deepEqual(await res.json(), { path: "/v1/ping" });
  assert.deepEqual(tunnels, ["api.example.test:80"]);
});

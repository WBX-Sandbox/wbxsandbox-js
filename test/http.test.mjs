// Transport: authentication, error mapping, retries, timeouts and cancellation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ConnectionError,
  FeatureDisabledError,
  HumanInControlError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  VERSION,
  WBX,
  WBXError,
} from "../dist/index.js";
import { parseRetryAfter } from "../dist/errors.js";
import { backoffMs, buildURL } from "../dist/http.js";
import { SB, delay, mockServer, sendJSON } from "./helpers.mjs";

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("sends the API key in X-API-Key and never in the URL", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 200, [SB]));
  try {
    const wbx = new WBX({ apiKey: "wbx_secret", baseURL: s.url + "/" });
    const list = await wbx.sandboxes.list();
    assert.equal(list[0].id, SB.id);
    assert.equal(s.calls[0].headers["x-api-key"], "wbx_secret");
    assert.equal(s.calls[0].headers.authorization, undefined);
    assert.ok(!s.calls[0].path.includes("wbx_secret"));
    assert.equal(s.calls[0].path, "/v1/sandboxes");
  } finally {
    await s.close();
  }
});

test("API key and URL from the environment like the Python SDK", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 200, { features: { desktop: true, metrics_history: false } }));
  const old = { k: process.env.WBXSANDBOX_API_KEY, u: process.env.WBXSANDBOX_URL };
  try {
    process.env.WBXSANDBOX_API_KEY = "from_env";
    process.env.WBXSANDBOX_URL = s.url;
    const wbx = new WBX();
    assert.equal(wbx.baseURL, s.url);
    assert.deepEqual(await wbx.features(), { desktop: true, metrics_history: false });
    assert.equal(s.calls[0].headers["x-api-key"], "from_env");
  } finally {
    for (const [k, v] of [["WBXSANDBOX_API_KEY", old.k], ["WBXSANDBOX_URL", old.u]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await s.close();
  }
});

test("default base URL is the production API", () => {
  const old = process.env.WBXSANDBOX_URL;
  delete process.env.WBXSANDBOX_URL;
  try {
    assert.equal(new WBX({ apiKey: "k" }).baseURL, "https://sandbox.wbx.cz");
  } finally {
    if (old !== undefined) process.env.WBXSANDBOX_URL = old;
  }
});

test("missing API key fails before any request", async () => {
  let called = 0;
  const old = process.env.WBXSANDBOX_API_KEY;
  delete process.env.WBXSANDBOX_API_KEY;
  try {
    const wbx = new WBX({ baseURL: "http://127.0.0.1:9", fetch: async () => (called++, new Response("{}")) });
    await assert.rejects(wbx.sandboxes.list(), AuthenticationError);
    assert.equal(called, 0);
    // public endpoint works without a key
    await wbx.receiptKeys();
    assert.equal(called, 1);
  } finally {
    if (old !== undefined) process.env.WBXSANDBOX_API_KEY = old;
  }
});

test("maps error responses to typed errors", async () => {
  const cases = [
    [400, { error: "bad", code: "invalid_json" }, {}, BadRequestError],
    [401, { error: "invalid or missing API key" }, {}, AuthenticationError],
    [402, { error: "suspended", code: "account_suspended" }, {}, PaymentRequiredError],
    [403, { error: "admin only" }, {}, PermissionDeniedError],
    [403, { error: "feature desktop is not enabled for this account", code: "feature_disabled", feature: "desktop" }, {}, FeatureDisabledError],
    [404, { error: "sandbox not found" }, {}, NotFoundError],
    [409, { error: "the sandbox is not running (paused)" }, {}, ConflictError],
    [409, { error: "a person controls the desktop", code: "human_in_control" }, {}, HumanInControlError],
    [429, { error: "account limit reached", code: "quota" }, { "Retry-After": "7" }, RateLimitError],
    [500, { error: "internal error – please try again" }, {}, InternalServerError],
    [418, { error: "teapot" }, {}, APIError],
  ];
  let i = 0;
  const s = await mockServer((req, res) => {
    const [st, body, h] = cases[i++];
    sendJSON(res, st, body, h);
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url, maxRetries: 0 });
    for (const [st, body, h, cls] of cases) {
      const err = await wbx.request("GET", "/v1/anything").then(
        () => assert.fail("expected an error"),
        (e) => e,
      );
      assert.ok(err instanceof cls, `${st} → ${cls.name}, got ${err.name}`);
      assert.ok(err instanceof APIError && err instanceof WBXError);
      assert.equal(err.status, st);
      assert.equal(err.code, body.code);
      assert.match(err.message, new RegExp(body.error.slice(0, 10)));
      if (h["Retry-After"]) assert.equal(err.retryAfter, 7);
    }
    const fd = await wbx.request("GET", "/x").catch((e) => e); // beyond the cases → handler throws → 500
    assert.ok(fd instanceof InternalServerError);
  } finally {
    await s.close();
  }
  // FeatureDisabledError is also a PermissionDeniedError and carries the feature name
  const e = new FeatureDisabledError({ status: 403, message: "x", feature: "metrics_history" });
  assert.ok(e instanceof PermissionDeniedError);
  assert.equal(e.feature, "metrics_history");
  assert.ok(new HumanInControlError({ status: 409, message: "x" }) instanceof ConflictError);
});

test("non-JSON error bodies keep their text", async () => {
  const s = await mockServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 page not found\n");
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const err = await wbx.request("GET", "/nope").catch((e) => e);
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.body, "404 page not found\n");
    assert.equal(err.code, undefined);
    assert.match(err.message, /404 page not found/);
  } finally {
    await s.close();
  }
});

test("retries GET after 503 honouring Retry-After", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.n < 3) return sendJSON(res, 503, { error: "no capacity" }, { "Retry-After": "0" });
    sendJSON(res, 200, { ...SB });
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const sb = await wbx.sandboxes.get(SB.id);
    assert.equal(sb.id, SB.id);
    assert.equal(s.calls.length, 3);
  } finally {
    await s.close();
  }
});

test("retries 502/504 with backoff and gives up after maxRetries", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 502, { error: "bad gateway" }));
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url, maxRetries: 1 });
    const t0 = Date.now();
    await assert.rejects(wbx.templates.list(), InternalServerError);
    assert.equal(s.calls.length, 2);
    assert.ok(Date.now() - t0 >= 200, "waited a backoff");
  } finally {
    await s.close();
  }
});

test("does not retry 429 without Retry-After (hard limit) and does not wait for a too long Retry-After", async () => {
  const s = await mockServer((req, res, c) =>
    c.n === 1 ? sendJSON(res, 429, { error: "limit", code: "quota" }) : sendJSON(res, 503, { error: "later" }, { "Retry-After": "3600" }),
  );
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    await assert.rejects(wbx.templates.list(), RateLimitError);
    assert.equal(s.calls.length, 1);
    const err = await wbx.templates.list().catch((e) => e);
    assert.ok(err instanceof InternalServerError);
    assert.equal(err.retryAfter, 3600);
    assert.equal(s.calls.length, 2);
  } finally {
    await s.close();
  }
});

test("never retries a POST without an idempotency guarantee", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 503, { error: "busy" }, { "Retry-After": "0" }));
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const sb = (await import("../dist/index.js")).Sandbox;
    const box = new sb(wbx.transport, { ...SB });
    await assert.rejects(box.commands.run("echo hi"), InternalServerError);
    assert.equal(s.calls.length, 1, "exec is not retried");
    await assert.rejects(wbx.sandboxes.create({ template: "base" }), InternalServerError);
    assert.equal(s.calls.length, 2, "unnamed create is not retried");
    await assert.rejects(box.sleep(), InternalServerError);
    assert.equal(s.calls.length, 3, "sleep is not retried");
  } finally {
    await s.close();
  }
});

test("retries POSTs that carry an idempotency key with the same key, and a named create", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.n % 2 === 1) return sendJSON(res, 503, { error: "busy" }, { "Retry-After": "0" });
    if (c.path === "/v1/jobs") return sendJSON(res, 202, { id: "job_1", status: "queued" });
    if (c.path === "/v1/sandboxes") return sendJSON(res, 200, { ...SB, name: "proj" }, { "X-WBX-Existing": "1" });
    sendJSON(res, 404, { error: "?" });
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const job = await wbx.jobs.create({ command: "true" });
    assert.equal(job.id, "job_1");
    assert.equal(s.calls.length, 2);
    const k1 = s.calls[0].json.idempotency_key;
    assert.match(k1, /^[0-9a-f-]{36}$/);
    assert.equal(s.calls[1].json.idempotency_key, k1, "the retry reuses the key");
    const sb = await wbx.sandboxes.create({ name: "proj" });
    assert.equal(s.calls.length, 4);
    assert.equal(sb.existing, true);
    assert.equal(sb.name, "proj");
  } finally {
    await s.close();
  }
});

test("connection errors: retried for GET, ConnectionError in the end", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.n === 1) return req.socket.destroy();
    sendJSON(res, 200, []);
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    assert.deepEqual(await wbx.templates.list(), []);
    assert.equal(s.calls.length, 2);
  } finally {
    await s.close();
  }
  const wbx = new WBX({ apiKey: "k", baseURL: "http://127.0.0.1:1", maxRetries: 0 });
  await assert.rejects(wbx.templates.list(), ConnectionError);
});

test("timeout per attempt raises TimeoutError", async () => {
  const s = await mockServer(async (req, res) => {
    await delay(400);
    sendJSON(res, 200, []);
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url, timeoutMs: 100, maxRetries: 0 });
    const t0 = Date.now();
    await assert.rejects(wbx.templates.list(), TimeoutError);
    assert.ok(Date.now() - t0 < 350);
    // per-call override
    assert.deepEqual(await wbx.templates.list({ timeoutMs: 2000 }), []);
  } finally {
    await s.close();
  }
});

test("AbortSignal cancels a request in flight and a pre-aborted signal sends nothing", async () => {
  const s = await mockServer(async (req, res) => {
    await delay(500);
    sendJSON(res, 200, []);
  });
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await wbx.templates.list({ signal: ac.signal }).catch((e) => e);
    assert.equal(err.name, "AbortError");
    const n = s.calls.length;
    const ac2 = new AbortController();
    ac2.abort(new Error("stop"));
    await assert.rejects(wbx.templates.list({ signal: ac2.signal }), /stop/);
    assert.equal(s.calls.length, n);
  } finally {
    await s.close();
  }
});

test("abort during a retry wait stops at once", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 503, { error: "x" }, { "Retry-After": "30" }));
  try {
    const wbx = new WBX({ apiKey: "k", baseURL: s.url });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const err = await wbx.templates.list({ signal: ac.signal }).catch((e) => e);
    assert.equal(err.name, "AbortError");
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await s.close();
  }
});

test("helpers: Retry-After parsing, backoff bounds, URL building", () => {
  assert.equal(parseRetryAfter("5"), 5);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("junk"), undefined);
  const now = Date.parse("2026-11-20T10:00:00Z");
  assert.equal(parseRetryAfter("Fri, 20 Nov 2026 10:00:10 GMT", now), 10);
  assert.equal(backoffMs(0, () => 0), 250);
  assert.equal(backoffMs(0, () => 1), 500);
  assert.equal(backoffMs(10, () => 1), 8000);
  assert.equal(buildURL("http://a/", "/v1/x", { a: 1, b: undefined, c: "x y" }), "http://a/v1/x?a=1&c=x+y");
});

test("the API key never appears in util.inspect or JSON.stringify of the client, resources or errors", async () => {
  const { inspect } = await import("node:util");
  const KEY = "wbx_test_DO-NOT-LEAK-7f3a9c";
  const JOB = { id: "job_abc", status: "queued", template: "base", command: "true", created_at: "2026-11-20T10:00:00Z" };
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/denied") return sendJSON(res, 401, { error: "invalid API key" });
    if (c.path === "/v1/human") return sendJSON(res, 409, { error: "a person controls it", code: "human_in_control", controller_until: 1_800_000_000_000 });
    if (c.path === "/v1/sandboxes") return sendJSON(res, 201, { id: "sb_x", template: "base", state: "running", vcpu: 1, mem_mb: 512 });
    if (c.path === "/v1/jobs") return sendJSON(res, 202, JOB);
    if (c.path === "/v1/batches") return sendJSON(res, 202, { batch: { id: "bat_x", status: "running" }, job_ids: ["job_abc"] });
    sendJSON(res, 404, { error: "not found" });
  });
  const leaks = (label, v) => {
    for (const text of [inspect(v, { depth: Infinity, showHidden: true, getters: true }), JSON.stringify(v) ?? ""]) {
      assert.ok(!text.includes(KEY), `${label} leaks the API key: ${text.slice(0, 300)}`);
    }
  };
  try {
    const wbx = new WBX({ apiKey: KEY, baseURL: s.url, maxRetries: 0, headers: { "X-Trace": "t" } });
    leaks("client", wbx);
    leaks("transport", wbx.transport);
    leaks("transport.config", wbx.transport.config);
    leaks("resources", [wbx.sandboxes, wbx.jobs, wbx.batches, wbx.templates, wbx.budget, wbx.compute, wbx.webhooks]);
    assert.equal(wbx.transport.config.apiKey, undefined, "the key is not a readable setting");
    assert.equal(wbx.transport.hasApiKey, true);
    assert.deepEqual(JSON.parse(JSON.stringify(wbx)), { baseURL: s.url, hasApiKey: true });
    assert.match(inspect(wbx), /^WBX \{"baseURL":/);
    // console.log goes through util.inspect too
    const sb = await wbx.sandboxes.create({ template: "base" });
    leaks("sandbox", sb);
    assert.equal(s.calls.at(-1).headers["x-api-key"], KEY, "the key is still sent");
    leaks("job", await wbx.jobs.create({ command: "true" }));
    leaks("batch", await wbx.batches.create({ jobs: [{ command: "true" }] }));
    const denied = await wbx.request("GET", "/v1/denied").catch((e) => e);
    assert.ok(denied instanceof AuthenticationError);
    leaks("APIError", denied);
    leaks("APIError.stack", denied.stack);
    const human = await wbx.request("GET", "/v1/human").catch((e) => e);
    assert.ok(human instanceof HumanInControlError);
    assert.equal(human.controllerUntil, 1_800_000_000_000, "controller_until is Unix ms");
    leaks("HumanInControlError", human);
    const down = new WBX({ apiKey: KEY, baseURL: "http://127.0.0.1:1", maxRetries: 0 });
    const conn = await down.request("GET", "/v1/x").catch((e) => e);
    assert.ok(conn instanceof ConnectionError);
    leaks("ConnectionError", conn);
    const thrower = new WBX({
      apiKey: KEY,
      baseURL: s.url,
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("boom");
      },
    });
    leaks("ConnectionError from a custom fetch", await thrower.request("GET", "/v1/x").catch((e) => e));
    leaks("client with a custom fetch", thrower);
  } finally {
    await s.close();
  }
});


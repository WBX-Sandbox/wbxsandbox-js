// Jobs, batches, pagination and account helpers against a mock server.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import { IntegrityError, NotFoundError, TimeoutError, WBX, verifyWebhook } from "../dist/index.js";
import { mockServer, sendJSON } from "./helpers.mjs";

const JOB = { id: "job_abc", status: "queued", template: "base", command: "true", timeout_s: 60, retry: { max_attempts: 1, on: "system" }, attempt: 1, created_at: "2026-11-20T10:00:00Z", log_bytes: 0, runtime: "firecracker" };

function client(s) {
  return new WBX({ apiKey: "k", baseURL: s.url });
}

test("jobs.create maps options to the REST body and adds an idempotency key", async () => {
  const s = await mockServer((req, res, c) => sendJSON(res, c.n === 1 ? 202 : 200, JOB, c.n === 2 ? { "Idempotent-Replay": "true" } : {}));
  try {
    const wbx = client(s);
    const job = await wbx.jobs.create({
      command: "python3 a.py",
      template: "base",
      timeoutSeconds: 3600,
      saveArtifacts: true,
      artifacts: ["out/*.csv"],
      requiredArtifacts: ["out/result.csv"],
      env: { K: "v" },
      cwd: "/work",
      network: { mode: "none" },
      retry: { maxAttempts: 3 },
      maxCost: 0.1,
      metadata: { run: "1" },
      computeClass: "economy",
      inputs: [{ jobId: "job_prev", name: "output/data.csv", as: "data.csv" }],
      webhookUrl: "https://example.org/hook",
    });
    const b = s.calls[0].json;
    assert.match(b.idempotency_key, /^[0-9a-f-]{36}$/);
    delete b.idempotency_key;
    assert.deepEqual(b, {
      command: "python3 a.py",
      template: "base",
      timeout_s: 3600,
      cwd: "/work",
      env: { K: "v" },
      artifacts: ["out/*.csv"],
      save_artifacts: true,
      required_artifacts: ["out/result.csv"],
      network: { mode: "none" },
      metadata: { run: "1" },
      max_cost: "0.1",
      webhook_url: "https://example.org/hook",
      compute_class: "economy",
      retry: { max_attempts: 3, on: "system" },
      inputs: [{ job_id: "job_prev", name: "output/data.csv", as: "data.csv" }],
    });
    assert.equal(job.id, "job_abc");
    assert.equal(job.done, false);
    assert.equal(job.replayed, false);
    const again = await wbx.jobs.create({ command: "true", idempotencyKey: "mine" });
    assert.equal(s.calls[1].json.idempotency_key, "mine");
    assert.equal(again.replayed, true);
    await assert.rejects(wbx.jobs.create({}), /command is required/);
  } finally {
    await s.close();
  }
});

test("WebAssembly job: module as base64, runtime wasi", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 202, JOB));
  try {
    await client(s).jobs.create({ wasm: { module: new Uint8Array([0, 97, 115, 109]), args: ["--x"], memoryMb: 64 } });
    const b = s.calls[0].json;
    assert.equal(b.runtime, "wasi");
    assert.deepEqual(b.wasm, { module_b64: "AGFzbQ==", args: ["--x"], memory_mb: 64 });
    assert.equal(b.command, undefined);
  } finally {
    await s.close();
  }
});

test("job.wait uses server-side waiting and returns the finished job", async () => {
  let state = "running";
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/jobs/wait") {
      assert.deepEqual(c.json.job_ids, ["job_abc"]);
      assert.ok(c.json.timeout_s >= 1 && c.json.timeout_s <= 60);
      state = "completed";
      return sendJSON(res, 200, { done: true, finished: 1, total: 1, items: [] });
    }
    sendJSON(res, 200, { ...JOB, status: state, exit_code: state === "completed" ? 0 : undefined });
  });
  try {
    const job = await client(s).jobs.get("job_abc");
    await job.wait({ timeoutMs: 10_000 });
    assert.equal(job.status, "completed");
    assert.equal(job.done, true);
    assert.deepEqual(s.calls.map((c) => c.path), ["/v1/jobs/job_abc", "/v1/jobs/job_abc", "/v1/jobs/wait", "/v1/jobs/job_abc"]);
  } finally {
    await s.close();
  }
});

test("job.wait falls back to polling on servers without /v1/jobs/wait and times out", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/jobs/wait") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 page not found\n");
    }
    sendJSON(res, 200, { ...JOB, status: "running" });
  });
  try {
    const job = await client(s).jobs.get("job_abc");
    const t0 = Date.now();
    await assert.rejects(job.wait({ timeoutMs: 300, pollIntervalMs: 50 }), TimeoutError);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(s.calls.filter((c) => c.path === "/v1/jobs/wait").length, 1, "no second wait call after the fallback");
  } finally {
    await s.close();
  }
});

test("logs: chunk with offset, digest, whole text, follow until complete", async () => {
  const log = "line 1\nline 2\nline 3\n";
  const s = await mockServer((req, res, c) => {
    if (c.query.get("mode")) return sendJSON(res, 200, { mode: c.query.get("mode"), text: "digest", size: log.length, lines: 3, truncated_start: false, complete: true, status: "completed", exit_code: 0 });
    const off = Number(c.query.get("offset") ?? 0);
    const lim = Math.min(Number(c.query.get("limit") ?? 7), 7);
    const data = log.slice(off, off + lim);
    sendJSON(res, 200, { data, offset: off, next_offset: off + data.length, size: log.length, truncated_start: false, complete: off + data.length >= log.length, status: "completed" });
  });
  try {
    const { Job } = await import("../dist/index.js");
    const j = new Job(client(s).transport, JOB);
    const before = s.calls.length;
    const chunk = await j.logs({ offset: 7, limit: 7 });
    assert.equal(chunk.data, "line 2\n");
    assert.equal(s.calls[before].query.get("offset"), "7");
    assert.equal((await j.digest({ mode: "errors", maxChars: 100 })).text, "digest");
    assert.equal(s.calls.at(-1).query.get("max_chars"), "100");
    assert.equal(await j.logText(), log);
    const parts = [];
    for await (const p of j.follow({ pollIntervalMs: 10 })) parts.push(p);
    assert.equal(parts.join(""), log);
  } finally {
    await s.close();
  }
});

test("download verifies the SHA-256 sent by the server", async () => {
  const good = new TextEncoder().encode('{"ok":true}');
  const sha = createHash("sha256").update(good).digest("hex");
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/jobs/job_abc") return sendJSON(res, 200, { ...JOB, status: "completed" });
    assert.equal(c.path, "/v1/jobs/job_abc/artifacts/output/r%20s.json");
    const body = c.n === 2 ? good : new TextEncoder().encode("tampered");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-WBX-SHA256": sha });
    res.end(body);
  });
  try {
    const job = await client(s).jobs.get("job_abc");
    assert.deepEqual(await job.download("output/r s.json"), good);
    await assert.rejects(job.download("output/r s.json"), IntegrityError);
    assert.deepEqual(await job.download("output/r s.json", { verify: false }), new TextEncoder().encode("tampered"));
  } finally {
    await s.close();
  }
});

test("download with verify (default) refuses a response without a valid X-WBX-SHA256", async () => {
  const body = new TextEncoder().encode("data");
  let header;
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/jobs/job_abc") return sendJSON(res, 200, { ...JOB, status: "completed" });
    res.writeHead(200, { "Content-Type": "application/octet-stream", ...(header ? { "X-WBX-SHA256": header } : {}) });
    res.end(body);
  });
  try {
    const job = await client(s).jobs.get("job_abc");
    header = undefined;
    await assert.rejects(job.download("output/a"), (e) => e instanceof IntegrityError && /missing checksum/.test(e.message));
    await assert.rejects(job.download("output/a", { verify: true }), IntegrityError);
    assert.deepEqual(await job.download("output/a", { verify: false }), body);
    header = "not-a-sha";
    await assert.rejects(job.download("output/a"), (e) => e instanceof IntegrityError && /invalid checksum/.test(e.message));
    header = createHash("sha256").update(body).digest("hex").toUpperCase();
    assert.deepEqual(await job.download("output/a"), body, "hex case does not matter");
  } finally {
    await s.close();
  }
});

test("receipt, signed receipt, artifacts, cancel, retry", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.path.endsWith("/receipt")) {
      return c.query.get("signed") === "1"
        ? sendJSON(res, 200, { signed_receipt: { format: "wbx-signed-receipt-1", alg: "Ed25519", key_id: "k1", payload: "e30=", signature: "c2ln" }, final: true })
        : sendJSON(res, 200, { execution_receipt: { receipt_version: 2, job_id: "job_abc", status: "completed", attempts: 1, exit_code: 0, artifacts: [], cost: null }, final: true });
    }
    if (c.path.endsWith("/artifacts")) return sendJSON(res, 200, { artifacts: [{ name: "output/a", size: 1, sha256: "x" }], skipped: null, status: "completed" });
    if (c.path.endsWith("/cancel")) return sendJSON(res, 200, { ...JOB, status: "cancelled" });
    if (c.path.endsWith("/retry")) return sendJSON(res, 202, { ...JOB, id: "job_new", retry_of: "job_abc" });
    sendJSON(res, 200, JOB);
  });
  try {
    const job = await client(s).jobs.get("job_abc");
    assert.equal((await job.receipt()).receipt_version, 2);
    assert.equal((await job.signedReceipt()).key_id, "k1");
    assert.equal((await job.artifacts()).artifacts[0].name, "output/a");
    assert.equal((await job.cancel()).status, "cancelled");
    const nj = await job.retry({ env: { K: "v" } });
    assert.equal(nj.id, "job_new");
    assert.deepEqual(s.calls.at(-1).json.env, { K: "v" });
    assert.match(s.calls.at(-1).json.idempotency_key, /^[0-9a-f-]{36}$/);
  } finally {
    await s.close();
  }
});

test("jobs.list pages through next_cursor; filters are sent", async () => {
  const pages = { "": ["j1", "j2"], j2: ["j3", "j4"], j4: ["j5"] };
  const s = await mockServer((req, res, c) => {
    const cur = c.query.get("cursor") ?? "";
    const ids = pages[cur];
    const next = { "": "j2", j2: "j4" }[cur];
    sendJSON(res, 200, { jobs: ids.map((id) => ({ id, status: "completed", done: true })), ...(next ? { next_cursor: next } : {}) });
  });
  try {
    const wbx = client(s);
    const page = await wbx.jobs.list({ status: ["completed", "failed"], batchId: "bat_x", since: new Date("2026-11-15T08:00:00Z"), limit: 2 });
    assert.deepEqual(page.items.map((j) => j.id), ["j1", "j2"]);
    assert.ok(page.hasNextPage());
    assert.equal(s.calls[0].query.get("status"), "completed,failed");
    assert.equal(s.calls[0].query.get("batch_id"), "bat_x");
    assert.equal(s.calls[0].query.get("since"), "2026-11-15T08:00:00.000Z");
    assert.equal(s.calls[0].query.get("limit"), "2");
    const all = [];
    for await (const j of page) all.push(j.id);
    assert.deepEqual(all, ["j1", "j2", "j3", "j4", "j5"]);
    assert.equal(s.calls[2].query.get("cursor"), "j4");
    assert.equal(s.calls[2].query.get("status"), "completed,failed", "filters kept on next pages");
    const last = await (await page.getNextPage()).getNextPage();
    assert.equal(last.hasNextPage(), false);
    assert.equal(await last.getNextPage(), undefined);
  } finally {
    await s.close();
  }
});

test("batches: create with dependencies and inputs from other jobs, get, report, csv, wait, cancel, list", async () => {
  const summary = (st, done) => ({ id: "bat_1", status: st, done, total: 2, counts: {}, succeeded: done ? 1 : 0, failed: done ? 1 : 0, cost: "0", cost_micros: 0, created_at: "x", next: "" });
  let done = false;
  const s = await mockServer((req, res, c) => {
    if (c.method === "POST" && c.path === "/v1/batches") return sendJSON(res, 202, { batch: summary("running", false), job_ids: ["job_a", "job_b"] });
    if (c.path === "/v1/batches/bat_1/report") {
      if (c.query.get("format") === "csv") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        return res.end("index,job_id\n0,job_a\n");
      }
      return sendJSON(res, 200, { summary: summary("running", false), jobs: [{ index: 1, job_id: "job_b" }, { index: 0, job_id: "job_a" }] });
    }
    if (c.path === "/v1/jobs/wait") {
      assert.deepEqual(c.json.batch_ids, ["bat_1"]);
      done = true;
      return sendJSON(res, 200, { done: true, finished: 1, total: 1, items: [] });
    }
    if (c.path === "/v1/batches/bat_1/cancel") return sendJSON(res, 200, summary("cancelled", true));
    if (c.path === "/v1/batches/bat_1") return sendJSON(res, 200, summary(done ? "partial" : "running", done));
    if (c.path === "/v1/batches") return sendJSON(res, 200, { batches: [summary("partial", true)] });
    sendJSON(res, 404, { error: "?" });
  });
  try {
    const wbx = client(s);
    const batch = await wbx.batches.create({
      name: "pipeline",
      jobs: [
        { command: "python3 prepare.py", saveArtifacts: true },
        { command: "python3 train.py", dependsOn: [0], inputs: [{ fromIndex: 0, name: "output/data.csv" }] },
      ],
      defaults: { template: "base", timeoutSeconds: 600 },
      maxConcurrency: 5,
      maxTotalCost: "1.00",
    });
    const b = s.calls[0].json;
    assert.match(b.idempotency_key, /^[0-9a-f-]{36}$/);
    assert.deepEqual(b.jobs[1], { command: "python3 train.py", depends_on: [0], inputs: [{ from_index: 0, name: "output/data.csv" }] });
    assert.deepEqual(b.defaults, { template: "base", timeout_s: 600 });
    assert.equal(b.max_concurrency, 5);
    assert.equal(b.max_total_cost, "1.00");
    assert.deepEqual(batch.jobIds, ["job_a", "job_b"]);
    const got = await wbx.batches.get("bat_1");
    assert.deepEqual(got.jobIds, ["job_a", "job_b"], "sorted by index");
    assert.match(await got.reportCsv(), /^index,job_id/);
    await got.wait({ timeoutMs: 5000 });
    assert.equal(got.status, "partial");
    assert.equal((await got.cancel()).status, "cancelled");
    const page = await wbx.batches.list({ limit: 10 });
    assert.equal(page.items[0].status, "partial");
    assert.equal(page.hasNextPage(), false);
  } finally {
    await s.close();
  }
});

test("jobs.wait, budget, compute, templates, runtimes, receipt keys, webhook secret", async () => {
  const s = await mockServer((req, res, c) => {
    const r = {
      "POST /v1/jobs/wait": { done: false, finished: 0, total: 1, items: [{ id: "job_a", kind: "job", status: "running", done: false }] },
      "GET /v1/budget": { currency: "EUR", alert_pct: 80 },
      "PUT /v1/budget": { currency: "EUR", alert_pct: 90 },
      "GET /v1/compute/preferences": { effective_compute_class: "economy", classes: [] },
      "PUT /v1/compute/preferences": { default_compute_class: "balanced", classes: [] },
      "GET /v1/templates": [{ name: "base", vcpu: 1, mem_mb: 512 }],
      "GET /v1/runtimes": { runtimes: [{ name: "wasi" }], wasi_available: true },
      "GET /v1/receipt-keys": { keys: [{ key_id: "k1", alg: "Ed25519", public_key: "x" }] },
      "GET /v1/webhooks/secret": { secret: "whsec" },
      "POST /v1/webhooks/secret/rotate": { secret: "whsec2" },
    }[`${c.method} ${c.path}`];
    sendJSON(res, r ? 200 : 404, r ?? { error: "?" });
  });
  try {
    const wbx = client(s);
    const w = await wbx.jobs.wait({ jobIds: ["job_a"], until: "all", timeoutSeconds: 5 });
    assert.equal(w.done, false);
    assert.deepEqual(s.calls[0].json, { job_ids: ["job_a"], batch_ids: [], until: "all", timeout_s: 5 });
    assert.equal((await wbx.budget.get({ days: true })).currency, "EUR");
    assert.equal(s.calls[1].query.get("days"), "1");
    await wbx.budget.update({ monthly: 50, daily: "", alertPct: 90 });
    assert.deepEqual(s.calls[2].json, { monthly_limit: "50", daily_limit: "", alert_pct: 90 });
    assert.equal((await wbx.compute.preferences()).effective_compute_class, "economy");
    await wbx.compute.setDefaultClass("balanced");
    assert.deepEqual(s.calls[4].json, { default_compute_class: "balanced" });
    assert.equal((await wbx.templates.list())[0].name, "base");
    assert.equal((await wbx.runtimes()).wasi_available, true);
    assert.equal((await wbx.receiptKeys())[0].key_id, "k1");
    assert.equal(s.calls[7].headers["x-api-key"], undefined, "receipt keys are public");
    assert.equal(await wbx.webhooks.secret(), "whsec");
    assert.equal(await wbx.webhooks.rotateSecret(), "whsec2");
    await assert.rejects(wbx.request("GET", "/v1/unknown"), NotFoundError);
  } finally {
    await s.close();
  }
});

test("verifyWebhook checks the HMAC, the timestamp and rejects garbage", async () => {
  const secret = "whsec_test";
  const body = '{"event":"job.finished"}';
  const t = 1_800_000_000;
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const sig = `t=${t},v1=${v1}`;
  assert.equal(await verifyWebhook(secret, body, sig, { now: t * 1000 }), true);
  assert.equal(await verifyWebhook(secret, new TextEncoder().encode(body), sig, { now: t * 1000 + 1000 }), true);
  assert.equal(await verifyWebhook(secret, body + " ", sig, { now: t * 1000 }), false);
  assert.equal(await verifyWebhook("other", body, sig, { now: t * 1000 }), false);
  assert.equal(await verifyWebhook(secret, body, sig, { now: (t + 301) * 1000 }), false);
  assert.equal(await verifyWebhook(secret, body, "garbage", { now: t * 1000 }), false);
  assert.equal(await verifyWebhook(secret, body, null), false);
});

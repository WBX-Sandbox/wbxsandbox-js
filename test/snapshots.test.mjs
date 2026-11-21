// Snapshots of sandbox disks and clones against a mock server.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FeatureDisabledError, RateLimitError, Sandbox, Snapshot, WBX, WBXError } from "../dist/index.js";
import { SB, mockServer, sendJSON } from "./helpers.mjs";

const SNAP = {
  id: "snap_n1_0123456789abcdef",
  name: "after-setup",
  source_sandbox: "sb_n1_abc",
  template: "base",
  vcpu: 1,
  mem_mb: 512,
  disk_mb: 4096,
  size_bytes: 123456789,
  created_at: "2026-11-21T10:00:00Z",
};

function client(s) {
  return new WBX({ apiKey: "k", baseURL: s.url });
}

test("sandbox.snapshot() posts the name and returns a Snapshot", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/sandboxes/sb_n1_abc" && c.method === "GET") return sendJSON(res, 200, SB);
    sendJSON(res, 201, SNAP);
  });
  try {
    const sb = await client(s).sandboxes.get("sb_n1_abc");
    const snap = await sb.snapshot({ name: "after-setup" });
    assert.ok(snap instanceof Snapshot);
    assert.equal(s.calls[1].method, "POST");
    assert.equal(s.calls[1].path, "/v1/sandboxes/sb_n1_abc/snapshots");
    assert.deepEqual(s.calls[1].json, { name: "after-setup" });
    assert.equal(snap.id, SNAP.id);
    assert.equal(snap.name, "after-setup");
    assert.equal(snap.sourceSandbox, "sb_n1_abc");
    assert.equal(snap.template, "base");
    assert.equal(snap.sizeBytes, 123456789);
    assert.equal(snap.createdAt?.toISOString(), "2026-11-21T10:00:00.000Z");
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), SNAP);
    await sb.snapshot();
    assert.deepEqual(s.calls[2].json, {});
  } finally {
    await s.close();
  }
});

test("wbx.snapshots list (array or object), get and delete; delete ignores 404", async () => {
  let n = 0;
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/snapshots") return sendJSON(res, 200, ++n === 1 ? [SNAP] : { snapshots: [SNAP] });
    if (c.method === "GET") return sendJSON(res, 200, SNAP);
    if (c.method === "DELETE" && c.n === 5) return sendJSON(res, 404, { error: "snapshot not found", code: "not_found" });
    res.writeHead(204).end();
  });
  try {
    const wbx = client(s);
    assert.deepEqual((await wbx.snapshots.list()).map((x) => x.id), [SNAP.id]);
    assert.deepEqual((await wbx.snapshots.list()).map((x) => x.id), [SNAP.id]);
    const snap = await wbx.snapshots.get(SNAP.id);
    assert.equal(s.calls[2].path, `/v1/snapshots/${SNAP.id}`);
    await snap.delete();
    assert.equal(s.calls[3].method, "DELETE");
    assert.equal(s.calls[3].path, `/v1/snapshots/${SNAP.id}`);
    await wbx.snapshots.delete(SNAP.id); // 404 – already gone
  } finally {
    await s.close();
  }
});

test("create from a snapshot sends from_snapshot without a template", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 201, { ...SB, id: "sb_n1_new" }));
  try {
    const wbx = client(s);
    const sb = await wbx.sandboxes.create({ fromSnapshot: SNAP.id, timeoutSeconds: 600, env: { A: "1" } });
    assert.ok(sb instanceof Sandbox);
    assert.deepEqual(s.calls[0].json, { from_snapshot: SNAP.id, timeout_s: 600, env: { A: "1" } });
    const snap = new Snapshot(wbx.transport, SNAP);
    await snap.createSandbox({ name: "copy" });
    assert.deepEqual(s.calls[1].json, { from_snapshot: SNAP.id, name: "copy" });
  } finally {
    await s.close();
  }
});

test("create from a snapshot waits up to 300 s, a normal create keeps 150 s", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 201, { ...SB, id: "sb_n1_new" }));
  try {
    const wbx = client(s);
    const seen = [];
    const json = wbx.transport.json.bind(wbx.transport);
    wbx.transport.json = (spec) => {
      seen.push(spec.defaultTimeoutMs);
      return json(spec);
    };
    await wbx.sandboxes.create({ fromSnapshot: SNAP.id });
    await new Snapshot(wbx.transport, SNAP).createSandbox();
    await wbx.sandboxes.create({ template: "base" });
    assert.deepEqual(seen, [300_000, 300_000, 150_000]);
  } finally {
    await s.close();
  }
});

test("sandbox.clone() maps options and reports partial success", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.method === "GET") return sendJSON(res, 200, SB);
    sendJSON(res, 207, {
      snapshot_id: "snap_n1_ffffffffffffffff",
      snapshot_kept: true,
      sandboxes: [{ ...SB, id: "sb_n1_c1" }, { ...SB, id: "sb_n1_c2" }],
      errors: [{ index: 2, name: "w-3", error: "the limit of concurrent sandboxes was reached", code: "quota", status: 429 }],
    });
  });
  try {
    const sb = await client(s).sandboxes.get("sb_n1_abc");
    const r = await sb.clone({ count: 3, name: "w", keepSnapshot: true, snapshotName: "base-env", timeoutSeconds: 900, env: { B: "2" }, onTimeout: "pause" });
    assert.equal(s.calls[1].path, "/v1/sandboxes/sb_n1_abc/clone");
    assert.deepEqual(s.calls[1].json, {
      count: 3, name: "w", keep_snapshot: true, snapshot_name: "base-env", timeout_s: 900, env: { B: "2" }, on_timeout: "pause",
    });
    assert.equal(r.snapshotId, "snap_n1_ffffffffffffffff");
    assert.equal(r.snapshotKept, true);
    assert.deepEqual(r.sandboxes.map((x) => x.id), ["sb_n1_c1", "sb_n1_c2"]);
    assert.ok(r.sandboxes[0] instanceof Sandbox);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, "quota");
    assert.equal(r.errors[0].index, 2);
    assert.equal(r.errors[0].name, "w-3");
    // without options nothing but the count is sent – the copies inherit lifetime and network
    const one = await sb.clone();
    assert.deepEqual(s.calls[2].json, { count: 1 });
    assert.equal(one.snapshotKept, true); // from the server answer
  } finally {
    await s.close();
  }
});

test("clone throws when no copy was created; bad count is refused locally", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.method === "GET") return sendJSON(res, 200, SB);
    sendJSON(res, 200, { sandboxes: [], errors: [{ error: "snapshot limit of your plan reached", code: "snapshot_limit", status: 429 }] });
  });
  try {
    const sb = await client(s).sandboxes.get("sb_n1_abc");
    await assert.rejects(sb.clone({ count: 2 }), (e) => e instanceof RateLimitError && e.code === "snapshot_limit" && e.status === 429);
    await assert.rejects(sb.clone({ count: 0 }), WBXError);
    await assert.rejects(sb.clone({ count: 11 }), WBXError);
    assert.equal(s.calls.length, 2);
  } finally {
    await s.close();
  }
});

test("disabled feature maps to FeatureDisabledError", async () => {
  const s = await mockServer((req, res) =>
    sendJSON(res, 403, { error: "snapshots are not enabled for this account", code: "feature_disabled", feature: "snapshots" }),
  );
  try {
    await assert.rejects(client(s).snapshots.list(), (e) => e instanceof FeatureDisabledError && e.feature === "snapshots");
  } finally {
    await s.close();
  }
});

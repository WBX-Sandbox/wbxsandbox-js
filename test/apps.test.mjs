// Published apps and own domains against a mock server.
import assert from "node:assert/strict";
import { test } from "node:test";

import { App, FeatureDisabledError, NotFoundError, WBX } from "../dist/index.js";
import { SB, mockServer, sendJSON } from "./helpers.mjs";

const APP = {
  name: "dog-club",
  url: "https://dog-club.box.wbxbox.net/",
  sandbox_id: "sb_n1_abc",
  port: 8000,
  start_command: "python3 app.py",
  domains: [],
  created_at: "2026-11-26T15:00:00Z",
};
const DOM = {
  domain: "booking.example.com",
  state: "pending",
  dns: { cname: { type: "CNAME", name: "booking.example.com", value: "dog-club.box.wbxbox.net" }, root: [] },
};

function client(s) {
  return new WBX({ apiKey: "k", baseURL: s.url });
}

test("sandbox.publish() posts sandbox, port, name and start command", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.path === "/v1/sandboxes/sb_n1_abc" && c.method === "GET") return sendJSON(res, 200, SB);
    sendJSON(res, 201, APP);
  });
  try {
    const sb = await client(s).sandboxes.get("sb_n1_abc");
    const app = await sb.publish({ name: "dog-club", port: 8000, startCommand: "python3 app.py", cwd: "/home/user/dog-club" });
    assert.ok(app instanceof App);
    assert.equal(s.calls[1].method, "POST");
    assert.equal(s.calls[1].path, "/v1/apps");
    assert.deepEqual(s.calls[1].json, { sandbox_id: "sb_n1_abc", port: 8000, name: "dog-club", start_command: "python3 app.py", cwd: "/home/user/dog-club" });
    assert.equal(app.url, APP.url);
    assert.equal(app.sandboxId, "sb_n1_abc");
    assert.equal(app.port, 8000);
  } finally {
    await s.close();
  }
});

test("apps.list/get/unpublish and domains", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.method === "GET" && c.path === "/v1/apps") return sendJSON(res, 200, { apps: [APP] });
    if (c.method === "POST" && c.path === "/v1/apps/dog-club/domains") return sendJSON(res, 201, DOM);
    if (c.method === "DELETE" && c.path === "/v1/apps/gone") return sendJSON(res, 404, { error: "app not found" });
    if (c.method === "DELETE") return res.writeHead(204).end();
    sendJSON(res, 500, { error: "unexpected" });
  });
  try {
    const wbx = client(s);
    const apps = await wbx.apps.list();
    assert.deepEqual(apps.map((a) => a.name), ["dog-club"]);
    const app = await wbx.apps.get("dog-club");
    await assert.rejects(wbx.apps.get("nope"), NotFoundError);
    const d = await app.addDomain("booking.example.com");
    assert.equal(d.dns.cname.value, "dog-club.box.wbxbox.net");
    assert.deepEqual(app.domains.map((x) => x.domain), ["booking.example.com"]);
    assert.deepEqual(s.calls.at(-1).json, { domain: "booking.example.com" });
    await app.removeDomain("Booking.Example.com");
    assert.equal(s.calls.at(-1).path, "/v1/apps/dog-club/domains/booking.example.com");
    assert.deepEqual(app.domains, []);
    await app.unpublish();
    assert.equal(s.calls.at(-1).method, "DELETE");
    assert.equal(s.calls.at(-1).path, "/v1/apps/dog-club");
    await wbx.apps.unpublish("gone"); // 404 – bez chyby
  } finally {
    await s.close();
  }
});

test("publishing without a paid plan raises FeatureDisabledError", async () => {
  const s = await mockServer((req, res) => sendJSON(res, 403, { error: "feature apps is not enabled", code: "feature_disabled", feature: "apps" }));
  try {
    await assert.rejects(client(s).apps.publish("sb_n1_abc", { name: "x-app", port: 80 }), FeatureDisabledError);
  } finally {
    await s.close();
  }
});

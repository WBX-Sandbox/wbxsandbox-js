// Sandboxes, commands, files, processes, metrics and the desktop against a mock server.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CommandFailedError,
  ComputerActionError,
  ConnectionError,
  FeatureDisabledError,
  HumanInControlError,
  NotFoundError,
  Sandbox,
  StreamLimitError,
  TimeoutError,
  WBX,
} from "../dist/index.js";
import { SB, delay, mockServer, sendJSON } from "./helpers.mjs";

function client(s, extra = {}) {
  return new WBX({ apiKey: "k", baseURL: s.url, ...extra });
}

test("create maps camelCase options to the REST body and the sandbox exposes its record", async () => {
  const s = await mockServer((req, res, c) => sendJSON(res, 201, { ...SB, name: "proj", ip: "dual", info: { ipv6: "2001:db8::5" } }));
  try {
    const wbx = client(s);
    const sb = await wbx.sandboxes.create({
      template: "base",
      name: "proj",
      timeoutSeconds: 600,
      onTimeout: "pause",
      idleTimeoutSeconds: 300,
      keepDays: 7,
      metadata: { team: "a" },
      env: { A: "1" },
      vcpu: 2,
      memMb: 2048,
      computeClass: "balanced",
      optimizeFor: "price",
      placement: "spread",
      dependencyCache: false,
      network: { mode: "allowlist", allow: ["pypi.org"], ip: "dual" },
    });
    assert.deepEqual(s.calls[0].json, {
      template: "base",
      name: "proj",
      timeout_s: 600,
      on_timeout: "pause",
      idle_timeout_s: 300,
      keep_days: 7,
      metadata: { team: "a" },
      env: { A: "1" },
      vcpu: 2,
      mem_mb: 2048,
      compute_class: "balanced",
      optimize_for: "price",
      placement: "spread",
      dependency_cache: false,
      network: { mode: "allowlist", allow: ["pypi.org"], ip: "dual" },
    });
    assert.equal(s.calls[0].headers["content-type"], "application/json");
    assert.equal(sb.id, SB.id);
    assert.equal(sb.state, "running");
    assert.equal(sb.ipv6, "2001:db8::5");
    assert.equal(sb.existing, false);
    assert.equal(JSON.stringify(sb), JSON.stringify(sb.info));
    // empty create sends an empty object
    await wbx.sandboxes.create();
    assert.deepEqual(s.calls[1].json, {});
  } finally {
    await s.close();
  }
});

test("lifecycle calls hit the right endpoints and refresh the record", async () => {
  const s = await mockServer((req, res, c) => {
    const st = { "/sleep": "sleeping", "/pause": "paused", "/resume": "running", "/timeout": "running" };
    const suffix = c.path.replace(`/v1/sandboxes/${SB.id}`, "");
    if (c.method === "DELETE") return c.n === 7 ? sendJSON(res, 404, { error: "sandbox not found" }) : (res.writeHead(204), res.end());
    if (suffix === "/keep") return sendJSON(res, 200, { id: SB.id, keep_days: c.json.keep_days, default_keep_days: 7, max_keep_days: 30 });
    if (suffix === "/url") return sendJSON(res, 200, { sandbox_id: SB.id, port: Number(c.query.get("port")), host: "h", url: "https://h", url_with_token: "https://h?t", token: "t" });
    sendJSON(res, 200, { ...SB, state: st[suffix] ?? "running" });
  });
  try {
    const wbx = client(s);
    const sb = await wbx.sandboxes.get(SB.id);
    assert.equal((await sb.sleep()).state, "sleeping");
    assert.equal((await sb.pause()).state, "paused");
    assert.equal((await sb.resume()).state, "running");
    await sb.setTimeout(900.7);
    assert.deepEqual(s.calls[4].json, { timeout_s: 900 });
    const k = await sb.keep(14);
    assert.equal(k.keep_days, 14);
    assert.equal(s.calls[5].method, "PUT");
    await sb.kill(); // 404 → no error (7th call)
    const u = await sb.getUrl(8080);
    assert.equal(u.port, 8080);
    await wbx.sandboxes.kill(SB.id);
    assert.deepEqual(
      s.calls.map((c) => `${c.method} ${c.path.replace(SB.id, "ID")}`),
      [
        "GET /v1/sandboxes/ID",
        "POST /v1/sandboxes/ID/sleep",
        "POST /v1/sandboxes/ID/pause",
        "POST /v1/sandboxes/ID/resume",
        "POST /v1/sandboxes/ID/timeout",
        "PUT /v1/sandboxes/ID/keep",
        "DELETE /v1/sandboxes/ID",
        "GET /v1/sandboxes/ID/url",
        "DELETE /v1/sandboxes/ID",
      ],
    );
  } finally {
    await s.close();
  }
});

test("commands.run: body, result, check(), HTTP timeout follows the command timeout", async () => {
  const s = await mockServer((req, res, c) =>
    sendJSON(res, 200, c.json.cmd === "false"
      ? { exit_code: 1, stdout: "", stderr: "boom\n", duration_ms: 3, timed_out: false, truncated: false }
      : { exit_code: 0, stdout: "Python 3.12\n", stderr: "", duration_ms: 12, timed_out: false, truncated: true }),
  );
  try {
    const wbx = client(s, { timeoutMs: 1 }); // the client default must not limit a command
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(wbx.transport, SB);
    const r = await sb.commands.run("python3 --version", { env: { X: "1" }, cwd: "/tmp", stdin: "in", timeoutMs: 5000, maxOutputBytes: 1000 });
    assert.deepEqual(s.calls[0].json, { cmd: "python3 --version", env: { X: "1" }, cwd: "/tmp", timeout_ms: 5000, stdin: "in", max_output: 1000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "Python 3.12\n");
    assert.equal(r.truncated, true);
    assert.ok(r.ok);
    assert.equal(r.check(), r);
    const bad = await sb.commands.run("false");
    assert.equal(s.calls[1].json.timeout_ms, 60000, "default command timeout 60 s");
    assert.equal(bad.ok, false);
    assert.throws(() => bad.check(), (e) => e instanceof CommandFailedError && e.exitCode === 1 && /boom/.test(e.message));
  } finally {
    await s.close();
  }
});

test("commands.stream yields NDJSON events as they arrive; run() with callbacks streams", async () => {
  const s = await mockServer(async (req, res, c) => {
    assert.equal(c.path, `/v1/sandboxes/${SB.id}/exec/stream`);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write('{"type":"start","pid":42}\n{"type":"std');
    await delay(30);
    res.write('out","data":"hel"}\n{"type":"stdout","data":"lo\\n"}\n');
    await delay(30);
    res.write('{"type":"stderr","data":"warn\\n"}\n');
    res.end('{"type":"exit","exit_code":3,"duration_ms":70,"timed_out":false}\n');
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const evs = [];
    for await (const ev of sb.commands.stream("echo hello")) evs.push(ev);
    assert.deepEqual(evs.map((e) => e.type), ["start", "stdout", "stdout", "stderr", "exit"]);
    assert.equal(s.calls[0].json.timeout_ms, 0, "stream has no command limit by default");
    const out = [];
    const r = await sb.commands.run("echo hello", { onStdout: (d) => out.push(d) });
    assert.deepEqual(out, ["hel", "lo\n"]);
    assert.equal(r.stdout, "hello\n");
    assert.equal(r.stderr, "warn\n");
    assert.equal(r.exitCode, 3);
    assert.equal(s.calls[1].json.timeout_ms, 60000);
  } finally {
    await s.close();
  }
});

test("breaking out of a command stream closes the connection", async () => {
  let closed = false;
  const s = await mockServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    let gone = false;
    res.on("close", () => (closed = gone = true));
    for (let i = 0; i < 100 && !gone; i++) {
      res.write(`{"type":"stdout","data":"${i}"}\n`);
      await delay(10);
    }
    res.end();
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    for await (const ev of sb.commands.stream("yes")) {
      if (ev.type === "stdout") break;
    }
    await delay(100);
    assert.ok(closed);
    // abort via signal
    const ac = new AbortController();
    const got = [];
    const err = await (async () => {
      for await (const ev of sb.commands.stream("yes", { signal: ac.signal })) {
        got.push(ev);
        if (got.length === 2) ac.abort();
      }
    })().catch((e) => e);
    assert.equal(err?.name, "AbortError");
  } finally {
    await s.close();
  }
});

test("files: write/read bytes and text, list/stat/mkdir/move/remove, exists", async () => {
  const store = new Map();
  const s = await mockServer((req, res, c) => {
    const p = c.query.get("path");
    const base = `/v1/sandboxes/${SB.id}`;
    switch (`${c.method} ${c.path.replace(base, "")}`) {
      case "PUT /files":
        store.set(p, c.body);
        return sendJSON(res, 200, { path: p, size: c.body.length });
      case "GET /files":
        if (!store.has(p)) return sendJSON(res, 404, { error: "No such file or directory (os error 2)" });
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(store.get(p));
      case "GET /fs/list":
        return sendJSON(res, 200, [{ name: "a.txt", path: "/home/user/a.txt", type: "file", size: 3, mode: "0644", mtime_ms: 1 }]);
      case "GET /fs/stat":
        if (p === "/gone") return sendJSON(res, 404, { error: "No such file or directory (os error 2)" });
        if (p === "/nobox") return sendJSON(res, 404, { error: "sandbox not found" });
        return sendJSON(res, 200, { name: "x", path: p, type: "file", size: 1, mode: "0644", mtime_ms: 1 });
      case "POST /fs/mkdir":
      case "POST /fs/move":
        return sendJSON(res, 200, { name: "x", path: c.json.path ?? c.json.to, type: "dir", size: 0, mode: "0755", mtime_ms: 1 });
      case "POST /fs/remove":
        res.writeHead(204);
        return res.end();
    }
    sendJSON(res, 404, { error: "?" });
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const w = await sb.files.write("/home/user/t.txt", "žluť");
    assert.equal(w.size, 6);
    assert.equal(s.calls[0].headers["content-type"], "application/octet-stream");
    assert.equal(await sb.files.readText("/home/user/t.txt"), "žluť");
    const bin = new Uint8Array([0, 255, 1, 2]);
    await sb.files.write("/b", bin);
    assert.deepEqual(await sb.files.read("/b"), bin);
    // streamed upload
    await sb.files.write("/s", new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([7, 8])), c.close()) }));
    assert.deepEqual(await sb.files.read("/s"), new Uint8Array([7, 8]));
    const rs = await sb.files.readStream("/b");
    const chunks = [];
    for await (const ch of rs) chunks.push(...ch);
    assert.deepEqual(new Uint8Array(chunks), bin);
    await assert.rejects(sb.files.read("/missing"), NotFoundError);
    const ls = await sb.files.list("/home/user", { depth: 2 });
    assert.equal(ls[0].type, "file");
    assert.equal(s.calls.at(-1).query.get("depth"), "2");
    assert.equal(await sb.files.exists("/x"), true);
    assert.equal(await sb.files.exists("/gone"), false);
    await assert.rejects(sb.files.exists("/nobox"), NotFoundError);
    await sb.files.mkdir("/d");
    assert.deepEqual(s.calls.at(-1).json, { path: "/d", parents: true });
    await sb.files.move("/a", "/b", { overwrite: true });
    assert.deepEqual(s.calls.at(-1).json, { from: "/a", to: "/b", overwrite: true });
    await sb.files.remove("/d");
    assert.deepEqual(s.calls.at(-1).json, { path: "/d", recursive: false });
    await sb.files.remove("/d", { recursive: true });
    assert.deepEqual(s.calls.at(-1).json, { path: "/d", recursive: true });
  } finally {
    await s.close();
  }
});

test("runCode writes a temporary file and runs it with the right interpreter", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.method === "PUT") return sendJSON(res, 200, { path: c.query.get("path"), size: c.body.length });
    sendJSON(res, 200, { exit_code: 0, stdout: "4950\n", stderr: "", duration_ms: 5, timed_out: false, truncated: false });
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const r = await sb.runCode("print(sum(range(100)))");
    assert.equal(r.stdout, "4950\n");
    const file = s.calls[0].query.get("path");
    assert.match(file, /^\/tmp\/_wbx_code_[0-9a-f]{32}\.py$/);
    assert.equal(s.calls[1].json.cmd, `python3 ${file}; rc=$?; rm -f ${file}; exit $rc`);
    await sb.runCode("console.log(1)", { language: "node" });
    assert.match(s.calls[3].json.cmd, /^node \/tmp\/_wbx_code_[0-9a-f]{32}\.js;/);
    await assert.rejects(sb.runCode("x", { language: "ruby" }), /unsupported language/);
  } finally {
    await s.close();
  }
});

test("processes: start, list, stream, stdin (text and bytes), signal, resize, kill", async () => {
  const s = await mockServer(async (req, res, c) => {
    const rest = c.path.replace(`/v1/sandboxes/${SB.id}/process`, "");
    if (c.method === "POST" && rest === "") return sendJSON(res, 200, { pid: 9 });
    if (c.method === "GET" && rest === "") return sendJSON(res, 200, [{ pid: 9, cmd: "srv", tag: "web", pty: false, running: true, exit_code: null, started_ms: 1 }]);
    if (rest === "/9/stream") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      return res.end('{"type":"start","pid":9,"truncated":false}\n{"type":"stdout","data":"x"}\n{"type":"exit","exit_code":0}\n');
    }
    res.writeHead(204);
    res.end();
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    assert.deepEqual(await sb.processes.start("python3 -m http.server", { tag: "web", pty: { cols: 80, rows: 24 }, stdin: true }), { pid: 9 });
    assert.deepEqual(s.calls[0].json, { cmd: "python3 -m http.server", tag: "web", pty: { cols: 80, rows: 24 }, stdin: true });
    assert.equal((await sb.processes.list())[0].tag, "web");
    const evs = [];
    for await (const e of sb.processes.stream(9, { replay: false })) evs.push(e.type);
    assert.deepEqual(evs, ["start", "stdout", "exit"]);
    assert.equal(s.calls[2].query.get("replay"), "false");
    await sb.processes.sendStdin(9, "ls\n");
    assert.deepEqual(s.calls[3].json, { data: "ls\n", eof: false });
    await sb.processes.sendStdin(9, new Uint8Array([3]), { eof: true });
    assert.deepEqual(s.calls[4].json, { data_b64: "Aw==", eof: true });
    await sb.processes.signal(9, "SIGTERM");
    assert.deepEqual(s.calls[5].json, { signal: "SIGTERM" });
    await sb.processes.resize(9, 120, 40);
    await sb.processes.kill(9);
    assert.equal(s.calls[7].method, "DELETE");
  } finally {
    await s.close();
  }
});

test("metrics: current values, history with since, feature switched off", async () => {
  const s = await mockServer((req, res, c) => {
    if (c.path.endsWith("/metrics")) return sendJSON(res, 200, { cpu_count: 2, cpu_used_pct: 12.5, mem_total_mb: 1000, mem_used_mb: 200, disk_total_mb: 5000, disk_used_mb: 100 });
    if (c.headers["x-api-key"] === "off") return sendJSON(res, 403, { error: "feature metrics_history is not enabled for this account", code: "feature_disabled", feature: "metrics_history" });
    sendJSON(res, 200, { source: "host", interval_s: 10, retention_s: 3600, vcpu: 2, mem_mb: 1024, state: "running", samples: [{ t: 5, cpu_pct: 1 }] });
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    assert.equal((await sb.metrics.get()).cpu_used_pct, 12.5);
    const since = new Date(1_700_000_000_000);
    const h = await sb.metrics.history({ since });
    assert.equal(h.interval_s, 10);
    assert.equal(s.calls[1].query.get("since"), "1700000000000");
    assert.equal(s.calls[1].path, `/v1/sandboxes/${SB.id}/metrics/history`);
    const off = new Sandbox(new WBX({ apiKey: "off", baseURL: s.url }).transport, SB);
    const err = await off.metrics.history().catch((e) => e);
    assert.ok(err instanceof FeatureDisabledError);
    assert.equal(err.feature, "metrics_history");
  } finally {
    await s.close();
  }
});

test("metrics.stream: state, samples, pings, end reason; reconnect only after timeout, with since", async () => {
  let scenario = "timeout";
  const s = await mockServer(async (req, res, c) => {
    assert.equal(c.headers.accept, "text/event-stream");
    if (scenario === "limited") {
      scenario = "timeout";
      return sendJSON(res, 429, { error: "too many metric streams", code: "rate_limited" }, { "Retry-After": "0" });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('event: state\ndata: {"state":"running","interval_s":10}\n\n');
    if (c.query.get("since")) {
      // resumed: the server first sends missed samples (since = last seen + 1), possibly overlapping
      res.write('event: sample\ndata: {"t":2,"cpu_pct":6}\n\nevent: sample\ndata: {"t":3,"cpu_pct":7}\n\n');
      res.write('event: state\ndata: {"state":"sleeping"}\n\n');
      return res.end('event: end\ndata: {"reason":"not_running"}\n\n');
    }
    res.write(": ping\n\nevent: sample\ndata: {\"t\":1,\"cpu_pct\":5}\n\n");
    await delay(20);
    res.write("event: sample\ndata: {\"t\":2,\n");
    await delay(20);
    res.write("data: \"cpu_pct\":6}\n\n: ping\n\nevent: end\ndata: {\"reason\":\"timeout\"}\n\n");
    res.end();
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const once = [];
    const states = [];
    const ends = [];
    for await (const x of sb.metrics.stream({ onState: (st) => states.push(st.state), onEnd: (r) => ends.push(r) })) once.push(x.t);
    assert.deepEqual(once, [1, 2], "multi-line data joined; ends at event: end");
    assert.deepEqual(states, ["running"]);
    assert.deepEqual(ends, ["timeout"]);
    assert.equal(s.calls[0].query.get("since"), null);
    const all = [];
    const ends2 = [];
    for await (const x of sb.metrics.stream({ reconnect: true, onEnd: (r) => ends2.push(r) })) all.push(x.t);
    assert.deepEqual(all, [1, 2, 3], "duplicates skipped after resuming");
    assert.deepEqual(ends2, ["timeout", "not_running"], "not resumed after not_running");
    assert.equal(s.calls[2].query.get("since"), "3", "resumes after the last seen sample");
    assert.equal(s.calls.length, 3);
    // a rate-limited reconnect waits for Retry-After and tries again; since is passed from the start
    scenario = "limited";
    const got = [];
    for await (const x of sb.metrics.stream({ reconnect: true, since: 2 })) got.push(x.t);
    assert.deepEqual(got, [2, 3]);
    assert.equal(s.calls[3].query.get("since"), "2");
    // without reconnect a 429 is thrown
    scenario = "limited";
    const err = await (async () => { for await (const _ of sb.metrics.stream()) {} })().catch((e) => e);
    assert.equal(err?.code, "rate_limited");
  } finally {
    await s.close();
  }
});

test("computer: status, screenshot bytes and size, actions with base64 screenshot, convenience methods, 409", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const s = await mockServer((req, res, c) => {
    const rest = c.path.replace(`/v1/sandboxes/${SB.id}/computer`, "");
    if (rest === "/status") return sendJSON(res, 200, { available: true, display: ":0", width: 1280, height: 800, controller: "agent", controller_until: null, viewers: 0 });
    if (rest === "/screenshot") {
      res.writeHead(200, { "Content-Type": "image/jpeg", "X-WBX-Width": "640", "X-WBX-Height": "400" });
      return res.end(png);
    }
    if (rest === "/control") return sendJSON(res, 200, { controller: c.json.mode });
    if (c.json.actions[0].type === "key" && c.json.actions[0].keys === "ctrl+alt+del") {
      return sendJSON(res, 409, { error: "a person controls the desktop", code: "human_in_control" });
    }
    sendJSON(res, 200, {
      ok: true,
      results: c.json.actions.map(() => ({ ok: true })),
      ...(c.json.screenshot ? { screenshot: { format: "png", width: 1280, height: 800, data_base64: Buffer.from(png).toString("base64") } } : {}),
    });
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    assert.equal((await sb.computer.status()).controller, "agent");
    const shot = await sb.computer.screenshot({ format: "jpeg", quality: 70, maxWidth: 640 });
    assert.deepEqual(shot.data, png);
    assert.equal(shot.format, "jpeg");
    assert.equal(shot.width, 640);
    assert.equal(shot.height, 400);
    assert.equal(s.calls[1].query.get("max_width"), "640");
    assert.equal(s.calls[1].query.get("quality"), "70");
    const r = await sb.computer.click(10, 20, { button: "right", screenshot: true });
    assert.deepEqual(s.calls[2].json, { actions: [{ type: "click", x: 10, y: 20, button: "right" }], screenshot: true });
    assert.deepEqual(r.screenshot.data, png);
    assert.equal(r.screenshot.width, 1280);
    await sb.computer.doubleClick(1, 2);
    assert.deepEqual(s.calls[3].json.actions, [{ type: "click", x: 1, y: 2, count: 2 }]);
    await sb.computer.type("hello");
    await sb.computer.key("ctrl+c");
    await sb.computer.scroll(5, 6, 0, 3);
    await sb.computer.drag(1, 2, 3, 4);
    await sb.computer.move(7, 8);
    await sb.computer.wait(250);
    assert.deepEqual(
      s.calls.slice(4, 10).map((c) => c.json.actions[0]),
      [
        { type: "type", text: "hello" },
        { type: "key", keys: "ctrl+c" },
        { type: "scroll", x: 5, y: 6, dx: 0, dy: 3 },
        { type: "drag", x: 1, y: 2, to_x: 3, to_y: 4 },
        { type: "move", x: 7, y: 8 },
        { type: "wait", ms: 250 },
      ],
    );
    assert.equal(s.calls[4].json.screenshot, false);
    const err = await sb.computer.key("ctrl+alt+del").catch((e) => e);
    assert.ok(err instanceof HumanInControlError);
    assert.equal(err.status, 409);
    const n = s.calls.length;
    assert.equal(n, 11, "actions are not retried");
    assert.deepEqual(await sb.computer.control("human", { ttlSeconds: 300 }), { controller: "human" });
    assert.deepEqual(s.calls[11].json, { mode: "human", ttl_s: 300 });
  } finally {
    await s.close();
  }
});

test("computer.actions: ok:false throws ComputerActionError (or is returned with throwOnFailure: false); screenshot options and sizes", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
  const s = await mockServer((req, res, c) => {
    const rest = c.path.replace(`/v1/sandboxes/${SB.id}/computer`, "");
    if (rest === "/screenshot") {
      res.writeHead(200, { "Content-Type": "image/png", "X-WBX-Width": "800", "X-WBX-Height": "500", "X-WBX-Screen-Width": "1280", "X-WBX-Screen-Height": "800" });
      return res.end(png);
    }
    if (rest === "/status") {
      return sendJSON(res, 200, { available: true, display: ":0", width: 1280, height: 800, controller: "human", controller_until: 1_800_000_000_000, viewers: 1 });
    }
    const acts = c.json.actions;
    if (acts.some((a) => a.type === "key" && a.keys === "bad")) {
      // the server stops at the failed action and answers 200 with ok:false
      return sendJSON(res, 200, {
        ok: false,
        error: "actions[1] (key) failed: the action failed (exit code 1)",
        failed_index: 1,
        results: [{ type: "move", ok: true }, { type: "key", ok: false, error: "the action failed (exit code 1)" }],
      });
    }
    if (acts[0].type === "wait") {
      return sendJSON(res, 200, { ok: true, results: [{ type: "wait", ok: true }], screenshot_error: "the sandbox returned an invalid screenshot" });
    }
    sendJSON(res, 200, {
      ok: true,
      results: acts.map((a) => ({ type: a.type, ok: true })),
      ...(c.json.screenshot
        ? { screenshot: { format: "jpeg", width: 800, height: 500, screen_width: 1280, screen_height: 800, data_base64: Buffer.from(png).toString("base64") } }
        : {}),
    });
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const bad = [{ type: "move", x: 1, y: 1 }, { type: "key", keys: "bad" }, { type: "type", text: "never" }];
    const err = await sb.computer.actions(bad).catch((e) => e);
    assert.ok(err instanceof ComputerActionError, "ok:false is not a silent success");
    assert.equal(err.failedIndex, 1);
    assert.equal(err.results.length, 2);
    assert.equal(err.results[1].ok, false);
    assert.match(err.message, /actions\[1\] \(key\) failed/);
    const soft = await sb.computer.actions(bad, { throwOnFailure: false });
    assert.equal(soft.ok, false);
    assert.equal(soft.failedIndex, 1);
    assert.match(soft.error, /exit code 1/);
    assert.equal(soft.results[0].type, "move");
    await assert.rejects(sb.computer.key("bad"), ComputerActionError, "convenience methods throw too");
    // screenshot options of the actions request, and the screen size next to the image size
    const r = await sb.computer.actions(
      [{ type: "mouse_down", x: 5, y: 6, button: "left" }, { type: "mouse_up" }],
      { screenshot: true, screenshotFormat: "jpeg", screenshotQuality: 60, screenshotMaxWidth: 800 },
    );
    assert.deepEqual(s.calls.at(-1).json, {
      actions: [{ type: "mouse_down", x: 5, y: 6, button: "left" }, { type: "mouse_up" }],
      screenshot: true,
      screenshot_format: "jpeg",
      screenshot_quality: 60,
      screenshot_max_width: 800,
    });
    assert.equal(r.ok, true);
    assert.equal(r.error, undefined);
    assert.equal(r.screenshot.width, 800);
    assert.equal(r.screenshot.screenWidth, 1280);
    assert.equal(r.screenshot.screenHeight, 800);
    const n = s.calls.length;
    await assert.rejects(sb.computer.move(1, 2, { screenshotFormat: "jpeg" }), TypeError);
    assert.equal(s.calls.length, n, "screenshot options without screenshot: true are not sent");
    const w = await sb.computer.wait(10, { screenshot: true });
    assert.equal(w.screenshotError, "the sandbox returned an invalid screenshot");
    assert.equal(w.screenshot, undefined);
    const shot = await sb.computer.screenshot({ maxWidth: 800 });
    assert.equal(shot.width, 800);
    assert.equal(shot.screenWidth, 1280);
    assert.equal(shot.screenHeight, 800);
    const st = await sb.computer.status();
    assert.equal(typeof st.controller_until, "number");
  } finally {
    await s.close();
  }
});

test("streams: an NDJSON line over maxStreamEventSize throws StreamLimitError and closes the connection", async () => {
  let closed = false;
  const s = await mockServer(async (req, res, c) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.on("close", () => (closed = true));
    res.write('{"type":"stdout","data":"ok"}\n');
    // a line that never ends
    for (let i = 0; i < 50 && !closed; i++) {
      res.write("x".repeat(1000));
      await delay(1);
    }
    res.end("\n");
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s, { maxStreamEventSize: 4096 }).transport, SB);
    const got = [];
    const err = await (async () => {
      for await (const ev of sb.commands.stream("cat big")) got.push(ev);
    })().catch((e) => e);
    assert.ok(err instanceof StreamLimitError, String(err));
    assert.equal(err.limit, 4096);
    assert.deepEqual(got, [{ type: "stdout", data: "ok" }]);
    await delay(50);
    assert.ok(closed, "the connection is closed");
  } finally {
    await s.close();
  }
});

test("metrics.stream: connections that end right after opening back off and give up; the connect rate is capped", async () => {
  let scenario = "drop";
  const s = await mockServer(async (req, res, c) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (scenario === "huge") return res.end(`event: sample\ndata: ${"9".repeat(5000)}\n\n`);
    res.end('event: state\ndata: {"state":"running"}\n\n'); // ends without `end`
  });
  try {
    const { Sandbox } = await import("../dist/index.js");
    const sb = new Sandbox(client(s).transport, SB);
    const t0 = Date.now();
    const guard = AbortSignal.timeout(10_000);
    const err = await (async () => {
      for await (const _ of sb.metrics.stream({ reconnect: true, maxReconnects: 2, signal: guard })) {}
    })().catch((e) => e);
    assert.ok(err instanceof ConnectionError, `gives up instead of looping: ${err}`);
    assert.equal(s.calls.length, 3, "first connection + 2 reconnects");
    assert.ok(Date.now() - t0 >= 700, "reconnects wait with backoff (≥ 250 + 500 ms)");
    // at most maxConnectsPerMinute connections a minute – the next one waits
    const before = s.calls.length;
    const err2 = await (async () => {
      for await (const _ of sb.metrics.stream({ reconnect: true, maxReconnects: 10, maxConnectsPerMinute: 1, signal: AbortSignal.timeout(1500) })) {}
    })().catch((e) => e);
    assert.equal(err2?.name, "TimeoutError", "ended by the caller's signal while waiting");
    assert.equal(s.calls.length - before, 1, "no second connection within the minute");
    // a too large event is not retried
    scenario = "huge";
    const before3 = s.calls.length;
    const small = new Sandbox(client(s, { maxStreamEventSize: 1000 }).transport, SB);
    const err3 = await (async () => {
      for await (const _ of small.metrics.stream({ reconnect: true })) {}
    })().catch((e) => e);
    assert.ok(err3 instanceof StreamLimitError);
    assert.equal(s.calls.length - before3, 1);
  } finally {
    await s.close();
  }
});

test("computer.actions: HTTP limit is 5 min by default (not the client's timeoutMs); timeoutMs of the call overrides it", async () => {
  const s = await mockServer(async (req, res, c) => {
    await delay(200);
    if (c.path.endsWith("/status")) return sendJSON(res, 200, { available: true });
    sendJSON(res, 200, { ok: true, results: c.json.actions.map((a) => ({ type: a.type, ok: true })) });
  });
  try {
    const sb = new Sandbox(client(s, { timeoutMs: 50, maxRetries: 0 }).transport, SB);
    // other calls follow the client's 50 ms …
    await assert.rejects(sb.computer.status(), TimeoutError);
    // … actions and the shortcuts do not
    assert.equal((await sb.computer.actions([{ type: "wait", ms: 100 }])).ok, true);
    assert.equal((await sb.computer.type("x".repeat(8192))).ok, true);
    assert.equal((await sb.computer.scroll(1, 2, 0, 3)).ok, true);
    assert.deepEqual(s.calls.at(-1).json.actions, [{ type: "scroll", x: 1, y: 2, dx: 0, dy: 3 }], "order is (x, y, dx, dy)");
    // an explicit timeoutMs still wins
    await assert.rejects(sb.computer.click(1, 1, { timeoutMs: 50 }), TimeoutError);
  } finally {
    await s.close();
  }
});

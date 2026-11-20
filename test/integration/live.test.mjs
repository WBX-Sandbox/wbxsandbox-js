// Integration tests against a real WBX Sandbox API. They run only with an API key:
//
//   WBX_API_KEY=... [WBX_API_URL=https://sandbox.wbx.cz] npm run test:integration
//
// (WBXSANDBOX_API_KEY / WBXSANDBOX_URL work too.) Every sandbox they create is killed at the
// end; the job tests cost a few cents at most. Without a key every test is skipped.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { FeatureDisabledError, NotFoundError, WBX } from "../../dist/index.js";

const apiKey = process.env.WBX_API_KEY || process.env.WBXSANDBOX_API_KEY;
const baseURL = process.env.WBX_API_URL || process.env.WBXSANDBOX_URL || undefined;
const skip = apiKey ? false : "set WBX_API_KEY to run the integration tests";

describe("live API", { skip, timeout: 15 * 60_000 }, () => {
  const wbx = new WBX({ apiKey, baseURL });
  const created = [];
  after(async () => {
    await Promise.all(created.map((sb) => sb.kill().catch(() => {})));
  });

  test("templates and features", async () => {
    const tpls = await wbx.templates.list();
    assert.ok(tpls.some((t) => t.name === "base"));
    const f = await wbx.features();
    assert.equal(typeof f, "object");
  });

  test("sandbox: commands, stream, code, files, metrics, sleep and wake", async () => {
    const sb = await wbx.sandboxes.create({ template: "base", timeoutSeconds: 600, metadata: { sdk: "ts-integration" } });
    created.push(sb);
    assert.equal(sb.state, "running");

    const r = await sb.commands.run("echo hello && echo oops >&2 && exit 3");
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, "hello\n");
    assert.equal(r.stderr, "oops\n");

    const types = [];
    for await (const ev of sb.commands.stream("for i in 1 2; do echo $i; sleep 0.2; done")) types.push(ev.type);
    assert.equal(types[0], "start");
    assert.equal(types.at(-1), "exit");

    assert.equal((await sb.runCode("print(6 * 7)")).stdout, "42\n");

    const bytes = new Uint8Array(256).map((_, i) => i);
    await sb.files.write("/home/user/sdk/bin.dat", bytes);
    assert.deepEqual(await sb.files.read("/home/user/sdk/bin.dat"), bytes);
    assert.equal(await sb.files.exists("/home/user/sdk/bin.dat"), true);
    assert.equal(await sb.files.exists("/home/user/sdk/none"), false);
    await sb.files.move("/home/user/sdk/bin.dat", "/home/user/sdk/moved.dat");
    assert.ok((await sb.files.list("/home/user/sdk")).some((e) => e.name === "moved.dat"));
    await sb.files.remove("/home/user/sdk", { recursive: true });
    await assert.rejects(sb.files.stat("/home/user/sdk"), NotFoundError);

    const m = await sb.metrics.get();
    assert.ok(m.cpu_count >= 1);
    try {
      const h = await sb.metrics.history();
      assert.equal(h.source, "host");
    } catch (e) {
      assert.ok(e instanceof FeatureDisabledError || e instanceof NotFoundError, String(e));
    }

    const p = await sb.processes.start("sleep 30", { tag: "sdk" });
    assert.ok((await sb.processes.list()).some((x) => x.pid === p.pid));
    await sb.processes.kill(p.pid);

    await sb.sleep();
    assert.ok(["sleeping", "falling_asleep"].includes((await sb.refresh()).state), sb.state);
    // any request wakes it up
    assert.equal((await sb.commands.run("true")).exitCode, 0);
  });

  test("job: submit, wait, logs, receipt", async () => {
    const job = await wbx.jobs.create({ command: "mkdir -p output && echo 42 > output/a.txt && echo done", timeoutSeconds: 300, saveArtifacts: true });
    await job.wait({ timeoutMs: 10 * 60_000 });
    assert.equal(job.status, "completed");
    assert.match(await job.logText(), /done/);
    assert.equal(new TextDecoder().decode(await job.download("output/a.txt")), "42\n");
    assert.equal((await job.receipt()).job_id, job.id);
  });

  test("errors: unknown sandbox", async () => {
    await assert.rejects(wbx.sandboxes.get("sb_nope_000000"), NotFoundError);
  });
});

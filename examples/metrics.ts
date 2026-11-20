// Live metrics of a sandbox (needs the metrics_history feature on your account).
import { FeatureDisabledError, WBX } from "wbxsandbox";

const wbx = new WBX();
const sandbox = await wbx.sandboxes.create({ template: "base" });

try {
  console.log("now (inside the VM):", await sandbox.metrics.get());

  // generate some load in the background
  await sandbox.processes.start("python3 -c 'while True: pass'", { tag: "load" });

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60_000); // stop after a minute
  try {
    for await (const s of sandbox.metrics.stream({ signal: ac.signal, reconnect: true })) {
      console.log(new Date(s.t).toISOString(), `cpu ${s.cpu_pct}%`, `mem ${s.mem_mb} MB`, `net in ${s.net_rx_bps} B/s`);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  }

  const h = await sandbox.metrics.history({ since: Date.now() - 5 * 60_000 });
  console.log(`${h.samples.length} samples every ${h.interval_s} s`);
} catch (e) {
  if (e instanceof FeatureDisabledError) console.log(`feature ${e.feature} is not enabled for this account`);
  else throw e;
} finally {
  await sandbox.kill();
}

// A batch with dependencies: prepare data once, then process it in parallel, then merge.
import { WBX } from "wbxsandbox";

const wbx = new WBX();

const parts = [0, 1, 2, 3];
const batch = await wbx.batches.create({
  name: "pipeline",
  defaults: { template: "base", timeoutSeconds: 600, saveArtifacts: true },
  maxConcurrency: 4,
  maxTotalCost: "0.50",
  jobs: [
    // job 0: prepare
    { command: "mkdir -p output && seq 1 1000 > output/numbers.txt" },
    // jobs 1–4: each gets job 0's file as input/numbers.txt
    ...parts.map((i) => ({
      command: `mkdir -p output && awk 'NR % 4 == ${i} { s += $1 } END { print s }' input/numbers.txt > output/sum.txt`,
      dependsOn: [0],
      inputs: [{ fromIndex: 0, name: "output/numbers.txt" }],
    })),
    // job 5: merge the partial sums
    {
      command: "cat input/*.txt | awk '{ s += $1 } END { print s }'",
      dependsOn: parts.map((i) => i + 1),
      inputs: parts.map((i) => ({ fromIndex: i + 1, name: "output/sum.txt", as: `sum${i}.txt` })),
    },
  ],
});
console.log(batch.id, batch.jobIds.length, "jobs");

await batch.wait({ timeoutMs: 30 * 60_000 });
const report = await batch.report();
console.log(report.summary.status, report.summary.cost, report.summary.currency);
for (const row of report.jobs) console.log(row.index, row.status, row.exit_code ?? "", row.error_code ?? "");

// A failed job does not stop independent ones – retry just the failed ones:
for (const id of report.summary.failed_jobs ?? []) {
  const retried = await (await wbx.jobs.get(id)).retry();
  console.log("retrying", id, "as", retried.id);
}

const last = await wbx.jobs.get(batch.jobIds.at(-1)!);
console.log("total:", (await last.logText()).trim());

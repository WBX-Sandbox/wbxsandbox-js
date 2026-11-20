// A background job: submit, wait without an open connection, read the log and a result file.
import { WBX } from "wbxsandbox";

const wbx = new WBX();

const job = await wbx.jobs.create({
  command: "mkdir -p output && python3 -c 'import json; json.dump({\"answer\": 42}, open(\"output/result.json\", \"w\"))' && echo done",
  template: "base",
  timeoutSeconds: 600,
  saveArtifacts: true, // keep everything under output/
  maxCost: "0.05", // price limit in your billing currency
});
console.log("submitted", job.id, job.status);

// Follow the log while it runs…
for await (const text of job.follow()) process.stdout.write(text);

// …or just wait (server-side waiting, no polling) – with a time limit.
await job.wait({ timeoutMs: 10 * 60_000 });
const summary = await job.summary();
console.log(summary.status, summary.exit_code, summary.cost);

if (job.status === "completed") {
  const bytes = await job.download("output/result.json"); // SHA-256 verified
  console.log(JSON.parse(new TextDecoder().decode(bytes)));
} else {
  console.log((await job.digest({ mode: "errors" })).text);
}

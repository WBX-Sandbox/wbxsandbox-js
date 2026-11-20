# wbxsandbox – TypeScript SDK for WBX Sandbox

Official TypeScript / JavaScript SDK for [WBX Sandbox](https://sandbox.wbx.cz): isolated cloud
sandboxes for AI agents and code execution. Every sandbox is a Firecracker microVM with its own
Linux kernel, disk and network rules.

- Sandboxes: commands (also streamed), code, files, background processes, public URLs, sleep and wake
- Background jobs and batches: no open connection, logs, result files, signed execution receipts
- Live metrics and desktop control (computer use) for agents
- Typed errors, timeouts, `AbortSignal` everywhere, safe automatic retries
- Zero runtime dependencies – only `fetch`, `ReadableStream` and Web Crypto; runs on Node.js 20+,
  Deno, Bun and edge runtimes

> **Status:** 0.x – see [Versioning and compatibility](#versioning-and-compatibility).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Authentication and configuration](#authentication-and-configuration)
- [Sandboxes](#sandboxes)
- [Commands and code](#commands-and-code)
- [Files](#files)
- [Background processes](#background-processes)
- [Background jobs](#background-jobs)
- [Batches](#batches)
- [Metrics](#metrics) (feature `metrics_history`)
- [Desktop control](#desktop-control) (feature `desktop`)
- [Account: templates, budget, compute classes, webhooks](#account)
- [Errors](#errors)
- [Timeouts and cancellation](#timeouts-and-cancellation)
- [Retries](#retries)
- [Pagination](#pagination)
- [Runtimes](#runtimes)
- [Versioning and compatibility](#versioning-and-compatibility)
- [Links](#links)

## Install

```sh
npm install wbxsandbox
```

Requires Node.js 20 or newer (or Deno, Bun, a browser-like edge runtime). The package is ESM
only and ships its own type declarations.

## Quick start

```ts
import { WBX } from "wbxsandbox";

const wbx = new WBX({ apiKey: process.env.WBXSANDBOX_API_KEY! });

const sandbox = await wbx.sandboxes.create({ template: "base", name: "my-project" });
const r = await sandbox.commands.run("python3 --version");
console.log(r.stdout);

await sandbox.sleep(); // files kept, no compute billed; the next request wakes it up
```

More in [`examples/`](examples): a sandbox, a job with waiting and logs, a batch with
dependencies, a metrics stream, desktop control and a framework-agnostic tool for an AI model.

## Authentication and configuration

Create an API key in the portal (**Settings → API keys**). The SDK sends it in the `X-API-Key`
header – never in a URL.

```ts
const wbx = new WBX({
  apiKey: "…",                       // default: WBXSANDBOX_API_KEY
  baseURL: "https://sandbox.wbx.cz", // default: WBXSANDBOX_URL, else https://sandbox.wbx.cz
  timeoutMs: 60_000,                 // per HTTP attempt (methods that wait longer set their own)
  maxRetries: 2,                     // for safe requests only, see Retries
  maxRetryDelayMs: 60_000,           // longest Retry-After the client is willing to wait
  fetch: customFetch,                // optional – e.g. a proxy-aware fetch
  headers: { "X-Trace": "…" },       // added to every request
  maxStreamEventSize: 16_777_216,    // longest streamed event / NDJSON line (characters, 16 MiB)
});
```

The key is kept in a private field: it is not readable from `wbx.transport.config`, and
`console.log(wbx)`, `util.inspect()` and `JSON.stringify()` of the client, sandboxes, jobs,
batches and errors never contain it – safe for logs and error trackers.

The environment variables are the same as for the Python SDK (`WBXSANDBOX_API_KEY`,
`WBXSANDBOX_URL`). A missing key raises `AuthenticationError` before any request is sent.

## Sandboxes

```ts
const sandbox = await wbx.sandboxes.create({
  template: "base",            // see wbx.templates.list()
  timeoutSeconds: 600,         // lifetime; extend with sandbox.setTimeout()
  name: "my-project",          // reuse: an existing sandbox with this name is returned (woken up)
  onTimeout: "pause",          // fall asleep instead of being destroyed – files are kept
  idleTimeoutSeconds: 600,     // …or after this long without requests
  keepDays: 30,                // keep it this long while asleep (plan maximum applies)
  env: { OPENAI_API_KEY: "…" },
  metadata: { user: "42" },
  computeClass: "balanced",    // never downgraded
  network: { mode: "allowlist", allow: ["pypi.org", "files.pythonhosted.org"], ip: "dual" },
});

sandbox.id;        // "sb_…"
sandbox.state;     // "running"
sandbox.existing;  // true when create({ name }) returned an existing sandbox
sandbox.ipv6;      // public IPv6 address with network.ip "dual" / "ipv6"
sandbox.info;      // the API record (snake_case fields)

await sandbox.setTimeout(3600);
const { url_with_token } = await sandbox.getUrl(8080); // public HTTPS address of a port
await sandbox.keep(14);       // days to keep it after it falls asleep
await sandbox.sleep();        // files kept, programs stop, no compute billed
await sandbox.resume();       // or any other request wakes it up
await sandbox.pause();        // freeze with memory; resume() continues where it stopped
await sandbox.refresh();      // reload the record
await sandbox.kill();         // destroy with its data (no error if already gone)

const again = await wbx.sandboxes.get(sandbox.id); // attach later, e.g. in the next turn
const all = await wbx.sandboxes.list();
```

Records returned by the API keep the API's own field names (`created_at`, `exit_code`, …), so
the [REST documentation](https://sandbox.wbx.cz/docs/api) applies to them unchanged. Options
you pass to the SDK are camelCase.

## Commands and code

```ts
const r = await sandbox.commands.run("pip install -q requests && python3 app.py", {
  cwd: "/home/user",
  env: { DEBUG: "1" },
  timeoutMs: 120_000,  // the command is killed after this (r.timedOut); default 60 s, 0 = no limit
  stdin: "input data",
});
r.exitCode; r.stdout; r.stderr; r.durationMs; r.timedOut; r.truncated; r.ok;
r.check(); // throws CommandFailedError unless exit code 0

// live output
await sandbox.commands.run("make test", { onStdout: (d) => process.stdout.write(d) });

// events as an async iterator: start → stdout/stderr … → exit
for await (const ev of sandbox.commands.stream("pytest -q")) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
  if (ev.type === "exit") console.log("exit code", ev.exit_code);
}

// a piece of code: python (default), node or bash
const out = await sandbox.runCode("print(sum(range(100)))");
```

A non-zero exit code is a normal result, not an exception. Breaking out of a stream (or
aborting its signal) disconnects, which kills the command.

## Files

```ts
await sandbox.files.write("/home/user/data.csv", "a,b\n1,2\n");      // string, Uint8Array, Blob or ReadableStream
const bytes = await sandbox.files.read("/home/user/data.csv");       // Uint8Array
const text = await sandbox.files.readText("/home/user/data.csv");
const stream = await sandbox.files.readStream("/home/user/big.bin"); // ReadableStream<Uint8Array>

await sandbox.files.list("/home/user", { depth: 2 }); // [{ name, path, type, size, mode, mtime_ms }]
await sandbox.files.stat("/home/user/data.csv");
await sandbox.files.exists("/home/user/data.csv");
await sandbox.files.mkdir("/home/user/out");
await sandbox.files.move("/home/user/a.txt", "/home/user/b.txt", { overwrite: true });
await sandbox.files.remove("/home/user/out", { recursive: true });

for await (const ev of sandbox.files.watch("/home/user", { recursive: true })) {
  console.log(ev.type, ev.path); // create, write, remove, rename, chmod
}
```

## Background processes

```ts
const { pid } = await sandbox.processes.start("python3 -m http.server 8080", { tag: "web" });
for await (const ev of sandbox.processes.stream(pid)) { /* replays recent output, then live */ }
await sandbox.processes.sendStdin(pid, "quit\n", { eof: true });
await sandbox.processes.signal(pid, "SIGTERM");
await sandbox.processes.kill(pid);
await sandbox.processes.list();
```

## Background jobs

A job runs a command in a fresh sandbox without an open connection. Its log, result files and
execution receipt are kept after the sandbox is gone.

```ts
const job = await wbx.jobs.create({
  command: "python3 analyze.py",
  template: "base",
  timeoutSeconds: 3600,
  saveArtifacts: true,          // keep everything under output/
  maxCost: "0.10",              // price limit in your billing currency
  retry: { maxAttempts: 2 },    // after platform errors
  inputs: [{ jobId: earlier.id, name: "output/data.csv" }], // files of earlier jobs → input/
});

await job.wait({ timeoutMs: 30 * 60_000 });   // server-side waiting, no polling
const s = await job.summary();                // status, exit code, duration, cost, log tail
for await (const text of job.follow()) process.stdout.write(text); // log while it runs
const chunk = await job.logs({ offset: 0, limit: 65536 });          // { data, next_offset, complete }
const digest = await job.digest({ mode: "errors" });                // compact log for a model
const file = await job.download("output/result.json");               // SHA-256 verified (see below)
const receipt = await job.receipt();
const signed = await job.signedReceipt();                            // Ed25519, after the job ended
await job.cancel();
const again = await job.retry({ env: { API_KEY: "…" } });            // env values are never stored

const later = await wbx.jobs.get(job.id);
await wbx.jobs.wait({ jobIds: [a.id, b.id], until: "any", timeoutSeconds: 30 });
```

`download()` checks the file against the `X-WBX-SHA256` header the server sends with every
artifact and throws `IntegrityError` on a mismatch – and also when the header is missing or
malformed (e.g. stripped by a proxy), since such a file cannot be verified. `{ verify: false }`
skips the check; `downloadStream()` does not verify.

WebAssembly jobs (`runtime: "wasi"`, no network, fast start):
`wbx.jobs.create({ wasm: { module: bytes, args: ["--fast"] } })`.

## Batches

Many jobs with a concurrency limit and a total price limit. Jobs may depend on each other and
receive each other's result files. A failed job does not stop independent ones.

```ts
const batch = await wbx.batches.create({
  defaults: { template: "base", saveArtifacts: true },
  maxConcurrency: 10,
  maxTotalCost: "2.00",
  jobs: [
    { command: "python3 prepare.py" },                                  // index 0
    { command: "python3 train.py --part 1", dependsOn: [0], inputs: [{ fromIndex: 0, name: "output/data.csv" }] },
    { command: "python3 train.py --part 2", dependsOn: [0], inputs: [{ fromIndex: 0, name: "output/data.csv" }] },
  ],
});
await batch.wait();
const report = await batch.report();  // summary + one row per job
report.summary.status;                // completed | partial | failed | cancelled
report.summary.usage;                 // CPU time, peak memory, run time, attempts (null = not measured)
report.jobs[0].cpu_ms;                // per job: cpu_ms, peak_memory_mb (nullable)
await batch.reportCsv();
await batch.cancel();
```

## Metrics

> Needs the `metrics_history` feature on your account (`await wbx.features()`); otherwise
> `history()` and `stream()` throw `FeatureDisabledError`. `get()` always works.

```ts
await sandbox.metrics.get(); // { cpu_count, cpu_used_pct, mem_total_mb, mem_used_mb, disk_total_mb, disk_used_mb }

const h = await sandbox.metrics.history({ since: Date.now() - 10 * 60_000 }); // samples every 10 s, last hour

const ac = new AbortController();
for await (const s of sandbox.metrics.stream({
  signal: ac.signal,
  reconnect: true,
  onState: (st) => console.log("sandbox is", st.state), // first on connect, then on changes
})) {
  console.log(s.t, s.cpu_pct, s.mem_mb, s.net_rx_bps, s.disk_write_bps);
}
```

- `cpu_pct` is 0–100 % of all vCPUs of the sandbox together; rates ending in `_bps` are
  **bytes** per second; `cpu_ms`, `*_bytes` and `*_packets` are cumulative since the sandbox
  started or last woke up.
- `history()` never wakes a sleeping sandbox – it then returns `state: "sleeping"` and no samples.
- The server ends a stream after 15 minutes (`end` reason `timeout`), or when the sandbox stops
  (`not_running`, `ended`). With `reconnect: true` the iterator resumes only after `timeout` or a
  dropped connection, asks for the missed samples (`since`) and skips samples it already
  yielded. Pass `since` to start with older samples; `onEnd` receives the reason.
- Reconnects wait with backoff and jitter. A connection that ends or breaks within 30 s of
  opening counts as a failure: after `maxReconnects` (default 5) such failures in a row the
  iterator throws. At most `maxConnectsPerMinute` (default 6) connections are opened in any
  60 seconds; further reconnects wait.
- Limits: `history()` 30 calls a minute per sandbox; opening a stream 10 a minute per sandbox
  and 10 open streams per account – beyond that `RateLimitError` with code `rate_limited` and
  `Retry-After` (history calls are retried automatically within `maxRetryDelayMs`).

## Desktop control

> For sandboxes from the `desktop` template; needs the `desktop` feature on your account.

```ts
const sandbox = await wbx.sandboxes.create({ template: "desktop" });
const st = await sandbox.computer.status(); // { available, width, height, controller, controller_until, viewers, … }
const shot = await sandbox.computer.screenshot({ format: "png", maxWidth: 1280 });
// { data: Uint8Array, width, height (the image), screenWidth, screenHeight (the screen = action coordinates) }

await sandbox.computer.click(640, 400);
await sandbox.computer.type("hello");
await sandbox.computer.key("ctrl+c");
await sandbox.computer.scroll(640, 400, 0, 5);
const r = await sandbox.computer.actions(
  [
    { type: "move", x: 10, y: 10 },
    { type: "click", x: 10, y: 10, button: "right" },
    { type: "mouse_down", x: 20, y: 20 }, // x and y together, or neither (press where the mouse is)
    { type: "mouse_up", x: 200, y: 20 },
    { type: "wait", ms: 200 },
  ],
  { screenshot: true, screenshotFormat: "jpeg", screenshotQuality: 70, screenshotMaxWidth: 1024 },
); // r.screenshot.data – the screen after the actions; r.screenshotError if it could not be taken

await sandbox.computer.control("agent"); // take control back after a person released it
```

- The server performs the actions in order and stops at the first one that fails (the ones
  before it were done). It answers HTTP 200 with `ok: false`; the SDK then throws
  `ComputerActionError` with `failedIndex` and `results` (one `{ type, ok, error? }` per
  performed action). Pass `throwOnFailure: false` to get `{ ok: false, error, failedIndex,
  results }` instead.
- The screenshot of `actions()` is taken only when every action succeeded; its options need
  `screenshot: true`.
- While a person controls the desktop, actions fail with `HumanInControlError` (HTTP 409);
  `controllerUntil` (and `controller_until` of the status) is Unix time in milliseconds.
  `control("human")` is reserved for a person in the portal (403 `human_only` with an API key).
- Desktop actions are never retried automatically.

## Account

```ts
await wbx.templates.list();
await wbx.features();                  // { metrics_history: boolean, desktop: boolean }
await wbx.budget.get({ days: true });  // limits, spend this month / today, per day
await wbx.budget.update({ monthly: "50", alertPct: 80 });
await wbx.compute.preferences();       // compute classes available to you, your default
await wbx.compute.setDefaultClass("balanced");
await wbx.runtimes();
await wbx.receiptKeys();               // public keys that sign receipts (no API key needed)
const secret = await wbx.webhooks.secret();

import { verifyWebhook } from "wbxsandbox";
await verifyWebhook(secret, rawBody, request.headers.get("x-wbx-signature"));
```

Endpoints the SDK does not wrap yet: `await wbx.request("GET", "/v1/…", { query, body })` –
with the same authentication, timeouts, retries and errors.

## Errors

Every error extends `WBXError`. HTTP errors extend `APIError` with `status`, `code` (the
machine-readable `code` of the `{"error": …, "code": …}` body, when sent), `body`, `headers` and
`retryAfter` (seconds, from `Retry-After`).

| Class | When |
| --- | --- |
| `BadRequestError` | 400 – invalid request |
| `AuthenticationError` | 401 – missing or invalid API key |
| `PaymentRequiredError` | 402 – account may not start new work (`account_suspended`) |
| `PermissionDeniedError` | 403 – the key may not do this |
| `FeatureDisabledError` | 403 `feature_disabled` – `.feature` names it |
| `NotFoundError` | 404 – sandbox, job, batch, file or process not found |
| `ConflictError` | 409 – wrong state (e.g. sandbox not running, file exists) |
| `HumanInControlError` | 409 `human_in_control` – a person controls the desktop |
| `RateLimitError` | 429 – `quota`, `queue_full`, `too_many_waiters`, `rate_limited` |
| `InternalServerError` | 5xx – including 503 when no capacity is free right now |
| `TimeoutError` | a request or a wait ran out of time |
| `ConnectionError` | the API could not be reached |
| `CommandFailedError` | `result.check()` on a failed command |
| `ComputerActionError` | a desktop action failed – `.failedIndex`, `.results` |
| `StreamLimitError` | a streamed event or NDJSON line exceeded `maxStreamEventSize` |
| `IntegrityError` | a downloaded artifact did not match its SHA-256, or had no checksum |

```ts
import { FeatureDisabledError, RateLimitError } from "wbxsandbox";

try {
  await wbx.sandboxes.create({ template: "base" });
} catch (e) {
  if (e instanceof RateLimitError && e.code === "quota") console.log("stop another sandbox first");
  else throw e;
}
```

## Timeouts and cancellation

Every method takes an options object with `signal` (an `AbortSignal`) and `timeoutMs` (one HTTP
attempt; `0` = no limit). Aborting rejects with the signal's reason (an `AbortError` by default)
and stops retries and waits at once. Defaults: 60 s per request; sandbox creation 150 s; files
5 min; artifacts 10 min. A command's HTTP limit follows its own `timeoutMs` (+ 30 s).
For streams the limit applies until the response starts; afterwards use the signal.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);
await sandbox.commands.run("sleep 60", { signal: ac.signal });
```

`job.wait()` / `batch.wait()` take `timeoutMs` for the whole wait and throw `TimeoutError`.

## Retries

The SDK retries only requests that cannot take effect twice:

- `GET`, `HEAD`, `DELETE`, and `PUT` with a body that can be sent again;
- `POST` that carries an idempotency key – `jobs.create`, `batches.create` and `job.retry` (the
  SDK generates a key when you give none; the server returns the same job/batch for the same
  key) – and requests that are idempotent by design: `sandboxes.create` **with `name`**,
  `jobs.wait`, `job.cancel`, `batch.cancel`.

They are retried after connection errors, timeouts, 502, 503 and 504, and after 429 only when
the server sent `Retry-After` (a 429 without it is a hard limit such as your account quota).
The delay is exponential with jitter (0.25–0.5 s, doubling up to 8 s) or exactly `Retry-After`
– if that is longer than `maxRetryDelayMs`, the error is thrown at once. Default: 2 retries;
change with `maxRetries` on the client or per call.

Never retried: commands, unnamed sandbox creation, sleep / pause / resume / timeout, file moves
and removals, process start and input, desktop actions, uploads from a `ReadableStream`.

## Pagination

`wbx.jobs.list()`, `wbx.batches.list()` and `batch.listJobs()` return a `Page`:

```ts
const page = await wbx.jobs.list({ status: ["failed", "expired"], since: new Date("2026-11-01") });
page.items;            // this page
page.nextCursor;       // undefined on the last page
await page.getNextPage();
for await (const job of page) { /* every job of every page, fetched lazily */ }
```

`wbx.sandboxes.list()` and `wbx.templates.list()` return everything at once (the API does not page them).

## Runtimes

The SDK uses only Web standard APIs – `fetch`, `Request`/`Response`, `ReadableStream`,
`TextEncoder`/`TextDecoder`, `AbortController` and Web Crypto – with no `node:` imports and no
`Buffer`. It runs on Node.js ≥ 20, Deno, Bun and edge runtimes (Cloudflare Workers, Vercel
Edge). It is ESM only: all supported Node.js versions can `import` it, and Node.js ≥ 20.19 /
22.12 can also `require()` it.

Do not ship an API key to a browser: requests from a web page should go through your own
backend.

## Versioning and compatibility

The SDK follows [semantic versioning](https://semver.org). While it is 0.x, a **minor**
release (0.1 → 0.2) may contain breaking changes, which are listed in the
[changelog](CHANGELOG.md); patch releases (0.1.0 → 0.1.1) are always compatible. Pin
`~0.1.0` if you want only fixes. The REST API itself is versioned by its `/v1/` prefix and
changes there are additive, so an older SDK keeps working against a newer server; new record
fields appear in the `info` / `data` objects before the SDK types them. Node.js versions are
supported while they are maintained upstream.

## Links

- Documentation: https://sandbox.wbx.cz/docs (TypeScript SDK: https://sandbox.wbx.cz/docs/sdk/typescript)
- REST API reference: https://sandbox.wbx.cz/docs/api
- Python SDK: https://pypi.org/project/wbxsandbox/
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- License: [MIT](LICENSE)

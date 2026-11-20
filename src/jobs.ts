/**
 * Background jobs and batches.
 * @module
 */

import { IntegrityError, NotFoundError, TimeoutError, WBXError } from "./errors.js";
import type { RequestOptions, Transport } from "./http.js";
import { Page } from "./pagination.js";
import type {
  ArtifactList,
  BatchReport,
  BatchSummary,
  ExecutionReceipt,
  JobInfo,
  JobStatus,
  JobSummary,
  LogChunk,
  LogDigest,
  NetworkOptions,
  SignedReceipt,
  WaitResult,
} from "./types.js";
import { TERMINAL_JOB_STATUSES } from "./types.js";
import { bytesToBase64, compact, encodePath, randomId, sha256Hex, sleep, throwIfAborted, toRFC3339 } from "./util.js";

const ARTIFACT_TIMEOUT_MS = 600_000;
const WAIT_SLICE_S = 60; // the server waits at most 60 s per call

/**
 * A result file of an earlier finished job (`{ jobId, name }`) or – inside a batch – of
 * another job of the same batch (`{ fromIndex, name }`; the job then waits for it). The file
 * appears in the job's `input/` directory as `as` (default: its base name).
 */
export type JobInput = { jobId: string; name: string; as?: string } | { fromIndex: number; name: string; as?: string };

/** A WebAssembly module for a `wasi` job. */
export interface WasmOptions {
  /** The module bytes (at most 8 MB inline). */
  module?: Uint8Array;
  /** Or: the `as` name of an input file that holds the module. */
  moduleInput?: string;
  args?: string[];
  stdin?: string;
  memoryMb?: number;
}

/** Options of {@link Jobs.create} (and of every job of a batch). */
export interface JobCreateParams {
  /** Shell command to run (not needed for a WebAssembly job). */
  command?: string;
  /** Template (default `base`; not used by WebAssembly jobs). */
  template?: string;
  /** Time limit in seconds (server default when omitted; up to 24 h). */
  timeoutSeconds?: number;
  cwd?: string;
  /** Environment variables. Values are never stored with the job record or returned. */
  env?: Record<string, string>;
  /** Glob patterns (relative to `cwd`) of result files to keep. */
  artifacts?: string[];
  /** Keep everything under `output/` (when no patterns are given). */
  saveArtifacts?: boolean;
  /** Patterns without which the job cannot end as `completed`. */
  requiredArtifacts?: string[];
  network?: NetworkOptions;
  metadata?: Record<string, string>;
  /** Automatic attempts: `on: "system"` (default) retries only after platform errors. */
  retry?: { maxAttempts: number; on?: "system" | "any" | "never" };
  /** Price limit in your account's billing currency, e.g. `"0.10"`. */
  maxCost?: string | number;
  /** Receives a signed `job.finished` webhook. */
  webhookUrl?: string;
  /**
   * Makes the submission safe to repeat: the same key returns the same job. The SDK creates
   * a random key when you give none, so automatic retries never start a job twice.
   */
  idempotencyKey?: string;
  placement?: "auto" | "fast" | "spread";
  computeClass?: string;
  dependencyCache?: boolean;
  optimizeFor?: "price" | "balanced" | "performance";
  /** `firecracker` (default, a microVM) or `wasi` (WebAssembly, no network). */
  runtime?: "firecracker" | "wasi";
  /** Result files of other jobs, given to this job in `input/`. */
  inputs?: JobInput[];
  /** WebAssembly module and its parameters (implies `runtime: "wasi"`). */
  wasm?: WasmOptions;
}

/** A job of a batch: the job options plus dependencies on other jobs of the batch. */
export interface BatchJobParams extends JobCreateParams {
  /** Indexes (from 0) of jobs of the same batch that must complete first. */
  dependsOn?: number[];
}

/** Options of {@link Batches.create}. */
export interface BatchCreateParams {
  /** The jobs (up to 1000). Missing fields are taken from `defaults`. */
  jobs: BatchJobParams[];
  /** Defaults for every job. */
  defaults?: JobCreateParams;
  /** How many jobs run at the same time (server default when omitted). */
  maxConcurrency?: number;
  /** Price limit of the whole batch in your billing currency. */
  maxTotalCost?: string | number;
  name?: string;
  /** Same key = same batch (the SDK creates one when omitted). */
  idempotencyKey?: string;
  /** Receives a signed `batch.finished` webhook. */
  webhookUrl?: string;
}

/** Options of the waiting methods. */
export interface WaitOptions {
  /** Give up after this many milliseconds with {@link TimeoutError} (default: wait as long as it takes). */
  timeoutMs?: number;
  /** Polling interval in ms, only used against servers without server-side waiting (default 5000). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/** @internal REST body of one job. */
export function jobBody(p: JobCreateParams & { dependsOn?: number[] }): Record<string, unknown> {
  const body: Record<string, unknown> = compact({
    command: p.command,
    template: p.template,
    timeout_s: p.timeoutSeconds,
    cwd: p.cwd,
    env: p.env,
    artifacts: p.artifacts,
    save_artifacts: p.saveArtifacts || undefined,
    required_artifacts: p.requiredArtifacts,
    network: p.network,
    metadata: p.metadata,
    max_cost: p.maxCost === undefined ? undefined : String(p.maxCost),
    webhook_url: p.webhookUrl,
    idempotency_key: p.idempotencyKey,
    placement: p.placement,
    compute_class: p.computeClass,
    dependency_cache: p.dependencyCache,
    optimize_for: p.optimizeFor,
    runtime: p.runtime,
    depends_on: p.dependsOn,
  });
  if (p.retry) body["retry"] = compact({ max_attempts: p.retry.maxAttempts, on: p.retry.on ?? "system" });
  if (p.inputs) {
    body["inputs"] = p.inputs.map((i) =>
      "jobId" in i ? compact({ job_id: i.jobId, name: i.name, as: i.as }) : compact({ from_index: i.fromIndex, name: i.name, as: i.as }),
    );
  }
  if (p.wasm) {
    body["runtime"] = p.runtime ?? "wasi";
    body["wasm"] = compact({
      module_b64: p.wasm.module ? bytesToBase64(p.wasm.module) : undefined,
      module: p.wasm.moduleInput,
      args: p.wasm.args,
      stdin: p.wasm.stdin,
      memory_mb: p.wasm.memoryMb,
    });
  }
  return body;
}

/**
 * A background job. It runs on WBX without an open connection; its log, result files and
 * execution receipt are kept after its sandbox is gone. `data` holds the API record.
 */
export class Job {
  /** Job ID (`job_…`). */
  readonly id: string;
  /** The API record as last seen. */
  data: JobInfo;
  /** True when the submission was answered from an earlier one with the same idempotency key. */
  readonly replayed: boolean;
  private readonly t: Transport;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(t: Transport, data: JobInfo, replayed = false) {
    this.t = t;
    this.id = data.id;
    this.data = data;
    this.replayed = replayed;
  }

  /** Status as last seen. */
  get status(): JobStatus {
    return this.data.status;
  }

  /** Whether the job ended (`completed`, `failed`, `cancelled` or `expired`). */
  get done(): boolean {
    return TERMINAL_JOB_STATUSES.includes(this.data.status);
  }

  private p(rest = "") {
    return `/v1/jobs/${encodeURIComponent(this.id)}${rest}`;
  }

  /** Reloads the job record. */
  async refresh(options?: RequestOptions): Promise<this> {
    this.data = (await this.t.json<JobInfo>({ method: "GET", path: this.p(), options })).data;
    return this;
  }

  /** Short status: state, exit code, duration, cost, file names, last log lines, test results. */
  async summary(options?: RequestOptions): Promise<JobSummary> {
    return (await this.t.json<JobSummary>({ method: "GET", path: this.p("/summary"), options })).data;
  }

  /**
   * Waits until the job ends, using server-side waiting (it reacts within a second without
   * polling). Returns the job with fresh `data`.
   */
  async wait(options: WaitOptions = {}): Promise<this> {
    await waitUntil(this.t, options, async () => (await this.refresh({ signal: options.signal })).done, { job_ids: [this.id] }, `job ${this.id}`, () => this.status);
    return this;
  }

  /** A chunk of the log. Negative `offset` counts from the end. Continue from `next_offset`. */
  async logs(options: RequestOptions & { offset?: number; limit?: number } = {}): Promise<LogChunk> {
    const { offset, limit, ...rest } = options;
    return (await this.t.json<LogChunk>({ method: "GET", path: this.p("/logs"), query: { offset, limit }, options: rest })).data;
  }

  /**
   * A compact log for a model's context: `summary` (test results, errors and the end of the
   * log), `errors` or `tail`.
   */
  async digest(options: RequestOptions & { mode?: "summary" | "errors" | "tail"; maxChars?: number } = {}): Promise<LogDigest> {
    const { mode = "summary", maxChars, ...rest } = options;
    return (await this.t.json<LogDigest>({ method: "GET", path: this.p("/logs"), query: { mode, max_chars: maxChars }, options: rest })).data;
  }

  /** The whole stored log as text. */
  async logText(options?: RequestOptions): Promise<string> {
    const out: string[] = [];
    let off = 0;
    for (;;) {
      const c = await this.logs({ ...options, offset: off, limit: 1 << 20 });
      out.push(c.data);
      if (c.next_offset <= off || c.next_offset >= c.size) return out.join("");
      off = c.next_offset;
    }
  }

  /**
   * Yields new log text as the job runs, until it ends.
   *
   * ```ts
   * for await (const text of job.follow()) process.stdout.write(text);
   * ```
   */
  async *follow(options: { offset?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<string> {
    let off = options.offset ?? 0;
    const poll = options.pollIntervalMs ?? 2000;
    for (;;) {
      const c = await this.logs({ offset: off, signal: options.signal });
      if (c.data) yield c.data;
      off = c.next_offset;
      if (c.complete) return;
      if (!c.data) await sleep(poll, options.signal);
    }
  }

  /** The execution receipt: inputs, template build, runtime, exit code, measured usage, file checksums, cost. */
  async receipt(options?: RequestOptions): Promise<ExecutionReceipt> {
    const { data } = await this.t.json<{ execution_receipt: ExecutionReceipt }>({ method: "GET", path: this.p("/receipt"), options });
    return data.execution_receipt;
  }

  /**
   * The receipt signed by WBX (Ed25519) – only after the job ended (otherwise
   * {@link ConflictError} `receipt_not_final`). The signature proves WBX issued the receipt
   * unchanged, not that the computation could not have been altered.
   */
  async signedReceipt(options?: RequestOptions): Promise<SignedReceipt> {
    const { data } = await this.t.json<{ signed_receipt: SignedReceipt }>({ method: "GET", path: this.p("/receipt"), query: { signed: 1 }, options });
    return data.signed_receipt;
  }

  /** The stored result files with sizes and SHA-256 sums, and files that were skipped. */
  async artifacts(options?: RequestOptions): Promise<ArtifactList> {
    return (await this.t.json<ArtifactList>({ method: "GET", path: this.p("/artifacts"), options })).data;
  }

  /**
   * Downloads a result file and verifies its SHA-256 sum against the `X-WBX-SHA256` header the
   * server sends with every artifact. `name` is the artifact name, e.g. `output/result.json`.
   *
   * With `verify: true` (the default) it throws {@link IntegrityError} when the sum does not
   * match, and also when the header is missing or malformed (for example removed by a proxy) –
   * an unverifiable file is never returned as verified. Pass `verify: false` to skip the check.
   */
  async download(name: string, options: RequestOptions & { verify?: boolean } = {}): Promise<Uint8Array> {
    const { verify = true, ...rest } = options;
    const { data, headers } = await this.t.bytes({
      method: "GET",
      path: this.p(`/artifacts/${encodePath(name)}`),
      headers: { Accept: "application/octet-stream" },
      defaultTimeoutMs: ARTIFACT_TIMEOUT_MS,
      options: rest,
    });
    if (verify) {
      const want = headers.get("x-wbx-sha256")?.trim().toLowerCase();
      if (!want) {
        throw new IntegrityError(`missing checksum for ${name}: the response has no X-WBX-SHA256 header (pass verify: false to skip the check)`);
      }
      if (!/^[0-9a-f]{64}$/.test(want)) throw new IntegrityError(`invalid checksum for ${name}: the X-WBX-SHA256 header is not a SHA-256 hex digest`);
      const got = await sha256Hex(data);
      if (got !== want) throw new IntegrityError(`checksum mismatch for ${name}: expected ${want}, got ${got}`);
    }
    return data;
  }

  /** Downloads a result file as a stream (large files; no checksum verification). */
  async downloadStream(name: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>> {
    const { body } = await this.t.stream({
      method: "GET",
      path: this.p(`/artifacts/${encodePath(name)}`),
      headers: { Accept: "application/octet-stream" },
      defaultTimeoutMs: 120_000,
      options,
    });
    return body;
  }

  /** Cancels the job (a finished job stays as it is). */
  async cancel(options?: RequestOptions): Promise<this> {
    this.data = (await this.t.json<JobInfo>({ method: "POST", path: this.p("/cancel"), json: {}, idempotent: true, options })).data;
    return this;
  }

  /**
   * Starts a new job with the same inputs. Environment variable values are not stored, so
   * pass `env` again when the original job had some.
   */
  async retry(options: RequestOptions & { env?: Record<string, string>; idempotencyKey?: string } = {}): Promise<Job> {
    const { env, idempotencyKey = randomId(), ...rest } = options;
    const { data, headers } = await this.t.json<JobInfo>({
      method: "POST",
      path: this.p("/retry"),
      json: { env: env ?? {}, idempotency_key: idempotencyKey },
      idempotent: true,
      options: rest,
    });
    return new Job(this.t, data, headers.get("idempotent-replay") === "true");
  }

  /** @internal */
  toJSON(): JobInfo {
    return this.data;
  }
}

/** Server-side wait loop shared by jobs and batches. */
async function waitUntil(
  t: Transport,
  o: WaitOptions,
  isDone: () => Promise<boolean>,
  ids: { job_ids?: string[]; batch_ids?: string[] },
  what: string,
  state: () => string,
): Promise<void> {
  const end = o.timeoutMs !== undefined ? Date.now() + o.timeoutMs : undefined;
  let serverWait = true;
  for (;;) {
    throwIfAborted(o.signal);
    if (await isDone()) return;
    const left = end !== undefined ? end - Date.now() : WAIT_SLICE_S * 1000;
    if (left <= 0) throw new TimeoutError(`${what} has not finished (${state()})`);
    if (serverWait) {
      try {
        await t.json({
          method: "POST",
          path: "/v1/jobs/wait",
          json: { job_ids: ids.job_ids ?? [], batch_ids: ids.batch_ids ?? [], until: "all", timeout_s: Math.max(1, Math.min(WAIT_SLICE_S, Math.ceil(left / 1000))) },
          idempotent: true,
          options: { signal: o.signal, timeoutMs: (WAIT_SLICE_S + 15) * 1000 },
        });
        continue;
      } catch (e) {
        // an older server without /v1/jobs/wait (plain 404 without a code) – fall back to polling
        if (!(e instanceof NotFoundError) || e.code !== undefined) throw e;
        serverWait = false;
      }
    }
    await sleep(Math.min(o.pollIntervalMs ?? 5000, Math.max(0, left)), o.signal);
  }
}

/** `wbx.jobs` */
export class Jobs {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /**
   * Submits a background job and returns at once (status `queued`).
   *
   * ```ts
   * const job = await wbx.jobs.create({ command: "python3 analyze.py", saveArtifacts: true, maxCost: "0.10" });
   * await job.wait();
   * console.log((await job.summary()).status);
   * ```
   */
  async create(params: JobCreateParams, options?: RequestOptions): Promise<Job> {
    if (params.command === undefined && !params.wasm) throw new WBXError("command is required (or wasm for a WebAssembly job)");
    const body = jobBody({ ...params, idempotencyKey: params.idempotencyKey ?? randomId() });
    const { data, headers } = await this.t.json<JobInfo>({ method: "POST", path: "/v1/jobs", json: body, idempotent: true, options });
    return new Job(this.t, data, headers.get("idempotent-replay") === "true");
  }

  /** A job by ID. */
  async get(id: string, options?: RequestOptions & { events?: boolean }): Promise<Job> {
    const { events, ...rest } = options ?? {};
    const { data } = await this.t.json<JobInfo>({
      method: "GET",
      path: `/v1/jobs/${encodeURIComponent(id)}`,
      query: { events: events ? 1 : undefined },
      options: rest,
    });
    return new Job(this.t, data);
  }

  /**
   * Your jobs, newest first (short summaries). Iterate the page with `for await` to go
   * through all pages.
   */
  async list(
    params: { status?: JobStatus | JobStatus[]; batchId?: string; since?: Date | number | string; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<JobSummary>> {
    const fetchPage = async (cursor: string | undefined): Promise<Page<JobSummary>> => {
      const { data } = await this.t.json<{ jobs: JobSummary[]; next_cursor?: string }>({
        method: "GET",
        path: "/v1/jobs",
        query: {
          status: Array.isArray(params.status) ? params.status.join(",") : params.status,
          batch_id: params.batchId,
          since: params.since === undefined ? undefined : toRFC3339(params.since),
          limit: params.limit,
          cursor,
        },
        options,
      });
      return new Page(data.jobs ?? [], data.next_cursor, fetchPage);
    };
    return fetchPage(params.cursor);
  }

  /**
   * Blocks until any (or all) of the jobs and batches ended, or `timeoutSeconds` (1–60,
   * default 30) passed. One request; call it again to keep waiting.
   */
  async wait(
    params: { jobIds?: string[]; batchIds?: string[]; until?: "any" | "all"; timeoutSeconds?: number },
    options?: RequestOptions,
  ): Promise<WaitResult> {
    const timeout = params.timeoutSeconds ?? 30;
    const { data } = await this.t.json<WaitResult>({
      method: "POST",
      path: "/v1/jobs/wait",
      json: { job_ids: params.jobIds ?? [], batch_ids: params.batchIds ?? [], until: params.until ?? "any", timeout_s: timeout },
      idempotent: true,
      defaultTimeoutMs: (Math.min(timeout, WAIT_SLICE_S) + 15) * 1000,
      options,
    });
    return data;
  }
}

/** A batch of jobs with a concurrency limit and an optional total price limit. */
export class Batch {
  /** Batch ID (`bat_…`). */
  readonly id: string;
  /** IDs of the jobs, in the order they were given. */
  readonly jobIds: string[];
  /** The summary as last seen. */
  data: BatchSummary;
  /** True when the submission was answered from an earlier one with the same idempotency key. */
  readonly replayed: boolean;
  private readonly t: Transport;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(t: Transport, data: BatchSummary, jobIds: string[], replayed = false) {
    this.t = t;
    this.id = data.id;
    this.data = data;
    this.jobIds = jobIds;
    this.replayed = replayed;
  }

  /** Overall status as last seen: `running`, `completed`, `partial`, `failed` or `cancelled`. */
  get status(): BatchSummary["status"] {
    return this.data.status;
  }

  /** Whether every job of the batch ended. */
  get done(): boolean {
    return this.data.done;
  }

  private p(rest = "") {
    return `/v1/batches/${encodeURIComponent(this.id)}${rest}`;
  }

  /** Counts by state, cost, durations and the first errors. */
  async summary(options?: RequestOptions): Promise<BatchSummary> {
    this.data = (await this.t.json<BatchSummary>({ method: "GET", path: this.p(), options })).data;
    return this.data;
  }

  /** The summary plus one row per job (state, exit code, cost, error). */
  async report(options?: RequestOptions): Promise<BatchReport> {
    const r = (await this.t.json<BatchReport>({ method: "GET", path: this.p("/report"), options })).data;
    this.data = r.summary;
    return r;
  }

  /** The report as CSV text. */
  async reportCsv(options?: RequestOptions): Promise<string> {
    const { data } = await this.t.bytes({ method: "GET", path: this.p("/report"), query: { format: "csv" }, headers: { Accept: "text/csv" }, options });
    return new TextDecoder().decode(data);
  }

  /** Summaries of the batch's jobs (paged; iterate with `for await`). */
  listJobs(params: { status?: JobStatus | JobStatus[]; limit?: number } = {}, options?: RequestOptions): Promise<Page<JobSummary>> {
    return new Jobs(this.t).list({ ...params, batchId: this.id }, options);
  }

  /** Waits until every job of the batch ended (server-side waiting). */
  async wait(options: WaitOptions = {}): Promise<this> {
    await waitUntil(this.t, options, async () => (await this.summary({ signal: options.signal })).done, { batch_ids: [this.id] }, `batch ${this.id}`, () => this.status);
    return this;
  }

  /** Cancels jobs that have not ended; results of finished jobs are kept. */
  async cancel(options?: RequestOptions): Promise<BatchSummary> {
    this.data = (await this.t.json<BatchSummary>({ method: "POST", path: this.p("/cancel"), json: {}, idempotent: true, options })).data;
    return this.data;
  }

  /** @internal */
  toJSON(): BatchSummary & { job_ids: string[] } {
    return { ...this.data, job_ids: this.jobIds };
  }
}

/** `wbx.batches` */
export class Batches {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /**
   * Submits many jobs at once. Jobs may depend on each other (`dependsOn`, inputs with
   * `fromIndex`); a failed job does not stop independent ones.
   *
   * ```ts
   * const batch = await wbx.batches.create({
   *   jobs: [
   *     { command: "python3 prepare.py", saveArtifacts: true },
   *     { command: "python3 train.py", dependsOn: [0], inputs: [{ fromIndex: 0, name: "output/data.csv" }] },
   *   ],
   *   maxConcurrency: 5,
   *   maxTotalCost: "1.00",
   * });
   * await batch.wait();
   * ```
   */
  async create(params: BatchCreateParams, options?: RequestOptions): Promise<Batch> {
    const body = compact({
      name: params.name,
      jobs: params.jobs.map((j) => jobBody(j)),
      defaults: params.defaults ? jobBody(params.defaults) : undefined,
      max_concurrency: params.maxConcurrency,
      max_total_cost: params.maxTotalCost === undefined ? undefined : String(params.maxTotalCost),
      idempotency_key: params.idempotencyKey ?? randomId(),
      webhook_url: params.webhookUrl,
    });
    const { data, headers } = await this.t.json<{ batch: BatchSummary; job_ids: string[] }>({
      method: "POST",
      path: "/v1/batches",
      json: body,
      idempotent: true,
      defaultTimeoutMs: 120_000,
      options,
    });
    return new Batch(this.t, data.batch, data.job_ids ?? [], headers.get("idempotent-replay") === "true");
  }

  /** A batch by ID (with the IDs of its jobs in order). */
  async get(id: string, options?: RequestOptions): Promise<Batch> {
    const { data } = await this.t.json<BatchReport>({ method: "GET", path: `/v1/batches/${encodeURIComponent(id)}/report`, options });
    const ids = [...(data.jobs ?? [])].sort((a, b) => a.index - b.index).map((r) => r.job_id);
    return new Batch(this.t, data.summary, ids);
  }

  /** Your batches, newest first (summaries; iterate with `for await` for all pages). */
  async list(params: { since?: Date | number | string; limit?: number; cursor?: string } = {}, options?: RequestOptions): Promise<Page<BatchSummary>> {
    const fetchPage = async (cursor: string | undefined): Promise<Page<BatchSummary>> => {
      const { data } = await this.t.json<{ batches: BatchSummary[]; next_cursor?: string }>({
        method: "GET",
        path: "/v1/batches",
        query: { since: params.since === undefined ? undefined : toRFC3339(params.since), limit: params.limit, cursor },
        options,
      });
      return new Page(data.batches ?? [], data.next_cursor, fetchPage);
    };
    return fetchPage(params.cursor);
  }
}

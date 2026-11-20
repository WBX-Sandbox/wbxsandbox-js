/**
 * Sandboxes: lifecycle, commands, files, processes, metrics and the desktop.
 * @module
 */

import {
  CommandFailedError,
  ComputerActionError,
  ConnectionError,
  NotFoundError,
  StreamLimitError,
  WBXError,
  isAbortLike,
} from "./errors.js";
import type { RequestOptions, Transport } from "./http.js";
import { backoffMs } from "./http.js";
import { SSEParser, readNDJSON, readSSE } from "./streams.js";
import type {
  ComputerAction,
  ComputerActionResultEntry,
  ComputerActionsResult,
  ComputerStatus,
  EntryInfo,
  ExecEvent,
  IPMode,
  KeepResult,
  MetricsHistory,
  MetricsSample,
  MetricsStreamEndReason,
  MetricsStreamState,
  MouseButton,
  NetworkOptions,
  PortURL,
  ProcessEvent,
  ProcessInfo,
  SandboxInfo,
  SandboxMetrics,
  SandboxState,
  Screenshot,
  Signal,
  WatchEvent,
  WriteResult,
} from "./types.js";
import { base64ToBytes, bytesToBase64, compact, randomId, sleep, toUnixMs, utf8 } from "./util.js";

const CREATE_TIMEOUT_MS = 150_000; // the gateway may take up to ~100 s to place and start a sandbox
const FILE_TIMEOUT_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/**
 * HTTP limit of desktop actions: one request may type up to 8192 characters (~65 s), wait up
 * to 30 s in total and queue behind up to two other action requests of the same sandbox.
 * Same as the Python SDK (300 s).
 */
const COMPUTER_ACTIONS_TIMEOUT_MS = 300_000;
const EXEC_GRACE_MS = 30_000;

/** Options of {@link Sandboxes.create}. */
export interface SandboxCreateParams {
  /** What is preinstalled: `base` (default, Debian with Python), `node`, `browser`, `desktop`, … See `wbx.templates.list()`. */
  template?: string;
  /** Lifetime in seconds (server default when omitted). Extend it any time with `sandbox.setTimeout()`. */
  timeoutSeconds?: number;
  /**
   * Name for a reusable sandbox (`my-project`): when you already have a sandbox with this
   * name, it is returned instead of a new one (woken up if it is asleep).
   */
  name?: string;
  /** What happens when the lifetime ends: `kill` (default) or `pause` (fall asleep, files kept). */
  onTimeout?: "kill" | "pause";
  /** With `onTimeout: "pause"`: fall asleep after this many seconds without requests. */
  idleTimeoutSeconds?: number;
  /** With `onTimeout: "pause"`: days to keep the sandbox after it falls asleep (0 = plan default). */
  keepDays?: number;
  /** Your own labels, returned when you list sandboxes. Keys starting with `wbx_` are reserved. */
  metadata?: Record<string, string>;
  /** Environment variables for every command in the sandbox. */
  env?: Record<string, string>;
  /** vCPUs – only for templates without a fixed size. */
  vcpu?: number;
  /** Memory in MB – only for templates without a fixed size. */
  memMb?: number;
  /** Compute class (`economy`, `balanced`, …; see `wbx.compute.preferences()`). Never downgraded. */
  computeClass?: string;
  /** Picks the server inside the class; never changes the class. */
  optimizeFor?: "price" | "balanced" | "performance";
  /** Server selection: `auto` (default), `fast` or `spread`. */
  placement?: "auto" | "fast" | "spread";
  /** `false` = do not use the server's verified package cache. */
  dependencyCache?: boolean;
  /** Network policy (only stricter than your team's policy) and IP version. */
  network?: NetworkOptions;
}

/** Options of {@link Commands.run} and {@link Commands.stream}. */
export interface RunOptions {
  /** Extra environment variables for this command. */
  env?: Record<string, string>;
  /** Working directory (default: the sandbox default, usually `/home/user`). */
  cwd?: string;
  /**
   * Time limit of the command in milliseconds; the command is killed when it runs longer and
   * the result has `timedOut: true`. Default 60 000 for `run()`, none for `stream()`; `0` = no limit.
   */
  timeoutMs?: number;
  /** Data written to the command's standard input. */
  stdin?: string;
  /** Limit of captured output per stream in bytes (server maximum 16 MB) – `run()` only. */
  maxOutputBytes?: number;
  /** Called with each piece of standard output while the command runs (`run()` then streams). */
  onStdout?: (data: string) => void;
  /** Called with each piece of standard error while the command runs (`run()` then streams). */
  onStderr?: (data: string) => void;
  /** Cancels the call; for a streamed command, disconnecting also kills the command. */
  signal?: AbortSignal;
  /** HTTP time limit (default: command timeout + 30 s, no limit when the command has none). */
  requestTimeoutMs?: number;
}

/** Result of a finished command. */
export class CommandResult {
  /** Exit code (-1 when unknown). */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** The command was killed because it ran longer than its timeout. */
  readonly timedOut: boolean;
  /** Output longer than the server limit (16 MB per stream) was cut off. */
  readonly truncated: boolean;

  constructor(r: { exitCode: number; stdout: string; stderr: string; durationMs?: number; timedOut?: boolean; truncated?: boolean }) {
    this.exitCode = r.exitCode;
    this.stdout = r.stdout;
    this.stderr = r.stderr;
    this.durationMs = r.durationMs ?? 0;
    this.timedOut = r.timedOut ?? false;
    this.truncated = r.truncated ?? false;
  }

  /** Exit code 0 and no timeout. */
  get ok(): boolean {
    return this.exitCode === 0 && !this.timedOut;
  }

  /** Throws {@link CommandFailedError} unless the command succeeded; returns the result otherwise. */
  check(): this {
    if (!this.ok) throw new CommandFailedError(this);
    return this;
  }
}

interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms?: number;
  timed_out?: boolean;
  truncated?: boolean;
}

function execBody(cmd: string, o: RunOptions, timeoutMs: number) {
  return compact({
    cmd,
    env: o.env,
    cwd: o.cwd,
    timeout_ms: Math.max(0, Math.floor(timeoutMs)),
    stdin: o.stdin,
    max_output: o.maxOutputBytes,
  });
}

function httpTimeout(o: RunOptions, commandMs: number): number {
  if (o.requestTimeoutMs !== undefined) return o.requestTimeoutMs;
  return commandMs > 0 ? commandMs + EXEC_GRACE_MS : 0;
}

/** Shell commands (`sandbox.commands`). */
export class Commands {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(
    private readonly t: Transport,
    private readonly id: string,
  ) {}

  /**
   * Runs a shell command (`/bin/sh -c`) and waits for it to finish.
   *
   * ```ts
   * const r = await sandbox.commands.run("python3 --version");
   * console.log(r.exitCode, r.stdout);
   * await sandbox.commands.run("make test").then((r) => r.check());
   * ```
   *
   * A command that exits with a non-zero code is a normal result, not an exception – use
   * `result.check()` to turn it into a {@link CommandFailedError}. With `onStdout` / `onStderr`
   * the output is streamed while the command runs.
   */
  async run(cmd: string, options: RunOptions = {}): Promise<CommandResult> {
    const commandMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (options.onStdout || options.onStderr) {
      const out: string[] = [];
      const err: string[] = [];
      let exit: Extract<ExecEvent, { type: "exit" }> | undefined;
      for await (const ev of this.stream(cmd, { ...options, timeoutMs: commandMs })) {
        if (ev.type === "stdout") {
          out.push(ev.data);
          options.onStdout?.(ev.data);
        } else if (ev.type === "stderr") {
          err.push(ev.data);
          options.onStderr?.(ev.data);
        } else if (ev.type === "exit") {
          exit = ev;
        }
      }
      if (!exit) throw new WBXError("the command stream ended without an exit event (connection lost?)");
      return new CommandResult({
        exitCode: exit.exit_code,
        stdout: out.join(""),
        stderr: err.join(""),
        durationMs: exit.duration_ms,
        timedOut: exit.timed_out,
      });
    }
    const { data } = await this.t.json<ExecResponse>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}/exec`,
      json: execBody(cmd, options, commandMs),
      idempotent: false,
      options: { signal: options.signal, timeoutMs: httpTimeout(options, commandMs) },
    });
    return new CommandResult({
      exitCode: data.exit_code,
      stdout: data.stdout,
      stderr: data.stderr,
      durationMs: data.duration_ms,
      timedOut: data.timed_out,
      truncated: data.truncated,
    });
  }

  /**
   * Runs a command and yields its events as they happen: `start` (with `pid`), `stdout`,
   * `stderr` and finally `exit`. Breaking out of the loop or aborting the signal disconnects,
   * which kills the command.
   *
   * ```ts
   * for await (const ev of sandbox.commands.stream("pip install pandas")) {
   *   if (ev.type === "stdout") process.stdout.write(ev.data);
   *   if (ev.type === "exit") console.log("exit code", ev.exit_code);
   * }
   * ```
   */
  async *stream(cmd: string, options: RunOptions = {}): AsyncGenerator<ExecEvent> {
    const commandMs = options.timeoutMs ?? 0;
    const { body, release } = await this.t.stream({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}/exec/stream`,
      json: execBody(cmd, options, commandMs),
      idempotent: false,
      headers: { Accept: "application/x-ndjson" },
      options: { signal: options.signal, timeoutMs: options.requestTimeoutMs ?? 120_000 },
    });
    try {
      yield* readNDJSON<ExecEvent>(body, { maxLineSize: this.t.config.maxStreamEventSize });
    } finally {
      release();
    }
  }
}

/** Data accepted by {@link Files.write}. */
export type FileData = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

/** Files in the sandbox (`sandbox.files`). Paths are absolute paths inside the sandbox. */
export class Files {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(
    private readonly t: Transport,
    private readonly id: string,
  ) {}

  private p(rest: string) {
    return `/v1/sandboxes/${enc(this.id)}${rest}`;
  }

  /** Downloads a file as bytes. */
  async read(path: string, options?: RequestOptions): Promise<Uint8Array> {
    const { data } = await this.t.bytes({
      method: "GET",
      path: this.p("/files"),
      query: { path },
      headers: { Accept: "application/octet-stream" },
      defaultTimeoutMs: FILE_TIMEOUT_MS,
      options,
    });
    return data;
  }

  /** Downloads a text file (UTF-8). */
  async readText(path: string, options?: RequestOptions): Promise<string> {
    return new TextDecoder().decode(await this.read(path, options));
  }

  /** Downloads a file as a stream – for large files. `options.timeoutMs` limits only the start. */
  async readStream(path: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>> {
    const { body } = await this.t.stream({
      method: "GET",
      path: this.p("/files"),
      query: { path },
      headers: { Accept: "application/octet-stream" },
      defaultTimeoutMs: 120_000,
      options,
    });
    return body;
  }

  /**
   * Uploads a file; missing directories are created and an existing file is replaced.
   * Text is written as UTF-8. A `ReadableStream` is streamed without buffering (it cannot be
   * retried).
   */
  async write(path: string, data: FileData, options?: RequestOptions): Promise<WriteResult> {
    const body = typeof data === "string" ? utf8(data) : data;
    const { data: res } = await this.t.json<WriteResult>({
      method: "PUT",
      path: this.p("/files"),
      query: { path },
      body: body as BodyInit,
      contentType: "application/octet-stream",
      defaultTimeoutMs: FILE_TIMEOUT_MS,
      options,
    });
    return res;
  }

  /**
   * Lists a directory: name, path, type, size, permissions and modification time of each
   * entry. `depth` (1–5) also lists subdirectories.
   */
  async list(path = "/home/user", options: RequestOptions & { depth?: number } = {}): Promise<EntryInfo[]> {
    const { depth, ...rest } = options;
    const { data } = await this.t.json<EntryInfo[]>({ method: "GET", path: this.p("/fs/list"), query: { path, depth }, options: rest });
    return data;
  }

  /** Details of a file or directory. Throws {@link NotFoundError} when it does not exist. */
  async stat(path: string, options?: RequestOptions): Promise<EntryInfo> {
    const { data } = await this.t.json<EntryInfo>({ method: "GET", path: this.p("/fs/stat"), query: { path }, options });
    return data;
  }

  /** Whether a file or directory exists. */
  async exists(path: string, options?: RequestOptions): Promise<boolean> {
    try {
      await this.stat(path, options);
      return true;
    } catch (e) {
      // 404 also means "no such sandbox" – that must not look like a missing file
      if (e instanceof NotFoundError && !/sandbox not found/i.test(e.message)) return false;
      throw e;
    }
  }

  /** Creates a directory (with missing parents unless `parents: false`). An existing directory is not an error. */
  async mkdir(path: string, options: RequestOptions & { parents?: boolean } = {}): Promise<EntryInfo> {
    const { parents = true, ...rest } = options;
    const { data } = await this.t.json<EntryInfo>({
      method: "POST",
      path: this.p("/fs/mkdir"),
      json: { path, parents },
      idempotent: parents, // creating an existing directory with parents is not an error
      options: rest,
    });
    return data;
  }

  /** Moves or renames a file or directory. Refused with {@link ConflictError} when `to` exists, unless `overwrite`. */
  async move(from: string, to: string, options: RequestOptions & { overwrite?: boolean } = {}): Promise<EntryInfo> {
    const { overwrite = false, ...rest } = options;
    const { data } = await this.t.json<EntryInfo>({
      method: "POST",
      path: this.p("/fs/move"),
      json: { from, to, overwrite },
      options: rest,
    });
    return data;
  }

  /**
   * Deletes a file or an empty directory; `recursive: true` deletes a directory with its
   * contents. Throws {@link NotFoundError} when the path does not exist.
   */
  async remove(path: string, options: RequestOptions & { recursive?: boolean } = {}): Promise<void> {
    const { recursive = false, ...rest } = options;
    await this.t.json({
      method: "POST",
      path: this.p("/fs/remove"),
      json: { path, recursive },
      options: rest,
    });
  }

  /**
   * Watches a path for changes and yields events (`start`, then `create`, `write`, `remove`,
   * `rename`, `chmod`). Stop by breaking out of the loop or aborting the signal.
   */
  async *watch(path: string, options: { recursive?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<WatchEvent> {
    const { body, release } = await this.t.stream({
      method: "GET",
      path: this.p("/fs/watch"),
      query: { path, recursive: options.recursive ? "true" : undefined },
      headers: { Accept: "application/x-ndjson" },
      options: { signal: options.signal, timeoutMs: 60_000 },
    });
    try {
      yield* readNDJSON<WatchEvent>(body, { maxLineSize: this.t.config.maxStreamEventSize });
    } finally {
      release();
    }
  }
}

/** Options of {@link Processes.start}. */
export interface ProcessStartOptions extends RequestOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Your label, to find the process later. */
  tag?: string;
  /** Run in a terminal (PTY) of this size. */
  pty?: { cols: number; rows: number };
  /** Keep standard input open for {@link Processes.sendStdin} (default: true with a PTY). */
  stdin?: boolean;
}

/**
 * Background processes (`sandbox.processes`): start a server or a long task, reconnect to its
 * output later (the last 1 MB per stream is kept), send input and signals.
 */
export class Processes {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(
    private readonly t: Transport,
    private readonly id: string,
  ) {}

  private p(rest = "") {
    return `/v1/sandboxes/${enc(this.id)}/process${rest}`;
  }

  /** Starts a process in the background and returns its PID. */
  async start(cmd: string, options: ProcessStartOptions = {}): Promise<{ pid: number }> {
    const { env, cwd, tag, pty, stdin, ...rest } = options;
    const { data } = await this.t.json<{ pid: number }>({
      method: "POST",
      path: this.p(),
      json: compact({ cmd, env, cwd, tag, pty, stdin }),
      options: rest,
    });
    return data;
  }

  /** Running and recently finished processes (finished ones are kept for 10 minutes). */
  async list(options?: RequestOptions): Promise<ProcessInfo[]> {
    return (await this.t.json<ProcessInfo[]>({ method: "GET", path: this.p(), options })).data;
  }

  /** Details of one process. */
  async get(pid: number, options?: RequestOptions): Promise<ProcessInfo> {
    return (await this.t.json<ProcessInfo>({ method: "GET", path: this.p(`/${pid}`), options })).data;
  }

  /**
   * Output of a process: what it printed so far (unless `replay: false`), then live output,
   * then an `exit` event. `lagged` means a slow reader skipped some output.
   */
  async *stream(pid: number, options: { replay?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<ProcessEvent> {
    const { body, release } = await this.t.stream({
      method: "GET",
      path: this.p(`/${pid}/stream`),
      query: { replay: options.replay === false ? "false" : undefined },
      headers: { Accept: "application/x-ndjson" },
      options: { signal: options.signal, timeoutMs: 60_000 },
    });
    try {
      yield* readNDJSON<ProcessEvent>(body, { maxLineSize: this.t.config.maxStreamEventSize });
    } finally {
      release();
    }
  }

  /** Writes to the process's standard input (text as UTF-8, or bytes); `eof: true` closes it. */
  async sendStdin(pid: number, data: string | Uint8Array, options: RequestOptions & { eof?: boolean } = {}): Promise<void> {
    const { eof, ...rest } = options;
    const json = typeof data === "string" ? { data, eof: !!eof } : { data_b64: bytesToBase64(data), eof: !!eof };
    await this.t.json({ method: "POST", path: this.p(`/${pid}/stdin`), json, options: rest });
  }

  /** Sends a signal to the process group. */
  async signal(pid: number, signal: Signal, options?: RequestOptions): Promise<void> {
    await this.t.json({ method: "POST", path: this.p(`/${pid}/signal`), json: { signal }, idempotent: true, options });
  }

  /** Resizes the terminal of a PTY process. */
  async resize(pid: number, cols: number, rows: number, options?: RequestOptions): Promise<void> {
    await this.t.json({ method: "POST", path: this.p(`/${pid}/resize`), json: { cols, rows }, idempotent: true, options });
  }

  /** Kills the process and its whole process group (SIGKILL). */
  async kill(pid: number, options?: RequestOptions): Promise<void> {
    await this.t.json({ method: "DELETE", path: this.p(`/${pid}`), options });
  }
}

/** Options of {@link Metrics.stream}. */
export interface MetricsStreamOptions {
  /** Stops the stream. */
  signal?: AbortSignal;
  /** First send the samples since this time (Date or Unix ms) that are still kept, then live ones. */
  since?: Date | number;
  /** Called with every `state` event (first on connect, then on changes such as falling asleep). */
  onState?: (state: MetricsStreamState) => void;
  /** Called when the server ends the stream, with its reason (`timeout`, `not_running`, `ended`). */
  onEnd?: (reason: MetricsStreamEndReason) => void;
  /**
   * Reconnect when the server ends the stream because of its time limit (reason `timeout`,
   * after 15 minutes) or the connection drops; missed samples are fetched with `since` and
   * samples already yielded are skipped. Streams ended because the sandbox is not running
   * are never resumed. Default `false`.
   */
  reconnect?: boolean;
  /**
   * Reconnection attempts in a row after failures before giving up (default 5). A connection
   * that ends (or breaks) within 30 seconds of opening counts as a failure too, so a server
   * or proxy that keeps closing the stream at once is retried with growing delays and then
   * given up, instead of being reconnected in a tight loop.
   */
  maxReconnects?: number;
  /**
   * The most connections the iterator opens within any 60 seconds (default 6); further
   * reconnects wait. The server allows 10 stream openings a minute per sandbox.
   */
  maxConnectsPerMinute?: number;
}

/** A metrics stream that lasted at least this long counts as healthy (resets the failure count). */
const STABLE_STREAM_MS = 30_000;

/**
 * Resource use of the sandbox (`sandbox.metrics`). `get()` measures inside the VM;
 * `history()` and `stream()` are measured by the host and need the `metrics_history`
 * feature (otherwise {@link FeatureDisabledError}).
 */
export class Metrics {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(
    private readonly t: Transport,
    private readonly id: string,
  ) {}

  /** CPU, memory and disk use now, measured inside the VM (takes ~200 ms). */
  async get(options?: RequestOptions): Promise<SandboxMetrics> {
    return (await this.t.json<SandboxMetrics>({ method: "GET", path: `/v1/sandboxes/${enc(this.id)}/metrics`, options })).data;
  }

  /**
   * Samples of the last hour (every 10 s): CPU, memory, network and disk I/O. Feature
   * `metrics_history`. Does not wake a sleeping sandbox (it returns no samples then).
   * Limited to 30 calls a minute per sandbox (429 `rate_limited`, retried after `Retry-After`).
   */
  async history(options: RequestOptions & { since?: Date | number } = {}): Promise<MetricsHistory> {
    const { since, ...rest } = options;
    return (
      await this.t.json<MetricsHistory>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.id)}/metrics/history`,
        query: { since: since === undefined ? undefined : toUnixMs(since) },
        options: rest,
      })
    ).data;
  }

  /**
   * Live samples (Server-Sent Events) as an async iterator. Feature `metrics_history`.
   * At most 10 streams may be opened a minute per sandbox and 10 may run at once per
   * account (429 `rate_limited`).
   *
   * ```ts
   * const ac = new AbortController();
   * for await (const s of sandbox.metrics.stream({ signal: ac.signal, reconnect: true })) {
   *   console.log(new Date(s.t), s.cpu_pct, s.mem_mb);
   * }
   * ```
   */
  async *stream(options: MetricsStreamOptions = {}): AsyncGenerator<MetricsSample> {
    const max = options.maxReconnects ?? 5;
    const perMinute = Math.max(1, Math.floor(options.maxConnectsPerMinute ?? 6));
    let lastT = options.since === undefined ? -Infinity : toUnixMs(options.since) - 1;
    let failures = 0;
    const opened: number[] = []; // times of recent connection attempts
    for (;;) {
      // cap the connection rate: wait until the oldest attempt of the window is a minute old
      for (;;) {
        const now = Date.now();
        while (opened.length > 0 && now - opened[0]! >= 60_000) opened.shift();
        if (opened.length < perMinute) break;
        await sleep(opened[0]! + 60_000 - now, options.signal);
      }
      opened.push(Date.now());
      let endReason: MetricsStreamEndReason | undefined;
      let openedAt: number | undefined;
      try {
        const since = Number.isFinite(lastT) ? lastT + 1 : undefined;
        const { body, release } = await this.t.stream({
          method: "GET",
          path: `/v1/sandboxes/${enc(this.id)}/metrics/stream`,
          query: { since },
          headers: { Accept: "text/event-stream" },
          options: { signal: options.signal, timeoutMs: 60_000, maxRetries: 0 },
        });
        openedAt = Date.now();
        try {
          for await (const ev of readSSE(body, new SSEParser({ maxEventSize: this.t.config.maxStreamEventSize }))) {
            if (ev.event === "sample") {
              const s = JSON.parse(ev.data) as MetricsSample;
              if (typeof s.t !== "number" || s.t > lastT) {
                if (typeof s.t === "number") lastT = s.t;
                yield s;
              }
            } else if (ev.event === "state") {
              options.onState?.(JSON.parse(ev.data) as MetricsStreamState);
            } else if (ev.event === "end") {
              endReason = parseEnd(ev.data);
              options.onEnd?.(endReason);
              break;
            }
          }
        } finally {
          release();
        }
      } catch (e) {
        if (options.signal?.aborted || isAbortLike(e)) throw e;
        if (!options.reconnect || !retryableStreamError(e)) throw e;
        if (openedAt !== undefined && Date.now() - openedAt >= STABLE_STREAM_MS) failures = 0;
        if (++failures > max) throw e;
        const ra = (e as { retryAfter?: unknown }).retryAfter;
        if (typeof ra === "number" && ra > 60) throw e;
        await sleep(typeof ra === "number" ? ra * 1000 : backoffMs(failures - 1), options.signal);
        continue;
      }
      // resume only after the server's time limit or a dropped connection – not when the sandbox stopped
      if (!options.reconnect || options.signal?.aborted) return;
      if (endReason !== undefined && endReason !== "timeout") return;
      if (Date.now() - openedAt! >= STABLE_STREAM_MS) {
        failures = 0;
        // a dropped connection: a short random pause, so many clients do not reconnect at once
        if (endReason === undefined) await sleep(backoffMs(0), options.signal);
      } else {
        // ended right after it opened: back off like after a failure
        if (++failures > max) {
          throw new ConnectionError(
            `the metrics stream of ${this.id} ended right after opening ${failures} times in a row – giving up`,
          );
        }
        await sleep(backoffMs(failures - 1), options.signal);
      }
    }
  }
}

function parseEnd(data: string): MetricsStreamEndReason {
  try {
    const v = JSON.parse(data) as { reason?: unknown };
    return typeof v?.reason === "string" ? v.reason : "ended";
  } catch {
    return "ended";
  }
}

function retryableStreamError(e: unknown): boolean {
  if (e instanceof StreamLimitError) return false;
  const status = (e as { status?: unknown }).status;
  if (typeof status !== "number") return e instanceof WBXError; // connection / timeout
  return status === 429 || status >= 500;
}

/** Options of {@link Computer.screenshot}. */
export interface ScreenshotOptions extends RequestOptions {
  /** Image format (default `png`). */
  format?: "png" | "jpeg";
  /** JPEG quality 1–100. */
  quality?: number;
  /** Scale the image down to at most this width in pixels. */
  maxWidth?: number;
}

/** Options of {@link Computer.actions} and its convenience methods. */
export interface ActionOptions extends RequestOptions {
  /** Return a screenshot taken after the actions (only when all of them succeeded). */
  screenshot?: boolean;
  /** Format of that screenshot (default `png`). Needs `screenshot: true`. */
  screenshotFormat?: "png" | "jpeg";
  /** JPEG quality 1–100 of that screenshot. Needs `screenshot: true`. */
  screenshotQuality?: number;
  /** Scale that screenshot down to at most this width in pixels. Needs `screenshot: true`. */
  screenshotMaxWidth?: number;
  /**
   * Throw {@link ComputerActionError} when an action fails (the server answers HTTP 200 with
   * `ok: false`). Default `true`; with `false` the result carries `ok`, `error` and `failedIndex`.
   */
  throwOnFailure?: boolean;
}

interface RawActionsResult {
  ok: boolean;
  results?: ComputerActionResultEntry[];
  error?: string;
  failed_index?: number;
  screenshot?: {
    format: string;
    width: number;
    height: number;
    screen_width?: number;
    screen_height?: number;
    data_base64: string;
  };
  screenshot_error?: string;
}

/** A positive integer from a response header, or undefined. */
function headerInt(h: Headers, name: string): number | undefined {
  const v = h.get(name);
  if (v === null || !/^\d+$/.test(v.trim())) return undefined;
  return Number(v);
}

/**
 * The graphical desktop of a sandbox started from the `desktop` template
 * (`sandbox.computer`, feature `desktop`). Coordinates are screen pixels.
 *
 * When a person takes control in the portal, actions fail with {@link HumanInControlError}
 * until control is handed back or its time runs out.
 */
export class Computer {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(
    private readonly t: Transport,
    private readonly id: string,
  ) {}

  private p(rest: string) {
    return `/v1/sandboxes/${enc(this.id)}/computer${rest}`;
  }

  /** Whether the desktop runs, its size and who controls it. */
  async status(options?: RequestOptions): Promise<ComputerStatus> {
    return (await this.t.json<ComputerStatus>({ method: "GET", path: this.p("/status"), options })).data;
  }

  /** Takes a screenshot. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const { format, quality, maxWidth, ...rest } = options;
    const { data, headers } = await this.t.bytes({
      method: "GET",
      path: this.p("/screenshot"),
      query: { format, quality, max_width: maxWidth },
      headers: { Accept: "image/png, image/jpeg" },
      options: rest,
    });
    const ct = headers.get("content-type") ?? "";
    const shot: Screenshot = {
      data,
      format: ct.includes("jpeg") ? "jpeg" : ct.includes("png") ? "png" : (format ?? "png"),
      width: headerInt(headers, "x-wbx-width") ?? 0,
      height: headerInt(headers, "x-wbx-height") ?? 0,
    };
    const sw = headerInt(headers, "x-wbx-screen-width");
    const sh = headerInt(headers, "x-wbx-screen-height");
    if (sw !== undefined) shot.screenWidth = sw;
    if (sh !== undefined) shot.screenHeight = sh;
    return shot;
  }

  /**
   * Performs a list of actions in order (mouse, keyboard, waits). With `screenshot: true` the
   * result includes a screenshot taken afterwards. Not retried automatically.
   *
   * The server stops at the first action that fails (the ones before it were performed) and
   * reports it with HTTP 200 and `ok: false`: this throws {@link ComputerActionError} with
   * `failedIndex` and `results`, unless `throwOnFailure: false` is passed.
   *
   * The HTTP limit defaults to 5 minutes (not the client's `timeoutMs`): typing long text,
   * waits and queued requests can take more than a minute. Pass `timeoutMs` to change it.
   * The same holds for the shortcuts (`click`, `type`, `key`, `scroll`, …).
   */
  async actions(actions: ComputerAction[], options: ActionOptions = {}): Promise<ComputerActionsResult> {
    const { screenshot, screenshotFormat, screenshotQuality, screenshotMaxWidth, throwOnFailure = true, ...rest } = options;
    const shotOpts = compact({
      screenshot_format: screenshotFormat,
      screenshot_quality: screenshotQuality,
      screenshot_max_width: screenshotMaxWidth,
    });
    if (!screenshot && Object.keys(shotOpts).length > 0) {
      throw new TypeError("screenshotFormat, screenshotQuality and screenshotMaxWidth need screenshot: true");
    }
    const { data } = await this.t.json<RawActionsResult>({
      method: "POST",
      path: this.p("/actions"),
      json: { actions, screenshot: !!screenshot, ...shotOpts },
      defaultTimeoutMs: COMPUTER_ACTIONS_TIMEOUT_MS,
      options: rest,
    });
    const ok = data.ok === true;
    const out: ComputerActionsResult = { ok, results: data.results ?? [] };
    if (!ok) {
      out.error = typeof data.error === "string" && data.error ? data.error : "a desktop action failed";
      if (typeof data.failed_index === "number") out.failedIndex = data.failed_index;
      if (throwOnFailure) {
        throw new ComputerActionError(out.error, out.failedIndex ?? Math.max(0, out.results.length - 1), out.results);
      }
    }
    if (data.screenshot) {
      out.screenshot = {
        data: base64ToBytes(data.screenshot.data_base64),
        format: data.screenshot.format,
        width: data.screenshot.width,
        height: data.screenshot.height,
      };
      if (typeof data.screenshot.screen_width === "number") out.screenshot.screenWidth = data.screenshot.screen_width;
      if (typeof data.screenshot.screen_height === "number") out.screenshot.screenHeight = data.screenshot.screen_height;
    }
    if (typeof data.screenshot_error === "string") out.screenshotError = data.screenshot_error;
    return out;
  }

  /**
   * Sets who controls the desktop and returns the resulting status. With an API key only
   * `agent` is accepted (takes control back); `human` is reserved for a person in the portal
   * and is refused with HTTP 403 `human_only`.
   */
  async control(mode: "human" | "agent", options: RequestOptions & { ttlSeconds?: number } = {}): Promise<ComputerStatus> {
    const { ttlSeconds, ...rest } = options;
    const { data } = await this.t.json<ComputerStatus>({
      method: "POST",
      path: this.p("/control"),
      json: compact({ mode, ttl_s: ttlSeconds }),
      idempotent: true,
      options: rest,
    });
    return data as ComputerStatus;
  }

  /** Moves the mouse. */
  move(x: number, y: number, options?: ActionOptions) {
    return this.actions([{ type: "move", x, y }], options);
  }

  /** Clicks at a point (`count: 2` = double click). */
  click(x: number, y: number, options: ActionOptions & { button?: MouseButton; count?: number } = {}) {
    const { button, count, ...rest } = options;
    return this.actions([{ type: "click", x, y, ...compact({ button, count }) }], rest);
  }

  /** Double-clicks at a point. */
  doubleClick(x: number, y: number, options: ActionOptions & { button?: MouseButton } = {}) {
    return this.click(x, y, { ...options, count: 2 });
  }

  /** Drags from one point to another. */
  drag(x: number, y: number, toX: number, toY: number, options: ActionOptions & { button?: MouseButton } = {}) {
    const { button, ...rest } = options;
    return this.actions([{ type: "drag", x, y, to_x: toX, to_y: toY, ...compact({ button }) }], rest);
  }

  /**
   * Scrolls at a point: `dx` wheel steps to the right (negative = left), then `dy` down
   * (negative = up). Note the order `(x, y, dx, dy)` – the Python SDK's `scroll(x, y, dy, dx)`
   * takes dy first, so code ported between the SDKs should pass `0` explicitly, e.g.
   * `scroll(640, 400, 0, 5)` scrolls 5 steps down.
   */
  scroll(x: number, y: number, dx: number, dy: number, options?: ActionOptions) {
    return this.actions([{ type: "scroll", x, y, dx, dy }], options);
  }

  /** Types text. */
  type(text: string, options?: ActionOptions) {
    return this.actions([{ type: "type", text }], options);
  }

  /** Presses a key or a combination, e.g. `"Return"`, `"ctrl+c"`, `"ctrl+shift+t"`. */
  key(keys: string, options?: ActionOptions) {
    return this.actions([{ type: "key", keys }], options);
  }

  /** Waits on the server between actions (milliseconds). */
  wait(ms: number, options?: ActionOptions) {
    return this.actions([{ type: "wait", ms }], options);
  }
}

/** Options of {@link Sandbox.runCode}. */
export interface RunCodeOptions extends Omit<RunOptions, "env" | "cwd" | "stdin"> {
  /** `python` (default), `node` or `bash`. */
  language?: "python" | "node" | "bash";
}

const RUNNERS = { python: [".py", "python3"], node: [".js", "node"], bash: [".sh", "bash"] } as const;

/**
 * A sandbox – an isolated Linux microVM. Obtain one from `wbx.sandboxes.create()` or
 * `wbx.sandboxes.get(id)`.
 *
 * `info` holds the API record (snake_case fields); the getters below read from it and the
 * lifecycle methods refresh it.
 */
export class Sandbox {
  /** Sandbox ID (`sb_…`). */
  readonly id: string;
  /** The API record of the sandbox as last seen. */
  info: SandboxInfo;
  /** True when `create({ name })` returned an existing sandbox instead of a new one. */
  readonly existing: boolean;
  /** Shell commands. */
  readonly commands: Commands;
  /** Files. */
  readonly files: Files;
  /** Background processes and terminals. */
  readonly processes: Processes;
  /** Resource use (history and live stream need the `metrics_history` feature). */
  readonly metrics: Metrics;
  /** Desktop control for the `desktop` template (feature `desktop`). */
  readonly computer: Computer;
  private readonly t: Transport;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(t: Transport, info: SandboxInfo, existing = false) {
    this.t = t;
    this.id = info.id;
    this.info = info;
    this.existing = existing;
    this.commands = new Commands(t, info.id);
    this.files = new Files(t, info.id);
    this.processes = new Processes(t, info.id);
    this.metrics = new Metrics(t, info.id);
    this.computer = new Computer(t, info.id);
  }

  /** Current state as last seen (`running`, `paused`, `sleeping`, …). */
  get state(): SandboxState {
    return this.info.state;
  }

  /** Template the sandbox was created from. */
  get template(): string {
    return this.info.template;
  }

  /** Name of a named sandbox. */
  get name(): string | undefined {
    return this.info.name;
  }

  /** The public IPv6 address (`network.ip` `dual` or `ipv6`). */
  get ipv6(): string | undefined {
    const v = this.info.info?.["ipv6"];
    return typeof v === "string" && v ? v : undefined;
  }

  /** IP version of the sandbox. */
  get ip(): IPMode | string | undefined {
    return this.info.ip;
  }

  private path(rest = "") {
    return `/v1/sandboxes/${enc(this.id)}${rest}`;
  }

  private async lifecycle(action: string, json: unknown, options?: RequestOptions): Promise<this> {
    const { data } = await this.t.json<SandboxInfo>({
      method: "POST",
      path: this.path(`/${action}`),
      json,
      defaultTimeoutMs: CREATE_TIMEOUT_MS,
      options,
    });
    if (data && typeof data === "object" && "id" in data) this.info = data;
    return this;
  }

  /** Reloads the sandbox record. */
  async refresh(options?: RequestOptions): Promise<this> {
    this.info = (await this.t.json<SandboxInfo>({ method: "GET", path: this.path(), options })).data;
    return this;
  }

  /** Destroys the sandbox with its disk and memory. No error when it is already gone. */
  async kill(options?: RequestOptions): Promise<void> {
    try {
      await this.t.json({ method: "DELETE", path: this.path(), options });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  /** Sets the remaining lifetime to `seconds` from now. */
  setTimeout(seconds: number, options?: RequestOptions): Promise<this> {
    return this.lifecycle("timeout", { timeout_s: Math.floor(seconds) }, options);
  }

  /**
   * Puts the sandbox to sleep: files are kept, running programs stop, no compute is billed.
   * Any later request (or {@link resume}) wakes it up in a few seconds.
   */
  sleep(options?: RequestOptions): Promise<this> {
    return this.lifecycle("sleep", undefined, options);
  }

  /** Freezes the sandbox with its memory; it continues exactly where it stopped on {@link resume}. */
  pause(options?: RequestOptions): Promise<this> {
    return this.lifecycle("pause", undefined, options);
  }

  /** Continues a paused sandbox or wakes a sleeping one. */
  resume(options?: RequestOptions): Promise<this> {
    return this.lifecycle("resume", undefined, options);
  }

  /**
   * Keeps the sandbox `days` days after it falls asleep before it is deleted with its files
   * (0 = your plan's default; the plan sets the maximum).
   */
  async keep(days: number, options?: RequestOptions): Promise<KeepResult> {
    return (await this.t.json<KeepResult>({ method: "PUT", path: this.path("/keep"), json: { keep_days: Math.floor(days) }, options })).data;
  }

  /**
   * Public HTTPS address of a TCP port in the sandbox (a web app or API you started there).
   * The app must listen on `0.0.0.0`. Open `url_with_token` in a browser or send the header
   * `X-WBX-Token: <token>`.
   */
  async getUrl(port: number, options?: RequestOptions): Promise<PortURL> {
    return (await this.t.json<PortURL>({ method: "GET", path: this.path("/url"), query: { port: Math.floor(port) }, options })).data;
  }

  /**
   * Runs a piece of code (`python`, `node` or `bash`): writes it to a temporary file and runs
   * it, so parallel calls do not interfere.
   *
   * ```ts
   * const r = await sandbox.runCode("print(sum(range(100)))");
   * console.log(r.stdout); // "4950\n"
   * ```
   */
  async runCode(code: string, options: RunCodeOptions = {}): Promise<CommandResult> {
    const { language = "python", ...run } = options;
    const runner = RUNNERS[language];
    if (!runner) throw new WBXError(`unsupported language ${JSON.stringify(language)} (use python, node or bash)`);
    const [ext, interp] = runner;
    const file = `/tmp/_wbx_code_${randomId().replace(/-/g, "")}${ext}`;
    await this.files.write(file, code, { signal: run.signal });
    return this.commands.run(`${interp} ${file}; rc=$?; rm -f ${file}; exit $rc`, run);
  }

  /** @internal */
  toJSON(): SandboxInfo {
    return this.info;
  }
}

/** `wbx.sandboxes` */
export class Sandboxes {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /**
   * Creates a sandbox (or, with `name`, returns your existing sandbox of that name).
   *
   * ```ts
   * const sandbox = await wbx.sandboxes.create({ template: "base", name: "my-project" });
   * ```
   *
   * A create with `name` is safe to repeat, so it is retried after temporary errors; one
   * without a name is never retried automatically.
   */
  async create(params: SandboxCreateParams = {}, options?: RequestOptions): Promise<Sandbox> {
    const body = compact({
      template: params.template,
      timeout_s: params.timeoutSeconds,
      name: params.name,
      on_timeout: params.onTimeout,
      idle_timeout_s: params.idleTimeoutSeconds,
      keep_days: params.keepDays,
      metadata: params.metadata,
      env: params.env,
      vcpu: params.vcpu,
      mem_mb: params.memMb,
      compute_class: params.computeClass,
      optimize_for: params.optimizeFor,
      placement: params.placement,
      dependency_cache: params.dependencyCache,
      network: params.network,
    });
    const { data, headers } = await this.t.json<SandboxInfo>({
      method: "POST",
      path: "/v1/sandboxes",
      json: body,
      idempotent: !!params.name,
      defaultTimeoutMs: CREATE_TIMEOUT_MS,
      options,
    });
    return new Sandbox(this.t, data, headers.get("x-wbx-existing") === "1");
  }

  /** Attaches to an existing sandbox by its ID (for example in the next turn of a conversation). */
  async get(id: string, options?: RequestOptions): Promise<Sandbox> {
    const { data } = await this.t.json<SandboxInfo>({ method: "GET", path: `/v1/sandboxes/${enc(id)}`, options });
    return new Sandbox(this.t, data);
  }

  /**
   * Your sandboxes – running, paused, sleeping and archived – oldest first. The API returns
   * them all at once (no pages).
   */
  async list(options?: RequestOptions): Promise<Sandbox[]> {
    const { data } = await this.t.json<SandboxInfo[]>({ method: "GET", path: "/v1/sandboxes", options });
    return (data ?? []).map((d) => new Sandbox(this.t, d));
  }

  /** Destroys a sandbox by ID. No error when it is already gone. */
  async kill(id: string, options?: RequestOptions): Promise<void> {
    try {
      await this.t.json({ method: "DELETE", path: `/v1/sandboxes/${enc(id)}`, options });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
}

/** @internal */
export function enc(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Records returned by the REST API. Field names are the API's own (snake_case), so the REST
 * documentation applies to them unchanged. Options you pass to SDK methods are camelCase.
 *
 * String unions end with `(string & {})` where the server may add new values later.
 * @module
 */

/** Any JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Lifecycle state of a sandbox. */
export type SandboxState =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "falling_asleep"
  | "sleeping"
  | "waking"
  | "archiving"
  | "archived"
  | (string & {});

/** IP version of a sandbox or job: `ipv4`, `dual` (IPv4 + own public IPv6) or `ipv6` (IPv6 only). */
export type IPMode = "ipv4" | "dual" | "ipv6";

/** Network policy of a sandbox or job. It can only make your team's policy stricter. */
export interface NetworkOptions {
  /** `full` internet (default), `allowlist` (only `allow`) or `none`. */
  mode?: "full" | "allowlist" | "none";
  /** Domains or addresses that stay reachable in `allowlist` mode, e.g. `["pypi.org"]`. */
  allow?: string[];
  /** Additional blocked destinations. */
  block?: string[];
  /** IP version. IPv6 is never silently downgraded – the request is refused when no server has it. */
  ip?: IPMode;
}

/** A sandbox as returned by the API. */
export interface SandboxInfo {
  id: string;
  template: string;
  state: SandboxState;
  vcpu: number;
  mem_mb: number;
  created_at: string;
  expires_at: string;
  metadata?: Record<string, string>;
  /** Extra details, e.g. `ipv6` (the public IPv6 address with `ip: "dual" | "ipv6"`). */
  info?: Record<string, JsonValue>;
  network?: string;
  ip?: IPMode | (string & {});
  compute_class?: string;
  template_build?: Record<string, JsonValue>;
  name?: string;
  on_timeout?: "kill" | "pause" | (string & {});
  idle_timeout_s?: number;
  timeout_s?: number;
  last_used?: string;
  slept_at?: string;
  woken_at?: string;
  disk_bytes?: number;
  keep_days?: number;
  /** When a sleeping sandbox will be deleted with its files. */
  delete_at?: string;
  delete_reason?: string;
}

/** A snapshot of a sandbox disk (`GET /v1/snapshots/{id}`). Files only – never env or memory. */
export interface SnapshotInfo {
  /** Snapshot ID (`snap_…`). */
  id: string;
  name?: string;
  /** ID of the sandbox the snapshot was taken from (it may no longer exist). */
  source_sandbox?: string;
  template: string;
  vcpu?: number;
  mem_mb?: number;
  /** Size of the disk in MB (the size a sandbox from this snapshot gets). */
  disk_mb?: number;
  /** Space the snapshot takes – billed as storage. */
  size_bytes?: number;
  created_at?: string;
}

/** One copy of a clone that could not be created. */
export interface CloneError {
  /** Position of the copy, 0 … count-1. */
  index?: number;
  /** Name of the copy (`<name>-N` for several copies), empty without `name`. */
  name?: string;
  error?: string;
  code?: string;
  /** HTTP status of the failed create, when the server sent it. */
  status?: number;
  [key: string]: unknown;
}

/** Response of `POST /v1/sandboxes/{id}/clone`. */
export interface CloneResponse {
  snapshot_id?: string;
  /** Whether the snapshot was kept (`keep_snapshot`). */
  snapshot_kept?: boolean;
  sandboxes?: SandboxInfo[];
  errors?: CloneError[];
}

/** Result of `PUT /v1/sandboxes/{id}/keep`. */
export interface KeepResult {
  id: string;
  state?: SandboxState;
  keep_days: number;
  default_keep_days: number;
  max_keep_days: number;
  delete_at?: string;
  delete_reason?: string;
}

/** Public HTTPS address of a port (`GET /v1/sandboxes/{id}/url`). */
export interface PortURL {
  sandbox_id: string;
  port: number;
  host: string;
  /** Address without the token (requests need the `X-WBX-Token` header or the cookie). */
  url: string;
  /** Address to open in a browser – the token moves to a cookie. */
  url_with_token: string;
  token: string;
}

/** A template (`GET /v1/templates`). */
export interface Template {
  name: string;
  vcpu: number;
  mem_mb: number;
  disk_mb?: number;
  snapshot?: boolean;
  created?: string;
  image?: string;
  start_cmd?: string;
}

/** Events of a streamed command (`POST /v1/sandboxes/{id}/exec/stream`). */
export type ExecEvent =
  | { type: "start"; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exit_code: number; duration_ms: number; timed_out: boolean };

/** A file or directory (`/fs/stat`, `/fs/list`, `/fs/mkdir`, `/fs/move`). */
export interface EntryInfo {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  /** Permission bits in octal, e.g. `"0644"`. */
  mode: string;
  mtime_ms: number;
  /** Target of a symbolic link. */
  target?: string;
}

/** Result of a file upload. */
export interface WriteResult {
  path: string;
  size: number;
}

/** Event of `/fs/watch`. */
export type WatchEvent =
  | { type: "start"; path: string; watches: number }
  | { type: "create" | "write" | "remove" | "rename" | "chmod" | (string & {}); path: string; is_dir: boolean };

/** A background process (`/process`). */
export interface ProcessInfo {
  pid: number;
  cmd: string;
  tag: string | null;
  pty: boolean;
  running: boolean;
  exit_code: number | null;
  started_ms: number;
}

/** Events of a process output stream (`/process/{pid}/stream`). */
export type ProcessEvent =
  | { type: "start"; pid: number; truncated: boolean }
  | { type: "stdout" | "stderr" | "pty"; data: string }
  | { type: "lagged"; skipped: number }
  | { type: "exit"; exit_code: number };

/** Signals accepted by `/process/{pid}/signal`. */
export type Signal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGUSR1" | "SIGUSR2" | "SIGSTOP" | "SIGCONT";

/** Current resource use measured inside the VM (`GET /v1/sandboxes/{id}/metrics`). */
export interface SandboxMetrics {
  cpu_count: number;
  cpu_used_pct: number;
  mem_total_mb: number;
  mem_used_mb: number;
  disk_total_mb: number;
  disk_used_mb: number;
}

/**
 * One sample of the host-side metrics (feature `metrics_history`). Cumulative counters
 * (`cpu_ms`, `*_bytes`, `*_packets`) count from the start or the last wake-up of the sandbox.
 * Rates ending in `_bps` are **bytes** per second (not bits).
 */
export interface MetricsSample {
  /** Time of the sample, Unix milliseconds. */
  t: number;
  /** CPU use 0–100 % of all vCPUs of the sandbox together. */
  cpu_pct: number;
  /** CPU time used, milliseconds (cumulative). */
  cpu_ms: number;
  mem_mb: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
  net_rx_packets: number;
  net_tx_packets: number;
  /** Received bytes per second. */
  net_rx_bps: number;
  /** Sent bytes per second. */
  net_tx_bps: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  /** Disk read, bytes per second. */
  disk_read_bps: number;
  /** Disk write, bytes per second. */
  disk_write_bps: number;
}

/** `event: state` of the metrics stream: the sandbox state (and the sampling interval). */
export interface MetricsStreamState {
  state: SandboxState;
  interval_s?: number;
}

/** Why the server ended a metrics stream (`event: end`). */
export type MetricsStreamEndReason = "timeout" | "not_running" | "ended" | (string & {});

/**
 * `GET /v1/sandboxes/{id}/metrics/history` (feature `metrics_history`). A sleeping sandbox
 * answers with `state: "sleeping"` and no samples (it is not woken up); an archived one with
 * `state: "archived"`.
 */
export interface MetricsHistory {
  source: "host" | (string & {});
  interval_s: number;
  retention_s: number;
  vcpu: number;
  mem_mb: number;
  state: SandboxState;
  samples: MetricsSample[];
}

/** `GET /v1/sandboxes/{id}/computer/status` (template `desktop`, feature `desktop`). */
export interface ComputerStatus {
  available: boolean;
  display: string;
  width: number;
  height: number;
  /** Who controls the desktop now. */
  controller: "agent" | "human";
  /**
   * Until when a person keeps control at most, as Unix time in milliseconds (the earlier of
   * their time limit and their inactivity limit); `null` while the agent controls the desktop.
   */
  controller_until: number | null;
  /** Number of people watching. */
  viewers: number;
  /** Why the desktop is not available. */
  reason?: string;
}

/** Mouse button. */
export type MouseButton = "left" | "right" | "middle";

/**
 * One desktop action (`POST /v1/sandboxes/{id}/computer/actions`). Coordinates are screen
 * pixels. `mouse_down` / `mouse_up` take both `x` and `y` (move there first) or neither.
 */
export type ComputerAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: MouseButton; count?: number }
  | { type: "mouse_down"; button?: MouseButton; x?: undefined; y?: undefined }
  | { type: "mouse_down"; x: number; y: number; button?: MouseButton }
  | { type: "mouse_up"; button?: MouseButton; x?: undefined; y?: undefined }
  | { type: "mouse_up"; x: number; y: number; button?: MouseButton }
  | { type: "drag"; x: number; y: number; to_x: number; to_y: number; button?: MouseButton }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "type"; text: string }
  | { type: "key"; keys: string }
  | { type: "wait"; ms: number };

/** A screenshot, decoded. */
export interface Screenshot {
  /** Image bytes (PNG or JPEG). */
  data: Uint8Array;
  format: "png" | "jpeg" | (string & {});
  /** Width of the image in pixels (smaller than the screen when scaled down with `maxWidth`). */
  width: number;
  /** Height of the image in pixels. */
  height: number;
  /** Width of the screen – the coordinate space of actions (when the server sent it). */
  screenWidth?: number;
  /** Height of the screen – the coordinate space of actions (when the server sent it). */
  screenHeight?: number;
}

/** Outcome of one action of a `computer.actions()` call. */
export interface ComputerActionResultEntry {
  /** The action type (`click`, `type`, …). */
  type: string;
  ok: boolean;
  /** Why the action failed. */
  error?: string;
}

/**
 * Result of a list of desktop actions. The server stops at the first failed action; with the
 * default `throwOnFailure: true` that throws `ComputerActionError`, so `ok` is `false`
 * only with `throwOnFailure: false`.
 */
export interface ComputerActionsResult {
  /** Whether every action succeeded. */
  ok: boolean;
  /** One entry per performed action (up to and including a failed one). */
  results: ComputerActionResultEntry[];
  /** Why the actions stopped (when `ok` is false). */
  error?: string;
  /** Index of the failed action (when `ok` is false). */
  failedIndex?: number;
  /** Screenshot taken after the actions (when requested and every action succeeded). */
  screenshot?: Screenshot;
  /** Why the requested screenshot could not be taken (the actions themselves succeeded). */
  screenshotError?: string;
}

/** Features enabled for the account (`GET /v1/features`). */
export interface Features {
  metrics_history?: boolean;
  desktop?: boolean;
  [name: string]: boolean | undefined;
}

// ------------------------------------------------------------------------------------ jobs

/** State of a background job. */
export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "uploading_artifacts"
  | "cleanup_pending"
  | "recovery_pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | (string & {});

/** States after which a job never changes. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled", "expired"];

/** A price as returned by the API. */
export interface Cost {
  /** Decimal amount as text (6 decimal places). */
  amount: string;
  micros: number;
  currency: string;
  basis?: string;
}

/** Why a job failed. */
export interface JobError {
  code: string;
  message: string;
  /** `user` (your command) or `system` (the platform – usually refunded). */
  kind: "user" | "system" | (string & {});
}

/** A result file of a job. */
export interface Artifact {
  name: string;
  size: number;
  sha256: string;
}

/** A result file of an earlier job given to a job as input (`input/<as>`). */
export interface JobInputRef {
  job_id?: string;
  from_index?: number;
  name: string;
  as?: string;
  sha256?: string;
  size?: number;
}

/** A job as returned by `GET /v1/jobs/{id}` and job submission. */
export interface JobInfo {
  id: string;
  status: JobStatus;
  template: string;
  command: string;
  cwd?: string;
  /** Names of the environment variables (values are never returned). */
  env_keys?: string[];
  timeout_s: number;
  artifact_patterns?: string[];
  required_artifacts?: string[];
  artifacts_purged?: boolean;
  network?: NetworkOptions;
  metadata?: Record<string, string>;
  retry: { max_attempts: number; on: string };
  attempt: number;
  retry_of?: string;
  idempotency_key?: string;
  cancel_requested?: boolean;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  finished_at?: string;
  sandbox_id?: string;
  exit_code?: number;
  error?: JobError;
  log_bytes: number;
  artifacts?: Artifact[];
  artifacts_skipped?: string[];
  cost?: Cost;
  refund?: Cost;
  max_cost?: Cost;
  events?: JsonValue[];
  runtime: "firecracker" | "wasi" | (string & {});
  inputs?: JobInputRef[];
  wasm?: Record<string, JsonValue>;
  batch_id?: string;
  depends_on?: string[];
  compute_class?: string;
  class_price?: Record<string, JsonValue>;
  optimize_for?: string;
  /** Present on a retry: names of env variables whose value differs from the original job. */
  [extra: string]: unknown;
}

/** Recognised test results in a job log. */
export interface TestResult {
  [key: string]: JsonValue;
}

/** Short job overview (`GET /v1/jobs/{id}/summary`, items of `GET /v1/jobs`). */
export interface JobSummary {
  id: string;
  status: JobStatus;
  done: boolean;
  exit_code?: number;
  duration_s?: number;
  /** Cost with currency, e.g. `"0.001200 EUR"`. */
  cost?: string;
  attempt: number;
  error?: string;
  artifacts: number;
  artifact_names?: string[];
  log_tail?: string;
  /** What to do next (written for AI agents). */
  next: string;
  runtime: string;
  compute_class?: string;
  template?: string;
  command?: string;
  created_at: string;
  batch_id?: string;
  test_results?: TestResult[];
}

/** A chunk of a job log (`GET /v1/jobs/{id}/logs?offset=&limit=`). */
export interface LogChunk {
  data: string;
  offset: number;
  next_offset: number;
  size: number;
  truncated_start: boolean;
  /** True when the job ended and this chunk reaches the end of the log. */
  complete: boolean;
  status: JobStatus;
}

/** A compact log digest for model context (`GET /v1/jobs/{id}/logs?mode=`). */
export interface LogDigest {
  mode: "summary" | "errors" | "tail";
  text: string;
  size: number;
  lines: number;
  truncated_start: boolean;
  complete: boolean;
  status: JobStatus;
  exit_code?: number | null;
  test_results?: TestResult[];
}

/** The execution receipt of a job (see the REST docs for every field). */
export interface ExecutionReceipt {
  receipt_version: number;
  job_id: string;
  status: JobStatus;
  attempts: number;
  exit_code: number | null;
  artifacts: Artifact[];
  cost: Cost | null;
  [key: string]: unknown;
}

/** A receipt signed by WBX (Ed25519). */
export interface SignedReceipt {
  format: string;
  alg: "Ed25519" | (string & {});
  key_id: string;
  /** Base64 of the signed JSON payload. */
  payload: string;
  /** Base64 Ed25519 signature over the decoded payload bytes. */
  signature: string;
}

/** `GET /v1/jobs/{id}/artifacts`. */
export interface ArtifactList {
  artifacts: Artifact[];
  skipped: string[] | null;
  status: JobStatus;
}

/** Result of `POST /v1/jobs/wait`. */
export interface WaitResult {
  /** True when the condition (`any` / `all`) was met before the timeout. */
  done: boolean;
  finished: number;
  total: number;
  items: Array<{ id: string; kind: "job" | "batch"; status: string; done: boolean }>;
}

// --------------------------------------------------------------------------------- batches

/** Aggregated state of a batch. */
export interface BatchSummary {
  id: string;
  name?: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | (string & {});
  done: boolean;
  total: number;
  counts: Record<string, number>;
  succeeded: number;
  failed: number;
  cost: string;
  cost_micros: number;
  max_cost?: string;
  currency?: string;
  cost_per_completed_job?: string;
  errors_by_code?: Record<string, number>;
  failed_jobs?: string[];
  duration_s?: { avg: number; p50: number; p95: number; max: number };
  /** Measured resource use of the batch's jobs (values are null when not measurable). */
  usage?: BatchUsage;
  created_at: string;
  next: string;
}

/** `usage` of a batch summary. */
export interface BatchUsage {
  cpu_ms_total: number | null;
  /** Jobs whose CPU time could be measured. */
  cpu_measured_jobs: number | null;
  peak_memory_mb_max: number | null;
  sandbox_run_seconds_total: number | null;
  attempts_total: number | null;
  retries: number | null;
  retried_jobs: number | null;
}

/** One row of a batch report. */
export interface BatchReportRow {
  index: number;
  job_id: string;
  status: JobStatus;
  exit_code?: number;
  duration_s?: number;
  cost?: string;
  attempts: number;
  artifacts: number;
  error_code?: string;
  error?: string;
  /** CPU time of the job in ms (null when not measured). */
  cpu_ms?: number | null;
  /** Peak memory of the job in MB (null when not measured). */
  peak_memory_mb?: number | null;
}

/** `GET /v1/batches/{id}/report`. */
export interface BatchReport {
  summary: BatchSummary;
  jobs: BatchReportRow[];
}

// --------------------------------------------------------------------------------- account

/** An amount of money. */
export interface Money {
  micros: number;
  amount: string;
}

/** `GET /v1/budget`. */
export interface Budget {
  currency: string;
  monthly_limit: Money | null;
  daily_limit: Money | null;
  customer_limits: { monthly: Money | null; daily: Money | null };
  admin_limits: { monthly: Money | null; daily: Money | null };
  alert_pct: number;
  spent_this_month: Money;
  spent_today: Money;
  reserved_by_running_jobs: Money;
  left_this_month?: Money;
  left_today?: Money;
  alert: boolean;
  blocked: boolean;
  /** Spend per day (with `{ days: true }`). */
  days?: Array<{ day: string; currency: string; micros: number; amount: string; jobs: number }>;
  note: string;
  limits_currency?: string;
  warning?: string;
}

/** A compute class available to the account. */
export interface ComputeClass {
  name: string;
  label: string;
  use?: string;
  cpu_price_permille: number;
  mem_price_permille: number;
  vcpu_hour?: string;
  gb_hour?: string;
  currency?: string;
  available: boolean;
  reason?: string;
  disabled?: boolean;
  dedicated?: boolean;
  is_default: boolean;
}

/** `GET /v1/compute/preferences`. */
export interface ComputePreferences {
  default_compute_class: string;
  effective_compute_class: string;
  effective_error?: string;
  global_default: string;
  classes: ComputeClass[];
  note: string;
  optimize_for_options: string[];
}

/** A job runtime (`GET /v1/runtimes`). */
export interface RuntimeDescription {
  name: "firecracker" | "wasi" | (string & {});
  isolation: string;
  security_level: number;
  untrusted_code_allowed: boolean;
  capabilities: string[];
  limits: string;
  [key: string]: unknown;
}

/** `GET /v1/runtimes`. */
export interface Runtimes {
  runtimes: RuntimeDescription[];
  wasi_available: boolean;
}

/** A public key that signs execution receipts (`GET /v1/receipt-keys`). */
export interface ReceiptKey {
  key_id: string;
  alg: string;
  /** Raw Ed25519 public key, base64. */
  public_key: string;
  public_key_pem: string;
  created_at: string;
}

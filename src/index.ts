/**
 * Official TypeScript SDK for WBX Sandbox – isolated cloud sandboxes (Firecracker microVMs)
 * for AI agents.
 *
 * ```ts
 * import { WBX } from "wbxsandbox";
 *
 * const wbx = new WBX(); // API key from WBXSANDBOX_API_KEY
 * const sandbox = await wbx.sandboxes.create({ template: "base" });
 * console.log((await sandbox.commands.run("uname -a")).stdout);
 * await sandbox.kill();
 * ```
 *
 * @packageDocumentation
 */

export { WBX, DEFAULT_BASE_URL, type ClientOptions } from "./client.js";
export { Transport, type RequestOptions, type Query, type TransportConfig, type TransportSettings } from "./http.js";
export {
  Sandbox,
  Sandboxes,
  Commands,
  CommandResult,
  Files,
  Processes,
  Metrics,
  Computer,
  type SandboxCreateParams,
  type CloneParams,
  type CloneResult,
  type RunOptions,
  type RunCodeOptions,
  type FileData,
  type ProcessStartOptions,
  type MetricsStreamOptions,
  type ScreenshotOptions,
  type ActionOptions,
} from "./sandbox.js";
export {
  Job,
  Jobs,
  Batch,
  Batches,
  type JobCreateParams,
  type BatchJobParams,
  type BatchCreateParams,
  type JobInput,
  type WasmOptions,
  type WaitOptions,
} from "./jobs.js";
export { Snapshot, Snapshots } from "./snapshots.js";
export { Templates, BudgetResource, Compute, Webhooks, verifyWebhook } from "./account.js";
export { Page } from "./pagination.js";
export { SSEParser, readNDJSON, readSSE, type SSEEvent, type SSEParserOptions, type NDJSONOptions } from "./streams.js";
export {
  WBXError,
  APIError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  FeatureDisabledError,
  NotFoundError,
  ConflictError,
  HumanInControlError,
  RateLimitError,
  InternalServerError,
  TimeoutError,
  ConnectionError,
  CommandFailedError,
  ComputerActionError,
  StreamLimitError,
  IntegrityError,
  type APIErrorBody,
} from "./errors.js";
export { TERMINAL_JOB_STATUSES } from "./types.js";
export type * from "./types.js";
export { VERSION } from "./version.js";

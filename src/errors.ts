/**
 * Typed errors thrown by the SDK.
 *
 * Every error extends {@link WBXError}. Errors that come from an HTTP response of the API
 * extend {@link APIError} and carry the HTTP status, the machine-readable `code` (when the
 * server sends one) and the parsed `{"error": …}` body.
 *
 * @module
 */

import type { ComputerActionResultEntry } from "./types.js";

/** Base class of every error thrown by this SDK. */
export class WBXError extends Error {
  override name = "WBXError";
}

/** The JSON error body of the API: `{"error": "message", "code"?: "…", …}`. */
export interface APIErrorBody {
  /** Human-readable message. */
  error?: string;
  /** Machine-readable error code (not every error has one). */
  code?: string;
  /** Any further fields the server sent (for example `feature`). */
  [key: string]: unknown;
}

/** Options of the {@link APIError} constructor. */
export interface APIErrorInit {
  status: number;
  message: string;
  code?: string | undefined;
  body?: APIErrorBody | string | undefined;
  headers?: Headers | undefined;
  method?: string | undefined;
  url?: string | undefined;
  retryAfter?: number | undefined;
}

/** The API answered with an error status (4xx or 5xx). */
export class APIError extends WBXError {
  override name = "APIError";
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable code from the error body (`quota`, `feature_disabled`, …), if any. */
  readonly code: string | undefined;
  /** Parsed error body (JSON object) or the raw text when it was not JSON. */
  readonly body: APIErrorBody | string | undefined;
  /** Response headers. */
  readonly headers: Headers | undefined;
  /** HTTP method of the request. */
  readonly method: string | undefined;
  /** Request URL (without the API key, which is never part of a URL). */
  readonly url: string | undefined;
  /**
   * Seconds the server asked the client to wait before retrying (`Retry-After`), if sent.
   * Present on some 429 and 503 responses.
   */
  readonly retryAfter: number | undefined;

  constructor(init: APIErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    this.headers = init.headers;
    this.method = init.method;
    this.url = init.url;
    this.retryAfter = init.retryAfter;
  }
}

/** 400 – the request was invalid (bad JSON, unknown template, invalid option…). */
export class BadRequestError extends APIError {
  override name = "BadRequestError";
}

/** 401 – the API key is missing or invalid. */
export class AuthenticationError extends APIError {
  override name = "AuthenticationError";
}

/**
 * 402 – the account may not start new work right now (code `account_suspended`, for
 * example when the prepaid credit ran out).
 */
export class PaymentRequiredError extends APIError {
  override name = "PaymentRequiredError";
}

/** 403 – the key is valid but may not do this. */
export class PermissionDeniedError extends APIError {
  override name = "PermissionDeniedError";
}

/**
 * 403 with code `feature_disabled` – the feature (for example `desktop` or
 * `metrics_history`) is not enabled for this account. See `wbx.features()`.
 */
export class FeatureDisabledError extends PermissionDeniedError {
  override name = "FeatureDisabledError";
  /** Name of the disabled feature. */
  readonly feature: string | undefined;

  constructor(init: APIErrorInit & { feature?: string | undefined }) {
    super(init);
    this.feature = init.feature;
  }
}

/** 404 – the sandbox, job, batch, file or process does not exist (or is not yours). */
export class NotFoundError extends APIError {
  override name = "NotFoundError";
}

/** 409 – the resource is in a state that does not allow the operation. */
export class ConflictError extends APIError {
  override name = "ConflictError";
}

/**
 * 409 with code `human_in_control` – a person took over the desktop of the sandbox; agent
 * actions are refused until control is handed back (or its time runs out).
 */
export class HumanInControlError extends ConflictError {
  override name = "HumanInControlError";
  /** Until when (Unix ms) the person keeps control at most, when the server sent it. */
  readonly controllerUntil: number | undefined;

  constructor(init: APIErrorInit) {
    super(init);
    const b = init.body;
    const until = typeof b === "object" && b !== null ? b.controller_until : undefined;
    this.controllerUntil = typeof until === "number" ? until : undefined;
  }
}

/**
 * 429 – a limit was reached. `code` tells which one: `quota` (concurrent sandboxes, vCPU or
 * memory of the account), `queue_full` (queued jobs) or `too_many_waiters`. When the server
 * sent `Retry-After`, {@link APIError.retryAfter} holds the number of seconds.
 */
export class RateLimitError extends APIError {
  override name = "RateLimitError";
}

/** 5xx – a server-side error or temporarily missing capacity (503). */
export class InternalServerError extends APIError {
  override name = "InternalServerError";
}

/** The request (or a wait) did not finish within its time limit. */
export class TimeoutError extends WBXError {
  override name = "TimeoutError";
}

/** The API could not be reached (DNS, TCP, TLS or a dropped connection). */
export class ConnectionError extends WBXError {
  override name = "ConnectionError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown by `CommandResult.check()` when a command failed or timed out. */
export class CommandFailedError extends WBXError {
  override name = "CommandFailedError";
  /** Exit code of the command (-1 when unknown). */
  readonly exitCode: number;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** True when the command was killed because it ran longer than its timeout. */
  readonly timedOut: boolean;

  constructor(r: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }) {
    const why = r.timedOut ? "timed out" : `exited with code ${r.exitCode}`;
    const tail = r.stderr.trim().slice(-500);
    super(`command ${why}${tail ? `: ${tail}` : ""}`);
    this.exitCode = r.exitCode;
    this.stdout = r.stdout;
    this.stderr = r.stderr;
    this.timedOut = r.timedOut;
  }
}

/**
 * One action of `sandbox.computer.actions()` failed. The server stops at the failed action;
 * the actions before it were performed. Thrown unless the call passed `throwOnFailure: false`.
 */
export class ComputerActionError extends WBXError {
  override name = "ComputerActionError";
  /** Index of the action that failed (in the list passed to `actions()`). */
  readonly failedIndex: number;
  /** One entry per performed action, the failed one last. */
  readonly results: ComputerActionResultEntry[];

  constructor(message: string, failedIndex: number, results: ComputerActionResultEntry[]) {
    super(message);
    this.failedIndex = failedIndex;
    this.results = results;
  }
}

/**
 * A streamed response sent an event (Server-Sent Events) or a line (NDJSON) longer than the
 * limit (`maxStreamEventSize`, default 16 MiB characters). Reading stops and the connection is closed.
 */
export class StreamLimitError extends WBXError {
  override name = "StreamLimitError";
  /** The limit that was exceeded (characters). */
  readonly limit: number;

  constructor(message: string, limit: number) {
    super(message);
    this.limit = limit;
  }
}

/**
 * A downloaded file did not match the SHA-256 checksum recorded by the server, or the server
 * sent no (or an invalid) checksum to verify against.
 */
export class IntegrityError extends WBXError {
  override name = "IntegrityError";
}

/**
 * Whether an error is a cancellation (an aborted signal's reason).
 * @internal
 */
export function isAbortLike(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/**
 * Builds the typed error for an HTTP error response.
 * @internal
 */
export function errorFromResponse(
  status: number,
  body: APIErrorBody | string | undefined,
  headers: Headers | undefined,
  method: string,
  url: string,
): APIError {
  const obj = typeof body === "object" && body !== null ? body : undefined;
  const code = typeof obj?.code === "string" ? obj.code : undefined;
  let message = typeof obj?.error === "string" && obj.error ? obj.error : "";
  if (!message && typeof body === "string" && body.trim()) message = body.trim().slice(0, 500);
  if (!message) message = `HTTP ${status}`;
  const init: APIErrorInit = {
    status,
    message: `${status} ${message}`,
    code,
    body,
    headers,
    method,
    url,
    retryAfter: parseRetryAfter(headers?.get("retry-after") ?? null),
  };
  switch (status) {
    case 400:
      return new BadRequestError(init);
    case 401:
      return new AuthenticationError(init);
    case 402:
      return new PaymentRequiredError(init);
    case 403:
      if (code === "feature_disabled") {
        return new FeatureDisabledError({ ...init, feature: typeof obj?.feature === "string" ? obj.feature : undefined });
      }
      return new PermissionDeniedError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return code === "human_in_control" ? new HumanInControlError(init) : new ConflictError(init);
    case 429:
      return new RateLimitError(init);
    default:
      return status >= 500 ? new InternalServerError(init) : new APIError(init);
  }
}

/**
 * Parses a `Retry-After` header (delay in seconds or an HTTP date) into seconds.
 * @internal
 */
export function parseRetryAfter(v: string | null, now: number = Date.now()): number | undefined {
  if (v === null) return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, (t - now) / 1000);
}

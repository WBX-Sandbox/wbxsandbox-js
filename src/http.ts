/**
 * HTTP transport: authentication, timeouts, cancellation, retries and error mapping.
 * @module
 */

import {
  AuthenticationError,
  ConnectionError,
  TimeoutError,
  WBXError,
  errorFromResponse,
  type APIError,
  type APIErrorBody,
} from "./errors.js";
import { abortReason, sleep } from "./util.js";

/** Options accepted by every API call. */
export interface RequestOptions {
  /** Cancels the call. The promise rejects with the signal's reason (an `AbortError` by default). */
  signal?: AbortSignal;
  /**
   * Time limit of one HTTP attempt in milliseconds (overrides the client default and the
   * method's own default). For streams it limits the time until the response starts.
   * `0` or `Infinity` = no limit.
   */
  timeoutMs?: number;
  /** Retries for this call (overrides the client's `maxRetries`). Only safe calls are retried. */
  maxRetries?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** Configuration shared by all calls of a client (what the {@link Transport} constructor takes). */
export interface TransportConfig {
  baseURL: string;
  /** API key. Kept in a private field of the transport – never readable from `config`. */
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  fetch: typeof fetch;
  headers: Record<string, string>;
  /** Longest event (SSE) or line (NDJSON) of a streamed response, in characters (default 16 MiB). */
  maxStreamEventSize?: number;
}

/** The settings of a {@link Transport} as it exposes them: everything but the API key. */
export type TransportSettings = Readonly<Omit<TransportConfig, "apiKey" | "maxStreamEventSize">> & {
  readonly maxStreamEventSize: number;
};

/** Default limit of one streamed event or line (characters). */
export const DEFAULT_MAX_STREAM_EVENT_SIZE = 16 * 1024 * 1024;

/** The `util.inspect.custom` symbol of Node.js (via the global registry – no `node:util` import). @internal */
export const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom") as never;

/** Query parameter values; `undefined` values are left out. */
export type Query = Record<string, string | number | boolean | undefined>;

/** @internal */
export interface RequestSpec {
  method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Query | undefined;
  /** JSON body (serialized with JSON.stringify). */
  json?: unknown;
  /** Raw body (files). */
  body?: BodyInit | undefined;
  contentType?: string | undefined;
  /** Headers of this call (the caller's `options.headers` win). */
  headers?: Record<string, string> | undefined;
  /**
   * Whether repeating the request cannot cause a second effect. Defaults: GET, HEAD and
   * DELETE yes; PUT yes when its body can be sent again; POST no (pass true only when the
   * request carries an idempotency key or is idempotent by design).
   */
  idempotent?: boolean | undefined;
  /** Default timeout of this call (used unless `options.timeoutMs` is given). */
  defaultTimeoutMs?: number | undefined;
  /** Whether the call needs the API key (default true). */
  auth?: boolean | undefined;
  options?: RequestOptions | undefined;
}

/** A successful response with its body still unread. @internal */
export interface RawResponse {
  response: Response;
  /** Removes abort listeners and timers; call when the body has been consumed or dropped. */
  release(): void;
  /** Signal that aborts when the caller's signal aborts (for reading a streamed body). */
  signal: AbortSignal;
}

const RETRY_STATUS = new Set([502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Combines the caller's signal with a timeout. @internal */
function linkSignal(user: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => ctrl.abort(abortReason(user!));
  if (user) {
    if (user.aborted) ctrl.abort(abortReason(user));
    else user.addEventListener("abort", onAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new DOMException("The operation timed out", "TimeoutError"));
    }, timeoutMs);
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    release: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      user?.removeEventListener("abort", onAbort);
    },
  };
}

function replayable(body: BodyInit | undefined): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  return false; // ReadableStream, FormData with streams, …
}

/** Exponential backoff with full jitter, capped. @internal */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Builds a URL from the base, a path and query parameters. @internal */
export function buildURL(base: string, path: string, query?: Query): string {
  let url = base.replace(/\/+$/, "") + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  return url;
}

async function readErrorBody(resp: Response): Promise<APIErrorBody | string | undefined> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as APIErrorBody;
  } catch {
    /* not JSON */
  }
  return text;
}

/**
 * Low-level HTTP client of the WBX Sandbox REST API. Every resource of {@link WBX} uses it;
 * use {@link WBX.request} for endpoints the SDK does not wrap yet.
 */
export class Transport {
  /** Settings of the transport. The API key is not part of them. */
  readonly config: TransportSettings;
  readonly #apiKey: string;

  constructor(config: TransportConfig) {
    const { apiKey, maxStreamEventSize, ...rest } = config;
    this.#apiKey = apiKey;
    this.config = { ...rest, headers: { ...rest.headers }, maxStreamEventSize: maxStreamEventSize ?? DEFAULT_MAX_STREAM_EVENT_SIZE };
  }

  /** Whether an API key is configured (the key itself is never exposed). */
  get hasApiKey(): boolean {
    return this.#apiKey !== "";
  }

  /** A description without the API key (and without header values, which may hold secrets too). */
  toJSON(): { baseURL: string; hasApiKey: boolean; timeoutMs: number; maxRetries: number; headers: string[] } {
    return {
      baseURL: this.config.baseURL,
      hasApiKey: this.hasApiKey,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      headers: Object.keys(this.config.headers),
    };
  }

  /** `util.inspect()` / `console.log()` output: the same as {@link toJSON}. @internal */
  [INSPECT](): string {
    return `Transport ${JSON.stringify(this.toJSON())}`;
  }

  /** Sends a request and returns the successful response with its body unread. @internal */
  async send(spec: RequestSpec): Promise<RawResponse> {
    const cfg = this.config;
    const opts = spec.options ?? {};
    const method = spec.method;
    const url = buildURL(cfg.baseURL, spec.path, spec.query);
    const headers: Record<string, string> = {
      Accept: "application/json, */*",
      ...cfg.headers,
      ...spec.headers,
      ...opts.headers,
    };
    if (spec.auth !== false) {
      if (!this.#apiKey) {
        throw new AuthenticationError({
          status: 401,
          message:
            "missing API key – pass { apiKey } to new WBX() or set the WBXSANDBOX_API_KEY environment variable",
          method,
          url,
        });
      }
      headers["X-API-Key"] = this.#apiKey;
    }
    let body: BodyInit | undefined = spec.body;
    if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers["Content-Type"] = "application/json";
    } else if (body !== undefined) {
      headers["Content-Type"] = spec.contentType ?? "application/octet-stream";
    }
    const canReplay = replayable(body);
    const idempotent =
      spec.idempotent ?? (method === "GET" || method === "HEAD" || method === "DELETE" || (method === "PUT" && canReplay));
    const retries = idempotent && canReplay ? Math.max(0, opts.maxRetries ?? cfg.maxRetries) : 0;
    const timeoutMs = opts.timeoutMs ?? spec.defaultTimeoutMs ?? cfg.timeoutMs;

    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      const link = linkSignal(opts.signal, timeoutMs);
      let resp: Response;
      try {
        const init: RequestInit & { duplex?: "half" } = { method, headers, signal: link.signal };
        if (body !== undefined) init.body = body;
        if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) init.duplex = "half";
        resp = await cfg.fetch(url, init);
      } catch (e) {
        link.release();
        if (opts.signal?.aborted) throw abortReason(opts.signal);
        const err = link.timedOut()
          ? new TimeoutError(`${method} ${spec.path} timed out after ${timeoutMs} ms`)
          : new ConnectionError(`cannot reach ${cfg.baseURL}: ${errMessage(e)}`, { cause: e });
        if (attempt < retries) {
          await sleep(backoffMs(attempt), opts.signal);
          continue;
        }
        throw err;
      }
      if (resp.ok) {
        // the timeout covers the start of the response; reading the body is up to the caller
        return {
          response: resp,
          signal: link.signal,
          release: link.release,
        };
      }
      let errBody: APIErrorBody | string | undefined;
      try {
        errBody = await readErrorBody(resp);
      } finally {
        link.release();
      }
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      const err = errorFromResponse(resp.status, errBody, resp.headers, method, url);
      const delay = this.retryDelay(err, attempt, retries);
      if (delay !== undefined) {
        await sleep(delay, opts.signal);
        continue;
      }
      throw err;
    }
  }

  /** Delay before the next attempt, or undefined when the error must not be retried. */
  private retryDelay(err: APIError, attempt: number, retries: number): number | undefined {
    if (attempt >= retries) return undefined;
    const retryAfterMs = err.retryAfter !== undefined ? err.retryAfter * 1000 : undefined;
    let retry = false;
    if (RETRY_STATUS.has(err.status)) retry = true;
    // 429 without Retry-After is a hard limit (account quota, full queue) – retrying does not help
    if (err.status === 429 && (retryAfterMs !== undefined || err.code === "too_many_waiters")) retry = true;
    if (!retry) return undefined;
    if (retryAfterMs !== undefined) {
      if (retryAfterMs > this.config.maxRetryDelayMs) return undefined;
      return retryAfterMs;
    }
    return backoffMs(attempt);
  }

  /**
   * Sends a request and reads the body with the same timeout: JSON when the response is JSON,
   * otherwise the bytes; `undefined` for an empty body (204).
   * @internal
   */
  async json<T>(spec: RequestSpec): Promise<{ data: T; headers: Headers; status: number }> {
    const raw = await this.send(spec);
    try {
      const text = await raw.response.text();
      let data: unknown = undefined;
      if (text) {
        const ct = raw.response.headers.get("content-type") ?? "";
        if (ct.includes("json") || /^\s*[[{"]/.test(text)) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            if (ct.includes("json")) throw new WBXError(`invalid JSON in the response of ${spec.method} ${spec.path}: ${errMessage(e)}`);
            data = text;
          }
        } else {
          data = text;
        }
      }
      return { data: data as T, headers: raw.response.headers, status: raw.response.status };
    } catch (e) {
      throw this.readError(e, raw, spec);
    } finally {
      raw.release();
    }
  }

  /** Sends a request and reads the whole body as bytes. @internal */
  async bytes(spec: RequestSpec): Promise<{ data: Uint8Array; headers: Headers }> {
    const raw = await this.send(spec);
    try {
      const buf = await raw.response.arrayBuffer();
      return { data: new Uint8Array(buf), headers: raw.response.headers };
    } catch (e) {
      throw this.readError(e, raw, spec);
    } finally {
      raw.release();
    }
  }

  /** Sends a request and returns the response body as a stream (no timeout once it started). @internal */
  async stream(spec: RequestSpec): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; release: () => void }> {
    const raw = await this.send(spec);
    raw.release(); // stops the start timeout; the caller's signal still aborts the fetch body
    const userSignal = spec.options?.signal;
    if (!raw.response.body) {
      return { body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), headers: raw.response.headers, release: () => {} };
    }
    // reading a fetch body is aborted by the fetch's own signal, which we just detached from
    // the caller's signal – re-attach: cancel the body when the caller aborts
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const src = raw.response.body;
    const onAbort = () => {
      const reason = userSignal ? abortReason(userSignal) : undefined;
      try {
        ctrl?.error(reason);
      } catch {
        /* already closed */
      }
      void (reader ?? src).cancel(reason).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        reader = src.getReader();
        if (userSignal?.aborted) onAbort();
        else userSignal?.addEventListener("abort", onAbort, { once: true });
      },
      async pull(c) {
        try {
          const r = await reader!.read();
          if (userSignal?.aborted) return; // onAbort already errored the stream
          if (r.done) {
            userSignal?.removeEventListener("abort", onAbort);
            c.close();
          } else {
            c.enqueue(r.value);
          }
        } catch (e) {
          userSignal?.removeEventListener("abort", onAbort);
          if (userSignal?.aborted) return;
          c.error(new ConnectionError(`the response stream of ${spec.method} ${spec.path} broke: ${errMessage(e)}`, { cause: e }));
        }
      },
      async cancel(reason) {
        userSignal?.removeEventListener("abort", onAbort);
        await reader?.cancel(reason).catch(() => {});
      },
    });
    return { body, headers: raw.response.headers, release: () => userSignal?.removeEventListener("abort", onAbort) };
  }

  private readError(e: unknown, raw: RawResponse, spec: RequestSpec): unknown {
    const user = spec.options?.signal;
    if (user?.aborted) return abortReason(user);
    if (e instanceof WBXError) return e;
    if (raw.signal.aborted) {
      return new TimeoutError(`${spec.method} ${spec.path}: the response did not arrive in time`);
    }
    return new ConnectionError(`reading the response of ${spec.method} ${spec.path} failed: ${errMessage(e)}`, { cause: e });
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message ? `${e.message} (${cause.message})` : e.message;
  }
  return String(e);
}

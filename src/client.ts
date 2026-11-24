/**
 * The {@link WBX} client.
 * @module
 */

import { BudgetResource, Compute, Templates, Webhooks } from "./account.js";
import { INSPECT, Transport, type Query, type RequestOptions } from "./http.js";
import { Batches, Jobs } from "./jobs.js";
import { Sandboxes } from "./sandbox.js";
import { Snapshots } from "./snapshots.js";
import type { Features, ReceiptKey, Runtimes } from "./types.js";
import { readEnv } from "./util.js";

/** Default API address. */
export const DEFAULT_BASE_URL = "https://sandbox.wbx.cz";

/** Options of the {@link WBX} constructor. */
export interface ClientOptions {
  /** API key. Default: the `WBXSANDBOX_API_KEY` environment variable. */
  apiKey?: string;
  /** API address. Default: `WBXSANDBOX_URL`, else `https://sandbox.wbx.cz`. */
  baseURL?: string;
  /** Time limit of one HTTP attempt in ms (default 60 000). Methods that wait longer by design set their own. */
  timeoutMs?: number;
  /** How many times safe requests are retried after temporary errors (default 2). */
  maxRetries?: number;
  /** Longest `Retry-After` the client waits for before giving up instead (ms, default 60 000). */
  maxRetryDelayMs?: number;
  /** A `fetch` implementation (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /**
   * Longest single event (Server-Sent Events) or line (NDJSON) of a streamed response, in
   * characters (default 16 MiB). A longer one stops the stream with `StreamLimitError`.
   */
  maxStreamEventSize?: number;
  /**
   * Allow a plain `http://` API address other than localhost. Off by default: over http the
   * API key would travel unencrypted.
   */
  allowInsecure?: boolean;
}

/** Address of the API: https, or http only for localhost (or with `allowInsecure`). @internal */
export function checkBaseURL(raw: string, allowInsecure = false): string {
  const base = raw.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new TypeError(`invalid API address "${base}"`);
  }
  if (u.protocol === "https:") return base;
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol === "http:" && (local || allowInsecure)) return base;
  throw new TypeError(
    `refusing to use "${base}": the API key would be sent unencrypted – use an https:// address (or pass allowInsecure: true for a trusted network)`,
  );
}

/**
 * Client of the WBX Sandbox API.
 *
 * ```ts
 * import { WBX } from "wbxsandbox";
 *
 * const wbx = new WBX({ apiKey: process.env.WBXSANDBOX_API_KEY });
 * const sandbox = await wbx.sandboxes.create({ template: "base", name: "my-project" });
 * const r = await sandbox.commands.run("python3 --version");
 * console.log(r.stdout);
 * await sandbox.sleep();
 * ```
 */
export class WBX {
  /** Sandboxes: create, get, list, kill. */
  readonly sandboxes: Sandboxes;
  /** Snapshots of sandbox disks (feature `snapshots`): list, get, delete. */
  readonly snapshots: Snapshots;
  /** Background jobs. */
  readonly jobs: Jobs;
  /** Batches of jobs. */
  readonly batches: Batches;
  /** Templates. */
  readonly templates: Templates;
  /** Spending limits and spend. */
  readonly budget: BudgetResource;
  /** Compute classes. */
  readonly compute: Compute;
  /** Webhook secret. */
  readonly webhooks: Webhooks;
  /** The HTTP transport (for advanced use). */
  readonly transport: Transport;

  constructor(options: ClientOptions = {}) {
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (typeof f !== "function") {
      throw new TypeError("no fetch implementation found – use Node.js 20 or newer, or pass { fetch }");
    }
    this.transport = new Transport({
      baseURL: checkBaseURL(options.baseURL ?? readEnv("WBXSANDBOX_URL") ?? DEFAULT_BASE_URL, options.allowInsecure),
      apiKey: options.apiKey ?? readEnv("WBXSANDBOX_API_KEY") ?? "",
      timeoutMs: options.timeoutMs ?? 60_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 60_000,
      fetch: options.fetch ? options.fetch : (input, init) => f(input, init), // keep `this` of the global fetch
      headers: { ...options.headers },
      maxStreamEventSize: options.maxStreamEventSize,
    });
    this.sandboxes = new Sandboxes(this.transport);
    this.snapshots = new Snapshots(this.transport);
    this.jobs = new Jobs(this.transport);
    this.batches = new Batches(this.transport);
    this.templates = new Templates(this.transport);
    this.budget = new BudgetResource(this.transport);
    this.compute = new Compute(this.transport);
    this.webhooks = new Webhooks(this.transport);
  }

  /** A description without the API key – safe to log. */
  toJSON(): { baseURL: string; hasApiKey: boolean } {
    return { baseURL: this.baseURL, hasApiKey: this.transport.hasApiKey };
  }

  /** `util.inspect()` / `console.log()` output without the API key. @internal */
  [INSPECT](): string {
    return `WBX ${JSON.stringify(this.toJSON())}`;
  }

  /** The API address in use. */
  get baseURL(): string {
    return this.transport.config.baseURL;
  }

  /**
   * Features enabled for your account (`metrics_history`, `desktop`, …). The server decides
   * in the end: a disabled feature answers with {@link FeatureDisabledError}.
   */
  async features(options?: RequestOptions): Promise<Features> {
    return (await this.transport.json<{ features: Features }>({ method: "GET", path: "/v1/features", options })).data.features ?? {};
  }

  /** Job runtimes with their isolation level and capabilities. */
  async runtimes(options?: RequestOptions): Promise<Runtimes> {
    return (await this.transport.json<Runtimes>({ method: "GET", path: "/v1/runtimes", options })).data;
  }

  /**
   * Public keys that sign execution receipts (no API key needed). Pin the key you trust
   * instead of fetching it each time from the server whose receipts you check.
   */
  async receiptKeys(options?: RequestOptions): Promise<ReceiptKey[]> {
    return (await this.transport.json<{ keys: ReceiptKey[] }>({ method: "GET", path: "/v1/receipt-keys", auth: false, options })).data.keys ?? [];
  }

  /**
   * Calls any endpoint with the client's authentication, timeouts, retries and error
   * mapping – for API features this SDK does not wrap yet. Returns the parsed JSON (or text).
   *
   * Only GET, HEAD, DELETE and PUT are retried, unless you pass `idempotent: true`.
   */
  async request<T = unknown>(
    method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE",
    path: string,
    params: { query?: Query; body?: unknown; idempotent?: boolean } = {},
    options?: RequestOptions,
  ): Promise<T> {
    const { data } = await this.transport.json<T>({
      method,
      path: path.startsWith("/") ? path : `/${path}`,
      query: params.query,
      json: params.body,
      idempotent: params.idempotent,
      options,
    });
    return data;
  }
}

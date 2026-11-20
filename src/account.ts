/**
 * Account-level resources: templates, budget, compute classes, webhooks.
 * @module
 */

import type { RequestOptions, Transport } from "./http.js";
import type { Budget, ComputePreferences, Template } from "./types.js";
import { compact, utf8 } from "./util.js";

/** `wbx.templates` */
export class Templates {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /** Templates you can create sandboxes from (name, default size, …). */
  async list(options?: RequestOptions): Promise<Template[]> {
    return (await this.t.json<Template[]>({ method: "GET", path: "/v1/templates", options })).data ?? [];
  }
}

/** `wbx.budget` – spending limits for jobs and batches, in your account's billing currency. */
export class BudgetResource {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /** Limits, spend this month and today, amounts reserved by running jobs; `days: true` adds spend per day. */
  async get(options: RequestOptions & { days?: boolean } = {}): Promise<Budget> {
    const { days, ...rest } = options;
    return (await this.t.json<Budget>({ method: "GET", path: "/v1/budget", query: { days: days ? 1 : undefined }, options: rest })).data;
  }

  /**
   * Sets your own monthly / daily limit (`""` or `0` removes it) and the alert threshold in
   * percent. Limits set by the operator still apply. Keys of connected apps may not do this.
   */
  async update(params: { monthly?: string | number; daily?: string | number; alertPct?: number }, options?: RequestOptions): Promise<Budget> {
    const json = compact({
      monthly_limit: params.monthly === undefined ? undefined : String(params.monthly),
      daily_limit: params.daily === undefined ? undefined : String(params.daily),
      alert_pct: params.alertPct,
    });
    return (await this.t.json<Budget>({ method: "PUT", path: "/v1/budget", json, options })).data;
  }
}

/** `wbx.compute` – compute classes. */
export class Compute {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /** Classes available to your account (relative price, availability) and your default class. */
  async preferences(options?: RequestOptions): Promise<ComputePreferences> {
    return (await this.t.json<ComputePreferences>({ method: "GET", path: "/v1/compute/preferences", options })).data;
  }

  /**
   * Sets the default class for new sandboxes and jobs (`""` = the global default). Running
   * sandboxes and accepted jobs keep their class and price.
   */
  async setDefaultClass(name: string, options?: RequestOptions): Promise<ComputePreferences> {
    return (await this.t.json<ComputePreferences>({ method: "PUT", path: "/v1/compute/preferences", json: { default_compute_class: name }, options })).data;
  }
}

/** `wbx.webhooks` */
export class Webhooks {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /** The secret that signs your webhooks (`X-WBX-Signature`). */
  async secret(options?: RequestOptions): Promise<string> {
    return (await this.t.json<{ secret: string }>({ method: "GET", path: "/v1/webhooks/secret", options })).data.secret;
  }

  /** Issues a new webhook secret (the old one stops working). */
  async rotateSecret(options?: RequestOptions): Promise<string> {
    return (await this.t.json<{ secret: string }>({ method: "POST", path: "/v1/webhooks/secret/rotate", json: {}, options })).data.secret;
  }
}

/**
 * Checks the `X-WBX-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256>`) of a webhook
 * you received. `body` must be the raw request body exactly as received.
 *
 * ```ts
 * const ok = await verifyWebhook(secret, rawBody, req.headers["x-wbx-signature"]);
 * ```
 */
export async function verifyWebhook(
  secret: string,
  body: string | Uint8Array,
  signature: string | null | undefined,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!signature) return false;
  const parts = new Map<string, string>();
  for (const p of signature.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1) return false;
  const now = (options.now ?? Date.now()) / 1000;
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false;
  const key = await crypto.subtle.importKey("raw", utf8(secret) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = typeof body === "string" ? utf8(body) : body;
  const msg = new Uint8Array(utf8(`${t}.`).length + raw.length);
  msg.set(utf8(`${t}.`), 0);
  msg.set(raw, utf8(`${t}.`).length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const hex = Array.from(mac, (x) => x.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, v1.toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

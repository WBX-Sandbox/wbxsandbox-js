/**
 * Published apps (feature `apps`, paid plans): an app from a sandbox at a permanent public
 * address without a token, optionally on your own domain.
 * @module
 */

import { NotFoundError } from "./errors.js";
import type { RequestOptions, Transport } from "./http.js";
import type { AppDomainInfo, AppInfo } from "./types.js";

/** Options of `wbx.apps.publish()` and `sandbox.publish()`. */
export interface AppPublishParams {
  /** 3–40 lowercase letters, digits and dashes – the address becomes `https://<name>.<zone>`. */
  name: string;
  /** Port the app listens on inside the sandbox (listen on 0.0.0.0). */
  port: number;
  /** Runs in the background when nothing listens on the port (after a wake-up without memory, or a crash). */
  startCommand?: string;
  /** Working folder of the start command. */
  cwd?: string;
}

/**
 * A published app. Obtain one from `sandbox.publish()`, `wbx.apps.publish()` or `wbx.apps.list()`.
 * The sandbox is kept while published, sleeps without visitors and wakes on the next visit.
 */
export class App {
  /** App name. */
  readonly name: string;
  /** The API record (snake_case fields). */
  info: AppInfo;
  private readonly t: Transport;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(t: Transport, info: AppInfo) {
    this.t = t;
    this.name = info.name;
    this.info = info;
  }

  /** Public address, e.g. `https://dog-club.box.wbxbox.net/`. */
  get url(): string {
    return this.info.url ?? "";
  }

  /** Sandbox the app runs in. */
  get sandboxId(): string {
    return this.info.sandbox_id;
  }

  /** Port of the app in the sandbox. */
  get port(): number {
    return this.info.port;
  }

  /** Your own domains with their state and, until active, the DNS records to create. */
  get domains(): AppDomainInfo[] {
    return this.info.domains ?? [];
  }

  /** Reason when the operator turned the app off. */
  get disabled(): string | undefined {
    return this.info.disabled || undefined;
  }

  /** Adds your own domain; the answer has `state` and `dns` (CNAME for a subdomain, A/AAAA + TXT for a root domain). */
  async addDomain(domain: string, options?: RequestOptions): Promise<AppDomainInfo> {
    const d = await new Apps(this.t).addDomain(this.name, domain, options);
    this.info = { ...this.info, domains: [...this.domains.filter((x) => x.domain !== d.domain), d] };
    return d;
  }

  /** Removes one of the app's domains. No error when it is already gone. */
  async removeDomain(domain: string, options?: RequestOptions): Promise<void> {
    await new Apps(this.t).removeDomain(this.name, domain, options);
    this.info = { ...this.info, domains: this.domains.filter((x) => x.domain !== domain.toLowerCase()) };
  }

  /** Removes the public address and its domains; the sandbox stays. No error when already gone. */
  async unpublish(options?: RequestOptions): Promise<void> {
    await new Apps(this.t).unpublish(this.name, options);
  }

  /** @internal */
  toJSON(): AppInfo {
    return this.info;
  }
}

/** `wbx.apps` */
export class Apps {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /**
   * Publishes port `port` of sandbox `sandboxId` as `name` (the same name again changes the app).
   * `FeatureDisabledError` (403) without a paid plan; 409 when the name is taken or a limit is reached.
   */
  async publish(sandboxId: string, params: AppPublishParams, options?: RequestOptions): Promise<App> {
    const body: Record<string, unknown> = { sandbox_id: sandboxId, port: Math.floor(params.port), name: params.name };
    if (params.startCommand) body.start_command = params.startCommand;
    if (params.cwd) body.cwd = params.cwd;
    const { data } = await this.t.json<AppInfo>({ method: "POST", path: "/v1/apps", json: body, options });
    return new App(this.t, data);
  }

  /** Your published apps. */
  async list(options?: RequestOptions): Promise<App[]> {
    const { data } = await this.t.json<AppInfo[] | { apps?: AppInfo[] }>({ method: "GET", path: "/v1/apps", options });
    const rows = Array.isArray(data) ? data : (data?.apps ?? []);
    return rows.map((d) => new App(this.t, d));
  }

  /** One of your apps by name (`NotFoundError` when there is none). */
  async get(name: string, options?: RequestOptions): Promise<App> {
    const app = (await this.list(options)).find((a) => a.name === name);
    if (!app) throw new NotFoundError({ status: 404, message: `app ${name} not found`, code: "not_found" });
    return app;
  }

  /** Unpublishes an app by name. No error when it is already gone. */
  async unpublish(name: string, options?: RequestOptions): Promise<void> {
    try {
      await this.t.json({ method: "DELETE", path: `/v1/apps/${encodeURIComponent(name)}`, options });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  /** Adds your own domain to an app. */
  async addDomain(name: string, domain: string, options?: RequestOptions): Promise<AppDomainInfo> {
    return (await this.t.json<AppDomainInfo>({ method: "POST", path: `/v1/apps/${encodeURIComponent(name)}/domains`, json: { domain }, options })).data;
  }

  /** Removes a domain from an app. No error when it is already gone. */
  async removeDomain(name: string, domain: string, options?: RequestOptions): Promise<void> {
    try {
      await this.t.json({ method: "DELETE", path: `/v1/apps/${encodeURIComponent(name)}/domains/${encodeURIComponent(domain.toLowerCase())}`, options });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
}

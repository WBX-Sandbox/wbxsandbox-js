/**
 * Snapshots of sandbox disks (feature `snapshots`).
 * @module
 */

import { NotFoundError } from "./errors.js";
import type { RequestOptions, Transport } from "./http.js";
import { Sandboxes, type Sandbox, type SandboxCreateParams } from "./sandbox.js";
import type { SnapshotInfo } from "./types.js";

/**
 * A saved copy of a sandbox disk – files only (no memory, no running programs, no env).
 * Obtain one from `sandbox.snapshot()`, `wbx.snapshots.list()` or `wbx.snapshots.get(id)`.
 * It stays until you delete it (deleting the source sandbox does not delete it); its size is
 * billed as storage, like a sleeping sandbox.
 */
export class Snapshot {
  /** Snapshot ID (`snap_…`). */
  readonly id: string;
  /** The API record (snake_case fields). */
  info: SnapshotInfo;
  private readonly t: Transport;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(t: Transport, info: SnapshotInfo) {
    this.t = t;
    this.id = info.id;
    this.info = info;
  }

  /** Name given when the snapshot was taken. */
  get name(): string | undefined {
    return this.info.name || undefined;
  }

  /** ID of the sandbox the snapshot was taken from. */
  get sourceSandbox(): string | undefined {
    return this.info.source_sandbox || undefined;
  }

  /** Template of the source sandbox (a sandbox from this snapshot gets it too). */
  get template(): string {
    return this.info.template;
  }

  /** Space the snapshot takes in bytes (billed as storage). */
  get sizeBytes(): number {
    return this.info.size_bytes ?? 0;
  }

  /** When the snapshot was taken. */
  get createdAt(): Date | undefined {
    return this.info.created_at ? new Date(this.info.created_at) : undefined;
  }

  /** Starts a new sandbox from this snapshot (same options as `wbx.sandboxes.create()`). */
  createSandbox(params: Omit<SandboxCreateParams, "fromSnapshot" | "template"> = {}, options?: RequestOptions): Promise<Sandbox> {
    return new Sandboxes(this.t).create({ ...params, fromSnapshot: this.id }, options);
  }

  /** Deletes the snapshot. No error when it is already gone; sandboxes created from it are not affected. */
  async delete(options?: RequestOptions): Promise<void> {
    await new Snapshots(this.t).delete(this.id, options);
  }

  /** @internal */
  toJSON(): SnapshotInfo {
    return this.info;
  }
}

/** `wbx.snapshots` */
export class Snapshots {
  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(private readonly t: Transport) {}

  /** Your snapshots (all at once, no pages). */
  async list(options?: RequestOptions): Promise<Snapshot[]> {
    const { data } = await this.t.json<SnapshotInfo[] | { snapshots?: SnapshotInfo[] }>({ method: "GET", path: "/v1/snapshots", options });
    const rows = Array.isArray(data) ? data : (data?.snapshots ?? []);
    return rows.map((d) => new Snapshot(this.t, d));
  }

  /** One snapshot by its ID (`NotFoundError` when it does not exist or is not yours). */
  async get(id: string, options?: RequestOptions): Promise<Snapshot> {
    const { data } = await this.t.json<SnapshotInfo>({ method: "GET", path: `/v1/snapshots/${encodeURIComponent(id)}`, options });
    return new Snapshot(this.t, data);
  }

  /** Deletes a snapshot by ID. No error when it is already gone. */
  async delete(id: string, options?: RequestOptions): Promise<void> {
    try {
      await this.t.json({ method: "DELETE", path: `/v1/snapshots/${encodeURIComponent(id)}`, options });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
}

/*
 * Small runtime-neutral helpers (no Node.js built-ins, no Buffer). Not part of the public API.
 */

/** Reads an environment variable where the runtime exposes `process.env` (Node.js, Bun, Deno). */
export function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  try {
    const v = proc?.env?.[name];
    return v === undefined || v === "" ? undefined : v;
  } catch {
    return undefined; // Deno without --allow-env
  }
}

/** Waits `ms` milliseconds; rejects with the abort reason when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The reason of an aborted signal (a DOMException "AbortError" when none was given). */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Throws the abort reason when the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** A random UUID v4 (Web Crypto). */
export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/** Encodes bytes as standard base64 (with padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Decodes standard or URL-safe base64 (padding and whitespace optional). */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    const v = ch < 256 ? B64_LOOKUP[ch]! : -1;
    if (v < 0) throw new TypeError("invalid base64 data");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (clean.length % 4 === 1) throw new TypeError("invalid base64 data");
  return out.subarray(0, o);
}

/** Lower-case hex SHA-256 of the bytes (Web Crypto). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Text → UTF-8 bytes. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Percent-encodes every segment of a slash-separated path. */
export function encodePath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** Converts a Date, a millisecond timestamp or an RFC 3339 string to an RFC 3339 string. */
export function toRFC3339(v: Date | number | string): string {
  if (typeof v === "string") return v;
  return new Date(v).toISOString();
}

/** Converts a Date or a millisecond timestamp to milliseconds since the epoch. */
export function toUnixMs(v: Date | number): number {
  return typeof v === "number" ? Math.floor(v) : v.getTime();
}

/** Drops keys whose value is `undefined`. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

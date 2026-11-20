/**
 * Parsers for the streaming formats of the API: NDJSON (command output, processes, file
 * watching) and Server-Sent Events (metrics).
 * @module
 */

import { StreamLimitError } from "./errors.js";

/** Default limit of one event or line: 16 MiB characters. */
const DEFAULT_MAX = 16 * 1024 * 1024;

/** Options of {@link SSEParser}. */
export interface SSEParserOptions {
  /**
   * Longest event in characters – its data lines together, and any single line (default
   * 16 MiB). A longer one throws {@link StreamLimitError} instead of buffering without bound.
   */
  maxEventSize?: number;
}

/** Options of {@link readNDJSON}. */
export interface NDJSONOptions {
  /** Longest line in characters (default 16 MiB). A longer one throws {@link StreamLimitError}. */
  maxLineSize?: number;
}

function limitOf(v: number | undefined): number {
  return v !== undefined && v > 0 ? v : DEFAULT_MAX;
}

/** One Server-Sent Event. */
export interface SSEEvent {
  /** Event type (`message` when the server sent no `event:` field). */
  event: string;
  /** The data lines joined with `\n`. */
  data: string;
  /** The last event ID (`id:` field), if any. */
  id?: string;
  /** Reconnection time in milliseconds (`retry:` field), if sent with this event. */
  retry?: number;
}

/**
 * Incremental Server-Sent Events parser (WHATWG HTML "event stream" rules): accepts text in
 * arbitrary chunks, handles `\n`, `\r\n` and `\r` line ends (also split between chunks),
 * multi-line `data:`, comments (`:` lines) and a leading BOM. An event or line longer than
 * `maxEventSize` throws {@link StreamLimitError}.
 */
export class SSEParser {
  private buf = "";
  /** Characters at the start of `buf` already known to hold no line end. */
  private scanned = 0;
  private skipLF = false;
  private started = false;
  private event = "";
  private data: string[] = [];
  private dataSize = 0;
  private hasData = false;
  private id: string | undefined;
  private retry: number | undefined;
  /** Number of comment lines seen (keep-alive pings such as `: ping`). */
  comments = 0;
  /** Longest event or line in characters. */
  readonly maxEventSize: number;

  constructor(options: SSEParserOptions = {}) {
    this.maxEventSize = limitOf(options.maxEventSize);
  }

  /** Feeds a chunk of text; returns the events completed by it. */
  push(chunk: string): SSEEvent[] {
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (this.skipLF && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.skipLF = false;
    this.buf += chunk;
    const out: SSEEvent[] = [];
    let start = 0;
    for (let i = this.scanned; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      if (i - start > this.maxEventSize) this.tooLong();
      const line = this.buf.slice(start, i);
      if (c === 13) {
        if (i + 1 < this.buf.length) {
          if (this.buf.charCodeAt(i + 1) === 10) i++;
        } else {
          this.skipLF = true; // "\r" at the end of the chunk – a following "\n" belongs to it
        }
      }
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buf = this.buf.slice(start);
    this.scanned = this.buf.length;
    if (this.buf.length > this.maxEventSize || this.dataSize + this.buf.length > this.maxEventSize) this.tooLong();
    return out;
  }

  private tooLong(): never {
    this.reset();
    throw new StreamLimitError(`a Server-Sent Event is longer than ${this.maxEventSize} characters – stopped reading the stream`, this.maxEventSize);
  }

  private reset(): void {
    this.buf = "";
    this.scanned = 0;
    this.data = [];
    this.dataSize = 0;
    this.hasData = false;
    this.event = "";
  }

  /** Ends the stream. An event without its terminating blank line is discarded (per spec). */
  end(): SSEEvent[] {
    this.reset();
    return [];
  }

  private line(line: string): SSEEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) {
      this.comments++;
      return undefined;
    }
    const colon = line.indexOf(":");
    let field = line;
    let value = "";
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.dataSize += value.length + (this.hasData ? 1 : 0);
        if (this.dataSize > this.maxEventSize) this.tooLong();
        this.data.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
    return undefined;
  }

  private dispatch(): SSEEvent | undefined {
    const retry = this.retry;
    this.retry = undefined;
    if (!this.hasData) {
      this.event = "";
      return undefined;
    }
    const ev: SSEEvent = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) ev.id = this.id;
    if (retry !== undefined) ev.retry = retry;
    this.event = "";
    this.data = [];
    this.dataSize = 0;
    this.hasData = false;
    return ev;
  }
}

/**
 * Reads a byte stream chunk by chunk. Stops early (and cancels the stream, closing the
 * connection) when the consumer breaks out of the loop.
 * @internal
 */
export async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      if (r.value && r.value.length > 0) yield r.value;
    }
  } finally {
    if (!done) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    reader.releaseLock();
  }
}

/** Decodes a byte stream into UTF-8 text chunks (multi-byte characters split between chunks are kept intact). */
export async function* readText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  for await (const chunk of readChunks(body)) {
    const s = dec.decode(chunk, { stream: true });
    if (s) yield s;
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

/**
 * Parses a newline-delimited JSON stream into objects (empty lines are skipped). A line longer
 * than `maxLineSize` throws {@link StreamLimitError} and closes the stream.
 */
export async function* readNDJSON<T = unknown>(body: ReadableStream<Uint8Array>, options: NDJSONOptions = {}): AsyncGenerator<T> {
  const max = limitOf(options.maxLineSize);
  const tooLong = () =>
    new StreamLimitError(`an NDJSON line is longer than ${max} characters – stopped reading the stream`, max);
  let buf = "";
  for await (const s of readText(body)) {
    let from = buf.length; // the old part of buf holds no line end
    buf += s;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", from)) >= 0) {
      if (nl - start > max) throw tooLong();
      const line = buf.slice(start, nl).trim();
      start = from = nl + 1;
      if (line) yield JSON.parse(line) as T;
    }
    if (start > 0) buf = buf.slice(start);
    if (buf.length > max) throw tooLong();
  }
  const last = buf.trim();
  if (last) yield JSON.parse(last) as T;
}

/** Parses a Server-Sent Events stream (the parser's `maxEventSize` limits each event). */
export async function* readSSE(body: ReadableStream<Uint8Array>, parser: SSEParser = new SSEParser()): AsyncGenerator<SSEEvent> {
  for await (const s of readText(body)) {
    for (const ev of parser.push(s)) yield ev;
  }
  for (const ev of parser.end()) yield ev;
}

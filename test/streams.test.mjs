// Stream parsers: SSE and NDJSON, independent of the network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SSEParser, StreamLimitError, readNDJSON, readSSE } from "../dist/index.js";
import { base64ToBytes, bytesToBase64 } from "../dist/util.js";

function streamOf(parts) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(typeof p === "string" ? enc.encode(p) : p);
      c.close();
    },
  });
}

async function collect(it) {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}

test("SSE: events split at every possible place give the same result", () => {
  const text =
    ": connected\n\nevent: sample\ndata: {\"t\":1}\n\n: ping\n\nevent: sample\r\ndata: {\"t\":2}\r\n\r\nevent: end\ndata: {}\n\n";
  const whole = new SSEParser().push(text);
  assert.deepEqual(
    whole.map((e) => [e.event, e.data]),
    [
      ["sample", '{"t":1}'],
      ["sample", '{"t":2}'],
      ["end", "{}"],
    ],
  );
  for (let i = 1; i < text.length; i++) {
    const p = new SSEParser();
    const got = [...p.push(text.slice(0, i)), ...p.push(text.slice(i))];
    assert.deepEqual(got, whole, `split at ${i}`);
    assert.equal(p.comments, 2);
  }
  // one character at a time
  const p = new SSEParser();
  const got = [];
  for (const ch of text) got.push(...p.push(ch));
  assert.deepEqual(got, whole);
});

test("SSE: multi-line data, CR-only line ends, id/retry, BOM, missing space, unknown fields", () => {
  const p = new SSEParser();
  const evs = p.push("﻿id: 7\rretry: 1500\rdata: line 1\rdata:line 2\rdata\rfoo: bar\r\r");
  assert.deepEqual(evs, [{ event: "message", data: "line 1\nline 2\n", id: "7", retry: 1500 }]);
  // an event without data is not dispatched; event name resets
  assert.deepEqual(p.push("event: x\n\ndata: y\n\n"), [{ event: "message", data: "y", id: "7" }]);
  // an unterminated event at the end of the stream is dropped
  assert.deepEqual(p.push("data: partial"), []);
  assert.deepEqual(p.end(), []);
});

test("SSE over a byte stream with a multi-byte character split between chunks", async () => {
  const bytes = new TextEncoder().encode('event: sample\ndata: {"msg":"příliš žluťoučký"}\n\n');
  const cut = bytes.indexOf(0xc5) + 1; // inside "ř"
  const evs = await collect(readSSE(streamOf([bytes.slice(0, cut), bytes.slice(cut)])));
  assert.equal(JSON.parse(evs[0].data).msg, "příliš žluťoučký");
});

test("NDJSON: lines split across chunks, empty lines, last line without newline", async () => {
  const items = await collect(readNDJSON(streamOf(['{"type":"st', 'art","pid":1}\n\n{"type":"stdout","data":"a\\n"}\n{"type":"exit","exit_code":0}'])));
  assert.deepEqual(items, [
    { type: "start", pid: 1 },
    { type: "stdout", data: "a\n" },
    { type: "exit", exit_code: 0 },
  ]);
});

test("NDJSON: breaking out of the loop cancels the stream", async () => {
  let cancelled = false;
  const s = new ReadableStream({
    pull(c) {
      c.enqueue(new TextEncoder().encode('{"n":1}\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const x of readNDJSON(s)) {
    assert.equal(x.n, 1);
    break;
  }
  assert.ok(cancelled);
});

test("base64 round trip without Buffer", () => {
  for (let n = 0; n < 70; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    const s = bytesToBase64(b);
    assert.equal(s, Buffer.from(b).toString("base64"));
    assert.deepEqual(base64ToBytes(s), b);
  }
  assert.deepEqual(base64ToBytes("aGk"), new TextEncoder().encode("hi")); // no padding
  assert.deepEqual(base64ToBytes("-_8"), new Uint8Array([0xfb, 0xff])); // URL-safe
  assert.throws(() => base64ToBytes("a$b="), TypeError);
});

test("SSE: an event or line over maxEventSize throws StreamLimitError (default 16 MiB)", () => {
  assert.equal(new SSEParser().maxEventSize, 16 * 1024 * 1024);
  // one line that never ends, fed in chunks
  const p = new SSEParser({ maxEventSize: 100 });
  assert.deepEqual(p.push("data: " + "a".repeat(60)), []);
  assert.throws(() => p.push("a".repeat(60)), (e) => e instanceof StreamLimitError && e.limit === 100);
  // many short data lines of one event
  const q = new SSEParser({ maxEventSize: 100 });
  assert.throws(() => {
    for (let i = 0; i < 20; i++) q.push("data: 0123456789\n");
  }, StreamLimitError);
  // events within the limit pass, also after many of them
  const r = new SSEParser({ maxEventSize: 100 });
  for (let i = 0; i < 50; i++) assert.deepEqual(r.push(`data: ${"x".repeat(80)}\n\n`), [{ event: "message", data: "x".repeat(80) }]);
  // a long line split into many chunks is still parsed correctly (incremental scanning)
  const big = new SSEParser();
  const out = [];
  out.push(...big.push("event: sample\ndata: "));
  for (let i = 0; i < 100; i++) out.push(...big.push("y".repeat(1000)));
  out.push(...big.push("\r"), ...big.push("\n\n"));
  assert.equal(out.length, 1);
  assert.equal(out[0].data.length, 100_000);
});

test("NDJSON: a line over maxLineSize throws StreamLimitError and cancels the stream", async () => {
  let cancelled = false;
  let pulls = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream({
    pull(c) {
      pulls++;
      c.enqueue(enc.encode(pulls === 1 ? '{"a":1}\n' : "z".repeat(40)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const got = [];
  await assert.rejects(
    (async () => {
      for await (const x of readNDJSON(body, { maxLineSize: 100 })) got.push(x);
    })(),
    (e) => e instanceof StreamLimitError && e.limit === 100,
  );
  assert.deepEqual(got, [{ a: 1 }]);
  assert.ok(cancelled, "reading stopped");
  assert.ok(pulls < 10);
  // a complete line over the limit inside a single chunk
  await assert.rejects(collect(readNDJSON(streamOf([`{"s":"${"q".repeat(200)}"}\n{"b":2}\n`]), { maxLineSize: 100 })), StreamLimitError);
  // lines within the limit across chunk boundaries
  assert.deepEqual(await collect(readNDJSON(streamOf(['{"a":', '1}\n{"b"', ":2}\n"]), { maxLineSize: 10 })), [{ a: 1 }, { b: 2 }]);
});

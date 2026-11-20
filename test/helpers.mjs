// Local mock of the WBX API for the offline tests (node:http – used only by the tests).
import { createServer } from "node:http";

/**
 * Starts a mock server. `handler(req, res, ctx)` gets the parsed request:
 * ctx = { method, path, query (URLSearchParams), headers, body (Buffer), json (parsed or undefined), n (call number) }.
 * Returns { url, calls, close }.
 */
export async function mockServer(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, "http://x");
    let json;
    try {
      json = body.length ? JSON.parse(body.toString()) : undefined;
    } catch {
      json = undefined;
    }
    const ctx = { method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, body, json, n: calls.length + 1 };
    calls.push(ctx);
    try {
      await handler(req, res, ctx);
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { error: String(e) });
      else res.destroy();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

export function sendJSON(res, status, obj, headers = {}) {
  const b = obj === undefined ? "" : JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(b);
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const SB = {
  id: "sb_n1_abc",
  template: "base",
  state: "running",
  vcpu: 1,
  mem_mb: 512,
  created_at: "2026-11-20T10:00:00Z",
  expires_at: "2026-11-20T10:05:00Z",
};

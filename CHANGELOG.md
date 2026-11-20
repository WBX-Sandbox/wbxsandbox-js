# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org) (while 0.x, minor releases may break compatibility).

## [0.1.1] – 2026-11-21

### Changed

- Releases are published through npm trusted publishing (GitHub Actions OIDC) as staged
  versions approved by a maintainer with 2FA; packages carry provenance.
- CI runs on Node.js 20, 22 and 24 (GitHub Actions v5).

## [0.1.0] – 2026-11-20

First release.

### Added

- `WBX` client: API key from `WBXSANDBOX_API_KEY`, address from `WBXSANDBOX_URL`
  (default `https://sandbox.wbx.cz`), per-attempt timeouts, `AbortSignal` on every call,
  safe automatic retries with backoff and `Retry-After`, custom `fetch`.
- Sandboxes: create (template, lifetime, name, sleep on timeout, idle timeout, keep days,
  env, metadata, compute class, network policy and IP version), get, list, kill, refresh,
  set timeout, sleep, pause, resume, keep, public port URL, `runCode`.
- Commands: `run` (with live output callbacks), `stream` (async iterator of events).
- Files: read (bytes, text, stream), write (text, bytes, Blob, stream), list, stat, exists,
  mkdir, move, remove, watch.
- Background processes: start, list, get, stream output, stdin, signals, resize, kill.
- Jobs: create (idempotency key added automatically), get, list (pages), server-side wait,
  summary, logs, digest, follow, receipt, signed receipt, artifacts, verified download
  (`IntegrityError` also when the server's checksum is missing or malformed, unless
  `verify: false`), cancel, retry; WebAssembly jobs.
- Batches: create with dependencies and inputs from other jobs, get, list, summary, report
  (JSON and CSV), wait, cancel, jobs of a batch.
- Metrics: current values; history and live stream (feature `metrics_history`) with
  optional resumption – reconnects back off with jitter, a connection that ends right after
  opening counts as a failure (`maxReconnects`), and at most `maxConnectsPerMinute`
  (default 6) connections are opened a minute.
- Desktop control for the `desktop` template (feature `desktop`): status (`controller_until`
  as Unix ms), screenshot (image and screen size), actions (`mouse_down` / `mouse_up` with
  optional coordinates, screenshot format, quality and width; a failed action throws
  `ComputerActionError` with `failedIndex` and `results`, or is returned with
  `throwOnFailure: false`; `screenshotError`), taking control back, convenience methods.
- Templates, features, budget, compute classes, runtimes, receipt keys, webhook secret,
  `verifyWebhook`, `wbx.request()` for endpoints without a wrapper.
- Typed errors (`WBXError` and subclasses for every HTTP status the API uses;
  `HumanInControlError.controllerUntil`, `ComputerActionError`, `StreamLimitError`).
- SSE and NDJSON stream parsers with a size limit per event / line (`maxStreamEventSize`,
  default 16 MiB characters; `StreamLimitError` stops reading and closes the connection).

### Security

- The API key is kept in a private field of the transport: it is not part of
  `transport.config`, and `util.inspect()` / `console.log()` / `JSON.stringify()` of the
  client, its resources, sandboxes, jobs, batches and errors never contain it.
- Streamed responses cannot make the client buffer without bound (see `maxStreamEventSize`).
- A downloaded artifact without a checksum is never returned as verified.

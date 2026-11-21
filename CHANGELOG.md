# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org) (while 0.x, minor releases may break compatibility).

## [0.2.1] – 2026-11-21

### Changed

- `sandbox.clone()` sends only the options you pass (as before); the platform (0.16.1) now gives
  copies the source sandbox's lifetime (`timeoutSeconds`, `onTimeout`, `idleTimeoutSeconds`,
  `keepDays`), compute class and network access when they are left out. A `network` passed to
  `clone()` can only narrow the source's access. Doc comments updated.
- Snapshots and clones are available to every account (no longer enabled on request); they can
  still be turned off for an account, then the API answers `403 feature_disabled`.

### Documentation

- README: section on snapshots and clones (examples, what copies inherit, limits, errors).

## [0.2.0] – 2026-11-21

### Added

- Snapshots of a sandbox disk (feature `snapshots`): `sandbox.snapshot({ name })` returns a
  `Snapshot` (`id`, `name`, `sourceSandbox`, `template`, `sizeBytes`, `createdAt`, `info`);
  `wbx.snapshots.list()`, `.get(id)`, `.delete(id)`, `snapshot.delete()` and
  `snapshot.createSandbox(params)`.
- `wbx.sandboxes.create({ fromSnapshot: "snap_…" })` starts a sandbox from a snapshot; the
  request waits up to 300 s by default (the disk is copied), other creates 150 s.
- Clones (features `snapshots` and `clones`): `sandbox.clone({ count, keepSnapshot, snapshotName, …create options })`
  creates 1–10 copies and returns `{ snapshotId, snapshotKept, sandboxes, errors }` (each
  `CloneError` has `index`, `name`, `status`, `code`, `error`); it throws only when no copy
  was created. Types `SnapshotInfo`, `CloneParams`, `CloneResult`, `CloneError`, `CloneResponse`.
- Error codes `snapshot_limit` (`RateLimitError`) and `sandbox_archived` (`ConflictError`) documented.

## [0.1.3] – 2026-11-20

### Documentation

- README: overview of what the SDK covers (sandboxes, jobs, batches, metrics, desktop, receipts, webhooks,
  budgets) with links to the documentation. No code changes.

## [0.1.2] – 2026-11-20

### Fixed

- `sandbox.computer.actions()` and its shortcuts (`click`, `type`, `key`, `scroll`, …) use an
  HTTP limit of 5 minutes instead of the client's 60 s, as the Python SDK does: one request may
  type up to 8192 characters (about a minute), wait up to 30 s and queue behind other action
  requests. `timeoutMs` of the call still overrides it.

### Documentation

- `scroll(x, y, dx, dy)`: the order differs from the Python SDK (`scroll(x, y, dy, dx)`);
  documented in the method and the README.
- README: API keys are created on the portal's **API keys** page; `metrics.stream({ since: 0 })`
  starts with the whole stored hour; `computer.control("agent")` cannot take control away from
  a person (`HumanInControlError`); 503 `service_unavailable` when new jobs are not accepted.

## [0.1.1] – 2026-11-20

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

# Architecture

## Modules

| File | Responsibility |
|---|---|
| `server.js` | Thin wiring. `wire()` builds store → identity → engine (with the file-share transport factory) → notifier → MCP → HTTP app. The direct-run guard reads `loadConfig(process.env)`, listens on `127.0.0.1:$PORT` and stops cleanly on SIGTERM/SIGINT. Tests import `wire` to build whole installs in-process |
| `src/config.js` | `CONDUCTOR_PLUGIN_DATA_DIR` (required, absolute: otherwise the backend refuses to start), `PORT`. Never reads `PROJECTS_ROOT` |
| `src/fsAtomic.js` | `ensurePrivateDir` (0700, tightened if looser), `writeFileAtomic` (exclusive `.tmp-<32hex>` in the same dir → write → fsync → rename), JSON read/write |
| `src/mutex.js` | `withLock(key, fn)`: a per-key promise chain |
| `src/identity.js` | The keypair under `$DATA/identity/`, created on first use; `fingerprint`, `formatFingerprint`, `verifySignature` |
| `src/records.js` | The wire format: envelope, payload schema per type, self-certifying ids, `routeFor`. Pure |
| `src/state.js` | The pure fold of accepted records + pins: `classify` (accept / pending / reject), membership by epoch, message validity, the directory and name rules, per-install views, the routes of interest. No I/O |
| `src/store.js` | Everything under the data dir (below); assigns the acceptance seq |
| `src/engine.js` | Ingest and every action; the single send path `sendMessage`; the outbox; emits `message` events |
| `src/transport/index.js` | The `Transport` typedefs, `assertTransport`, route helpers ([transport.md](transport.md)) |
| `src/transport/fileShare.js` | The v1 transport; `validateShareDir` |
| `src/notifier.js` | Idle-only notifications through cc's `send_prompt`; the watermark |
| `src/cc.js` | The cc routes used ([protocol.md → cc routes used](protocol.md#cc-routes-used)) |
| `src/mcp.js` | The three tools: handlers and text views. `handle()` never throws |
| `src/routes.js`, `src/http.js` | REST table and code → status map; the server, request guard, JSON bodies, static files, security headers |
| `frontend/` | The page (React, Vite). `src/api.ts` is its only network code; every URL is relative |

## Data dir (`$CONDUCTOR_PLUGIN_DATA_DIR`, 0700, written only by this backend)

```
identity/ed25519.pem        0600 PKCS#8 private key; never leaves the data dir
settings.json               {name, shareDir, notifyTarget: {sessionId, label} | null}
pins.json                   name → fingerprint
accepted.ndjson             append-only {seq, id, route, bytes(base64)}; fsynced per record
pending.ndjson              {route, bytes} of records waiting for a dependency; rewritten atomically
outbox.json                 [{route, to: [fp], bytes}] not yet delivered
cursors.json                inbox id → read cursor (an acceptance seq)
notify.json                 {watermark}: the notifier's acceptance seq
```

- At boot the in-memory index is rebuilt from `accepted.ndjson` (each record re-decoded). A line that does not parse (a torn last write) is skipped and logged; a record that no longer decodes is skipped and logged.
- Rejected-record counts and recent reasons are kept in memory only.
- The share dir must not be inside the data dir, nor contain it (`validateShareDir`), so the key never reaches the share.

## Ingest pipeline

All ingest and every action run under one engine lock (`withLock('engine:<dataDir>')`).

1. **Transport** offers `{route, writer, bytes}` to the sink (`engine.ingest`).
2. **Decode** (`decodeRecord`). `BAD_JSON` answers `{retry: true}`: the file share re-offers the file once its size or mtime changes. Any other failure is a counted rejection.
3. **Bind:** `payload.signer === writer` and the route is `routeFor(payload)`; else `ROUTE_MISMATCH`.
4. **Dedup** by record id against accepted and pending records.
5. **Classify** (`state.classify`): `reject` is counted; `pending` is stored in `pending.ndjson`; `accept` appends to `accepted.ndjson` (assigning the next acceptance seq), adds to the index and emits `message` for a `msg`.
6. **Drain pending:** after an accept, every pending record is re-classified until no more progress.
7. **Pins and interest:** newly shown names are pinned; the routes of interest (`interestOf`) are pushed to the transport.
8. **Reactions:** an accepted response to this install's own shared invite admits the invitee (a `member add`).

**Sending** (`publish`): sign → `transport.send` (recipients in `pending`, or all of them if the send throws, go to the outbox) → ingest locally like any other record. The outbox is re-sent on every `engine.sync()` and, for a peer, on `peerOnline`.

**`sendMessage(inbox, body)`** is the one path for both surfaces. In order it refuses `SHARE_UNCONFIGURED`, `INBOX_UNKNOWN` (no such inbox known), `NOT_MEMBER` (known, but not a party or current member), `BAD_REQUEST` (not a non-empty string), `BODY_TOO_LARGE` (over `BODY_MAX_BYTES`, or the encoded record over `RECORD_MAX_BYTES`). A shared message cites the current epoch.

### Acceptance seq, not `ts`

Cursors, unread counts, the notifier's watermark and `read_messages {after}` use the local acceptance seq. The signer's `ts` is its own clock: a backdated message still shows as unread and still notifies.

### Message validity is recomputed

`messagesOf` filters an inbox's accepted messages through the same rule as ingest, against everything known now. A later decline, a removal that does not keep a message, or a same-seq member record with a lower id can invalidate an earlier message; it is then hidden (listed in diagnostics) on every install.

## Notifier lifecycle

- **Start:** loads the watermark; listens for `message` events; arms a flush if mail is already owed.
- **Owed mail** is derived, never counted: `engine.unseenSince(watermark)`, valid messages from others in this install's inboxes. So a restart neither loses nor repeats a notification.
- **Flush** (after `NOTIFY_DEBOUNCE_MS`): GET instances → target row → `idle`? → `send_prompt` → on delivery persist the watermark (the highest seq included). Otherwise record why in `lastError` and re-arm after `NOTIFY_RETRY_MS`. Mail that arrived during a delivery arms the next flush.
- **Assign** (`setTarget`): watermark = current max seq (existing mail is never announced) → store the target → `POST autostart {autoStart: true}`; the result is kept for the page.
- The scheduler and clock are injected (`schedule(fn, ms)` → cancel, `now()`); tests drive them with a fake clock.

## File-share transport

- `start` scans now and then every `pollMs` (`SHARE_POLL_MS`); `sync()` queues one scan; scans never overlap.
- A scan lists every route of interest, each writer subdir (fingerprints only) and each `FILE_RE` file. A path handed over for good is never re-read; a retry answer is cached by (path, size, mtime). Reads are capped at `RECORD_MAX_BYTES + 1` bytes. The scan yields to the event loop every few dozen files so `/api/health` stays responsive.
- `send` writes atomically under `<route dir>/<selfFp>/` and reports every recipient delivered: the share stores everything.
- Swapping the share stops the old transport without waiting (its scan may be queued behind the engine lock); its sink ignores anything it still offers.

## Tests

`npm test` runs `node --test "tests/**/*.test.mjs"` then vitest. Everything is in-process on temp dirs; no live cc and no real `PROJECTS_ROOT`.

| Helper (`tests/helpers.mjs`) | Gives |
|---|---|
| `makeInstall(shareDir, {name, env, schedule, dataDir})` | A whole install (`wire`) with its own temp data dir; the share is polled only when a test calls `engine.sync()`. `rest(method, path, body)` calls its HTTP app as the page does |
| `makeNetwork(names)`, `syncAll`, `connectPersonal` | Announced installs on one share; a sync round; an accepted personal inbox |
| `fakeCc()` | An HTTP fake of `/api/instances`, `/api/plugins`, `/mcp/tools/send_prompt`, `/api/plugins/:id/autostart`, recording every hit; its `env` goes to `makeInstall` |
| `fakeClock()` | `schedule`/`advance`/`now` for the notifier |
| `mcpCall(assert, mcp, tool, args, format)` | Calls a tool and asserts cc's reply contract (json validated against the manifest `outputSchema` with a port of cc's schema subset) |

- `tests/transportContract.test.mjs` runs one contract against the file share and an in-memory push transport (offline peers, outbox, `peerOnline`).
- `tests/concurrency.test.mjs` forks `tests/fixtures/writer.mjs` processes that write one inbox at once.
- `tests/boot.test.mjs` spawns `node server.js` with a scrubbed env.
- `frontend/src/test/setup.ts` makes `fetch` a tripwire; UI tests stub it per test.

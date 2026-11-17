# Architecture

## Modules

| File | Responsibility |
|---|---|
| `server.js` | Thin wiring. `wire()` builds store → identity → engine (with `transportFactory`: the file share or TCP, per `settings.transport`) → notifier → MCP → HTTP app. The direct-run guard reads `loadConfig(process.env)`, listens on `127.0.0.1:$PORT` and stops cleanly on SIGTERM/SIGINT. Tests import `wire` to build whole installs in-process |
| `src/config.js` | `CONDUCTOR_PLUGIN_DATA_DIR` (required, absolute: otherwise the backend refuses to start), `PORT`. Never reads `PROJECTS_ROOT` |
| `src/fsAtomic.js` | `ensurePrivateDir` (0700, tightened if looser), `writeFileAtomic` (exclusive `.tmp-<32hex>` in the same dir → write → fsync → rename), JSON read/write |
| `src/mutex.js` | `withLock(key, fn)`: a per-key promise chain |
| `src/identity.js` | The keypair under `$DATA/identity/`, created on first use; `fingerprint`, `formatFingerprint`, `verifySignature` |
| `src/records.js` | The wire format: envelope, payload schema per type, self-certifying ids, `routeFor`, contact cards (`encodeCard`, `decodeCard`). Pure |
| `src/state.js` | The pure fold of accepted records + pins: `classify` (accept / pending / reject), membership by epoch, message validity, the directory and name rules, per-install views, the routes of interest, who may pull a route (`mayRead`) and whom to dial (`contactsOf`). No I/O |
| `src/store.js` | Everything under the data dir (below); assigns the acceptance seq |
| `src/engine.js` | Ingest and every action; the single send path `sendMessage`; the outbox; emits `message` events. Builds the transport's `view` ([transport.md → The factory and the engine view](transport.md#the-factory-and-the-engine-view)) from two in-memory maps: its own signed records per route (`ownLog`, rebuilt at boot) and announce bytes by id. `importCard` admits a pasted announce |
| `src/transport/index.js` | The `Transport` typedefs, `assertTransport`, route helpers ([transport.md](transport.md)) |
| `src/transport/fileShare.js` | The v1 transport; `checkStoredShareDir` (the boot check: path rules, plus real paths when the dir resolves; never requires it to exist) and `validateShareDir` (the full check on save) |
| `src/transport/frames.js` | TCP framing (`encodeFrame`, `createDecoder`), exact frame schemas per phase (`parseFrame`), the frame-size and count limits. Pure |
| `src/transport/handshake.js` | `PROOF_DOMAIN`, `proofBytes`, `proofSigner` (the only signing a transport can do), `makeProofs`, `verifyProofs`. Pure |
| `src/transport/tcpSession.js` | One connection: the handshake state machine, phase limits, deadlines, keepalive, request/response correlation, the bounded inbound queue |
| `src/transport/tcp.js` | The TCP endpoint (listener, pool, dials, backoff, maintain, pulls, cursors) and its per-identity Transports; `validateTcpConfig`, `parseTcpAddr`, `formatTcpAddr` |
| `src/notifier.js` | Idle-only notifications through cc's `send_prompt`; the watermark |
| `src/cc.js` | The cc routes used ([protocol.md → cc routes used](protocol.md#cc-routes-used)) |
| `src/mcp.js` | The three tools: handlers and text views. `handle()` never throws |
| `src/routes.js`, `src/http.js` | REST table and code → status map; the server, request guard, JSON bodies, static files, security headers |
| `frontend/` | The page (React, Vite). `src/api.ts` is its only network code; every URL is relative |

## Data dir (`$CONDUCTOR_PLUGIN_DATA_DIR`, 0700, written only by this backend)

```
identity/ed25519.pem        0600 PKCS#8 private key; never leaves the data dir
settings.json               {name, transport, notifyTarget: {sessionId, label} | null}
                            transport: null | {kind:'file-share', dir} | {kind:'tcp', host, port, advertise}
pins.json                   name → fingerprint
accepted.ndjson             append-only {seq, id, route, bytes(base64)}; fsynced per record
pending.ndjson              {route, bytes} of records waiting for a dependency; rewritten atomically
rejected.ndjson             append-only {id, reason, type, inbox, signer} of records refused for good; fsynced
outbox.json                 [{route, to: [fp], bytes}] not yet delivered; `to: []` is a write still owed
cursors.json                inbox id → read cursor (an acceptance seq)
notify.json                 {watermark}: the notifier's acceptance seq
contacts.json               [fp]: identities whose contact card a human imported (part of the TCP dial set)
peer-cursors.json           {peerFp: {routeKey: seq}}: the TCP pull cursors (the peer's acceptance seqs)
```

- **Settings migration:** `store.load()` rewrites a `settings.json` holding `shareDir` once, atomically: `shareDir` becomes `transport: {kind:'file-share', dir}` (or `null`) and the key is dropped. A file without `shareDir` is left untouched.

- At boot the in-memory index is rebuilt from `accepted.ndjson` (each record re-decoded). A line that does not parse (a torn last write) is skipped and logged; a record that no longer decodes is skipped and logged.
- Refused ids are kept (`rejected.ndjson`) so what builds on them is refused too, across restarts; the diagnostics count and recent reasons are in memory only.
- The share dir must not be inside the data dir, nor contain it, so the key never reaches the share: checked on save by realpath (`validateShareDir`), and at boot on the resolved paths plus, when the dir resolves, the real paths (`checkStoredShareDir`), which does not require the share to be mounted yet.

## Ingest pipeline

All ingest and every action run under one engine lock (`withLock('engine:<dataDir>')`).

1. **Transport** offers `{route, writer, bytes}` to the sink (`engine.ingest`).
2. **Decode** (`decodeRecord`). `BAD_JSON` answers `{retry: true}`: the file share re-offers the file once its size or mtime changes. Any other failure is a counted rejection.
3. **Bind:** `payload.signer === writer` and the route is `routeFor(payload)`; else `ROUTE_MISMATCH`.
4. **Dedup** by record id against accepted, pending and refused records.
5. **Classify** (`state.classify`): `reject` is counted and its id appended to `rejected.ndjson`; `pending` is stored in `pending.ndjson`; `accept` appends to `accepted.ndjson` (assigning the next acceptance seq), adds to the index and emits `message` for a `msg`.
6. **Drain pending:** after every verdict, pending ones included, every pending record is re-classified until a round settles none. A pending record can settle others: a removal's kept chain is walked through pending records.
7. **Pins and interest:** newly shown names are pinned; the routes of interest (`interestOf`) are pushed to the transport.
8. **Reactions:** an accepted response to this install's own shared invite admits the invitee (a `member add`) while `admissionDue` holds ([protocol.md → Admission](protocol.md#admission-after-an-accepted-shared-invite)).

**Boot recovery:** after rebuilding the index, pending entries already accepted are dropped and the pending set is drained once; whenever a transport starts (at boot, or later when a human saves one after a boot that started none), every admission `admissionDue` still owes is written. That closes the crash windows between accepting a record and acting on it.

**Sending** (`publish`): sign → `transport.send` → ingest locally like any other record. A `SHARE_UNSAFE` send is the exception: the action is refused with that code and nothing is admitted or queued. Every other outcome lets the action succeed, with what was not delivered kept in the outbox.

**Outbox** (`outbox.json`, entries `{route, to, bytes}`):
- An entry stays while `to` (the recipients still pending) is non-empty, **or while its write is owed**: the send threw a retryable error. An owed write may have `to: []` (an announce before this install knows anyone, a message in an inbox with no other member): the record must still reach the share for readers nobody can name.
- **Retryable** (`isRetryableSendError`, `src/engine.js`): `SHARE_UNAVAILABLE` (the file share's configured dir does not exist: a mount not up) and any system error code (`E…`: `EIO`, `ENOSPC`, `ENOTDIR`, …). Any other throw keeps only its recipients (none: dropped and logged). `SHARE_UNSAFE` refuses the action; met during a re-send, it keeps the entry until a human fixes the share.
- **Re-sending:** a full flush re-sends every entry, owed writes included, and drops each once a send succeeds; `peerOnline(fp)` re-sends only the entries addressed to `fp`. Every flush runs under the engine lock, so no entry is sent by two flushes at once.
- **When:** a full flush after every successful transport start (boot, `setShare`, `setTcp`); on the `OUTBOX_RETRY_MS` timer (injected `schedule`), armed exactly while the outbox is non-empty and cleared by `engine.stop()`; and on `engine.sync()`. Over TCP the timer's re-sends go through `send`, so an unreachable recipient is dialed only as its address's backoff allows: retry ticks add no dials.
- `SHARE_UNAVAILABLE` is never shown as a refusal: `state().transport.unavailable` is true while the last file-share send found the share missing, and the Transport panel shows it with the outbox count.

**`sendMessage(inbox, body)`** is the one path for both surfaces. In order it refuses `TRANSPORT_UNCONFIGURED`, `INBOX_UNKNOWN` (no such inbox known), `NOT_MEMBER` (known, but not a party or current member), `BAD_REQUEST` (not a non-empty string), `BODY_TOO_LARGE` (over `BODY_MAX_BYTES`, or `encodeRecord`'s `RECORD_TOO_LARGE`). A shared message cites the current epoch and, as `prev`, this install's last **valid** message in that inbox (`lastValidOf`; never one a removal refused). `removeMember` writes `keepHead` the same way.

### Acceptance seq, not `ts`

Cursors, unread counts, the notifier's watermark and `read_messages {after}` use the local acceptance seq. The signer's `ts` is its own clock: a backdated message still shows as unread and still notifies.

### Message validity is recomputed

`messagesOf` filters an inbox's accepted messages through the same rule as ingest, against everything known now. A later decline, a removal whose kept chain does not reach a message (and so everything built on it), or a same-seq member record with a lower id can invalidate an earlier message; it is then hidden (listed in diagnostics) on every install. `verdictOf` follows `prev` iteratively down to the first settled message and judges the path upward, so chain length costs neither stack nor a re-walk. Settled verdicts (valid or refused) are kept in `index.verdicts`, cleared when a record other than a `msg` or `announce` is accepted (membership, removals, invites, responses) and when a record is refused. A completed kept-chain walk is kept per removal in `index.chains`, cleared when a record is refused: a walk may have crossed a pending record that is refused later, which would end it sooner. Undecided verdicts are never kept.

## Notifier lifecycle

- **Start:** loads the watermark; listens for `message` events; arms a flush if mail is already owed.
- **Owed mail** is derived, never counted: `engine.unseenSince(watermark)`, valid messages from others in this install's inboxes. So a restart neither loses nor repeats a notification.
- **Flushes never overlap:** a timer that fires while one is in flight re-arms with its own interval instead, so no message is read as owed by two flushes.
- **Flush** (after `NOTIFY_DEBOUNCE_MS`): GET instances → target row → `idle`? → `send_prompt` → on delivery persist the watermark (the highest seq included). Otherwise record why in `lastError` and re-arm after `NOTIFY_RETRY_MS`. Mail that arrived during a delivery arms the next flush.
- **Assign** (`setTarget`): watermark = current max seq (existing mail is never announced) → store the target → `POST autostart {autoStart: true}`; the result is kept for the page.
- The scheduler and clock are injected (`schedule(fn, ms)` → cancel, `now()`); tests drive them with a fake clock.

## File-share transport

- `start` scans now and then every `pollMs` (`SHARE_POLL_MS`); `sync()` queues one scan; scans never overlap.
- A scan lists every route of interest, each writer subdir (fingerprints only, real directories only) and each `FILE_RE` file (`lstat`: real files only). A failure offering one file is logged and retried next scan; it never ends the route's scan. A path handed over for good is never re-read; a retry answer is cached by (path, size, mtime). Reads are capped at `RECORD_MAX_BYTES + 1` bytes. The scan yields to the event loop every few dozen files so `/api/health` stays responsive.
- `send` writes atomically under `<route dir>/<selfFp>/`, refused `SHARE_UNSAFE` if that subdir is a symlink, not a directory, or resolves outside the share. It reports every recipient delivered: the share stores everything.
- Swapping the share stops the old transport without waiting (its scan may be queued behind the engine lock); its sink ignores anything it still offers.

## TCP transport lifecycle

- **Start** (`startTransport` → `start(sink)`): at boot the stored config is checked first (TCP as on save, DNS included; a share dir by `checkStoredShareDir`, which never requires it to exist; an invalid one starts nothing and the refusal is shown in `state().transport.error`). Then attach the binding (closing the endpoint's sessions if it already had others), listen (a failure leaves no transport and refuses `TCP_LISTEN_FAILED`; at boot it is logged and shown, not fatal), load `peer-cursors.json`, run `maintain` and then every `syncMs`. After any successful start (boot, `setShare`, `setTcp`) the engine writes every admission still owed (`reconcileAdmissions`).
- **Listener errors** after it is up close the listener (freeing the port) and forget it; existing sessions stay.
- **Maintain:** whois for contacts with no address → dial contacts without a session → pull from every session the routes of interest that peer could serve (`view.mayPull`). Maintain runs and pulls of one binding never overlap.
- **Session ready:** `peerOnline` (the engine flushes its outbox for that peer) and a pull of the binding's interest from that peer.
- **Inbound frames** of one session are processed one at a time, each awaited; `rec` waits for the engine lock through `sink.record`. Writes never wait on inbound processing, so a `send` under the engine lock cannot deadlock against it.
- **Stop:** closes the listener synchronously before anything is awaited, then every socket and timer, and never awaits a pending sink call (the engine lock may hold it). The engine drops whatever the old sink still offers.
- **Card import** (`importCard`) admits the announce under the lock, adds its signer to `contacts.json`, then, outside the lock, starts a transport `sync()` so the new contact is dialed at once.

## Tests

`npm test` runs `node --test "tests/**/*.test.mjs"` then vitest. Everything is in-process on temp dirs; no live cc and no real `PROJECTS_ROOT`.

| Helper (`tests/helpers.mjs`) | Gives |
|---|---|
| `makeInstall(shareDir, {name, env, schedule, dataDir})` | A whole install (`wire`) with its own temp data dir; the share is polled (and TCP maintained) only when a test calls `engine.sync()`. `rest(method, path, body)` calls its HTTP app as the page does |
| `makeNetwork(names)`, `syncAll`, `connectPersonal` | Announced installs on one share; a sync round; an accepted personal inbox |
| `fakeCc()` | An HTTP fake of `/api/instances`, `/api/plugins`, `/mcp/tools/send_prompt`, `/api/plugins/:id/autostart`, recording every hit; its `env` goes to `makeInstall` |
| `fakeClock()` | `schedule`/`advance`/`now` for the notifier |
| `mcpCall(assert, mcp, tool, args, format)` | Calls a tool and asserts cc's reply contract (json validated against the manifest `outputSchema` with a port of cc's schema subset) |

- `tests/transportContract.test.mjs` runs one contract against the file share, an in-memory push transport (offline peers, outbox, `peerOnline`) and TCP on real loopback sockets. A transport without a directory bootstraps as humans do: every node after the first imports node 0's contact card.
- `tests/tcp.test.mjs` pins the TCP invariants (pooling, addressing, handshake refusals, limits, outbox, cursors, `mayRead`, whois hints, dial policy, duplicates, backoff, listening) on loopback sockets, port 0, with short injected limits and a fake clock for backoff. `tests/tcpHelpers.mjs` gives `tcpNode` (an engine over TCP, optionally on a shared endpoint or with a spied `view`), `rawPeer`/`rawConnect` (a raw protocol client), `stubView`, `stubSink`, `countingListener` and `waitFor`.
- `tests/outbox.test.mjs` takes the share off its "mount" (renames its dir away and back) and drives the outbox retry timer with a fake clock: owed writes, the boot-time admission, a filesystem error, the timer's arming, and no dial storm over TCP.
- `tests/frames.test.mjs` drives the decoder through split and coalesced streams and `parseFrame` through every schema violation.
- `tests/concurrency.test.mjs` forks `tests/fixtures/writer.mjs` processes that write one inbox at once.
- `tests/boot.test.mjs` spawns `node server.js` with a scrubbed env.
- `tests/convergence.test.mjs` builds one record set (two removals, a re-add, chains, a fork, a stale write, pre-signed links), then feeds it to fresh readers through `engine.ingest` in fixed and seeded shuffled orders and compares `engine.verdicts(inbox)` with the owner's.
- `tests/recovery.test.mjs` writes a data dir as a crashed backend would leave it (a pending record whose dependency is accepted; an accepted acceptance with no admission) and boots a fresh install from it.
- `frontend/src/test/setup.ts` makes `fetch` a tripwire; UI tests stub it per test.

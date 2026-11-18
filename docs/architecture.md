# Architecture

## Modules

| File | Responsibility |
|---|---|
| `server.js` | Thin wiring. `wire()` builds store → identity → engine (with `transportFactory`: the file share or network mode, per `settings.transport`) → notifier → MCP → HTTP app. The direct-run guard reads `loadConfig(process.env)`, listens on `127.0.0.1:$PORT` and stops cleanly on SIGTERM/SIGINT. Tests import `wire` to build whole installs in-process |
| `src/config.js` | `CONDUCTOR_PLUGIN_DATA_DIR` (required, absolute: otherwise the backend refuses to start), `PORT`. Never reads `PROJECTS_ROOT` |
| `src/fsAtomic.js` | `ensurePrivateDir` (0700, tightened if looser), `writeFileAtomic` (exclusive `.tmp-<32hex>` in the same dir → write → fsync → rename), JSON read/write |
| `src/mutex.js` | `withLock(key, fn)`: a per-key promise chain |
| `src/identity.js` | The keypair under `$DATA/identity/`, created on first use; `fingerprint`, `formatFingerprint`, `verifySignature` |
| `src/records.js` | The wire format: envelope, payload schema per type, self-certifying ids, `routeFor`, contact cards (`encodeCard`, `decodeCard`), `ANNOUNCE_MAX_BYTES`. Pure |
| `src/directory.js` | The in-memory announce map: `createDirectory()` → `{note(decoded) → changed, get(fp), entries()}`, latest per fp by (`ts`, record id). No I/O |
| `src/state.js` | The pure fold of accepted records + pins: `classify` (accept / pending / reject), membership by epoch, message validity, the name rules over the memory announces (`directory`, `nameRefusal`), per-install views, the routes of interest, who may pull a route (`mayRead`) and whom to dial (`contactsOf`); `index.named`, every fp an accepted record names. No I/O |
| `src/store.js` | Everything under the data dir (below); assigns the acceptance seq |
| `src/engine.js` | Ingest and every action; the single send path `sendMessage`; the outbox; emits `message` events. Builds the transport's `view` ([transport.md → The factory and the engine view](transport.md#the-factory-and-the-engine-view)) from its own signed records per route (`ownLog`, rebuilt at boot). Holds the memory directory, keeps `identities.json` and pins in step with it, and re-signs its own announce at boot. `importCard` takes a pasted announce into memory and `identities.json` |
| `src/transport/index.js` | The `Transport` typedefs, `assertTransport`, route helpers ([transport.md](transport.md)) |
| `src/transport/fileShare.js` | The v1 transport; `checkStoredShareDir` (the boot check: path rules, plus real paths when the dir resolves; never requires it to exist) and `validateShareDir` (the full check on save) |
| `src/transport/frames.js` | Framing (`encodeFrame`, `createDecoder`), exact frame schemas per phase: endpoint frames (`parseFrame`), the greeting (`parseGreeting`) and hub-link frames per role (`parseHubFrame`); `HELLO_KINDS`; the frame-size and count limits. Pure |
| `src/transport/addr.js` | Host and `host:port` rules (`isHost`, `isWildcardHost`, `parseHostPort`, `formatHostPort`, `ADDRESS_MAX_CHARS`) and `lookupAll` (DNS with a timeout, `TCP_LOOKUP_MS`) |
| `src/transport/handshake.js` | `PROOF_DOMAIN`, `proofBytes`, `dialBound`, `proofSigner` (the only signing a transport can do), `makeProofs`, `verifyProofs`. Pure |
| `src/transport/greeting.js` | `greet()`: the first hello exchange of an outbound connection; tells a peer from a hub and hands the paused socket on |
| `src/transport/tcpSession.js` | One session: the handshake state machine (targeted or untargeted dial, or accept; started from a greeting or not), phase limits, deadlines, keepalive, request/response correlation, the bounded inbound queue; `via`, `end` (why it ended) |
| `src/transport/endpoint.js` | The network endpoint core: bindings, sessions, pool and duplicate rule (direct first), `peerOnline`, serving (`rec`, `pull`), the announce push, pulls and cursors, maintain and `dialHubs`, presence, the per-identity Transports. Links (`makeLinks(core)`) supply the byte pipes ([transport.md → Core and links](transport.md#core-and-links)) |
| `src/transport/listener.js` | The listener link: listen, accept → `via: 'direct'` sessions, close |
| `src/transport/connection.js` | One configured connection: connect, greet, peer mode (an untargeted dial) or hub mode, reconnect and backoff, the idle rule, `HUB_DUPLICATE`, status |
| `src/transport/network.js` | Network mode: `validateNetworkConfig`, `resolveNetworkConfig`, `createNetworkEndpoint`, `createNetwork`, `TCP_DEFAULT_PORT`, `CONNECTIONS_MAX` |
| `src/transport/hubConn.js` | One hub-link connection, either side: hello (the hub's) or a greeting (the client's), `register` / `ok`, phase limits, deadlines, keepalive, write-buffer cap, `bye`. Synchronous: no inbound queue |
| `src/transport/hubLink.js` | The hub mode on one registered link: `HubStream` (a socket-like stream a session runs on), the client's roster (`peer`, `gone`), announces to the hub, per-fp stream dials and backoff ([hub.md](hub.md)) |
| `hub.js`, `src/hub/hub.js` | The standalone hub: the CLI entry (`util.parseArgs`, direct-run guard) and the router and roster (`createHub`, `validateHubListen`). Imports nothing of the plugin host |
| `src/notifier.js` | Idle-only notifications through cc's `send_prompt`; the watermark |
| `src/cc.js` | The cc routes used ([protocol.md → cc routes used](protocol.md#cc-routes-used)) |
| `src/mcp.js` | The three tools: handlers and text views. `handle()` never throws |
| `src/routes.js`, `src/http.js` | REST table and code → status map; the server, request guard, JSON bodies, static files, security headers |
| `frontend/` | The page (React, Vite). `src/api.ts` is its only network code; every URL is relative |

## Data dir (`$CONDUCTOR_PLUGIN_DATA_DIR`, 0700, written only by this backend)

```
identity/ed25519.pem        0600 PKCS#8 private key; never leaves the data dir
settings.json               {name, announced: string | null, transport, notifyTarget: {sessionId, label} | null}
                            announced: the name last announced (the announce is re-signed from it at every boot)
                            transport: null | {kind:'file-share', dir} | {kind:'network', listen: {host, port} | null, connections: ["host:port", …]}
pins.json                   name → fingerprint, for this install and the identities in identities.json only
identities.json             {fp: {announce: base64url announce record, imported: boolean}}: card imports and every fp the log names,
                            never this install's own fp (its announce is re-signed from settings.announced)
accepted.ndjson             append-only {seq, id, route, bytes(base64)}; fsynced per record; never an announce
pending.ndjson              {route, bytes} of records waiting for a dependency; rewritten atomically
rejected.ndjson             append-only {id, reason, type, inbox, signer} of records refused for good; fsynced
outbox.json                 [{route, to: [fp], bytes}] not yet delivered; `to: []` is a write still owed; invalid entries are dropped on load
cursors.json                inbox id → read cursor (an acceptance seq)
notify.json                 {watermark}: the notifier's acceptance seq
peer-cursors.json           {peerFp: {routeKey: seq}}: the network pull cursors (the peer's acceptance seqs)
```

- **Settings migration:** `store.load()` rewrites a `settings.json` holding `shareDir` once, atomically: `shareDir` becomes `transport: {kind:'file-share', dir}` (or `null`) and the key is dropped. A file without `shareDir` is left untouched.

- At boot the memory directory is filled from `identities.json` (an entry that does not decode as an announce signed by its fp is dropped and logged by `store.load()`), this install's announce is re-signed if `settings.announced` is set, and the in-memory index is rebuilt from `accepted.ndjson` (each record re-decoded). A line that does not parse (a torn last write), a record that no longer decodes, and an announce (the log never holds one) are skipped and logged.
- **Strangers never reach the data dir:** an announce is kept in memory; it is written to `identities.json` (and its name pinned) only once its fp is imported or named by an accepted record.
- Refused ids are kept (`rejected.ndjson`) so what builds on them is refused too, across restarts; the diagnostics count and recent reasons are in memory only.
- The share dir must not be inside the data dir, nor contain it, so the key never reaches the share: checked on save by realpath (`validateShareDir`), and at boot on the resolved paths plus, when the dir resolves, the real paths (`checkStoredShareDir`), which does not require the share to be mounted yet.

## Ingest pipeline

All ingest and every action run under one engine lock (`withLock('engine:<dataDir>')`).

1. **Transport** offers `{route, writer, bytes}` to the sink (`engine.ingest`).
2. **Decode** (`decodeRecord`). `BAD_JSON` answers `{retry: true}`: the file share re-offers the file once its size or mtime changes. Any other failure is a counted rejection.
3. **Bind:** `payload.signer === writer` and the route is `routeFor(payload)`; else `ROUTE_MISMATCH`. An **announce** stops here: it goes to the memory directory (`noteAnnounce`: new pins and `identities.json` follow when it is newer), never to the log. A hub-relayed announce (`sink.announce`) enters here too, with writer = its signer.
4. **Dedup** by record id against accepted, pending and refused records.
5. **Classify** (`state.classify`): `reject` is counted and its id appended to `rejected.ndjson`; `pending` is stored in `pending.ndjson`; `accept` appends to `accepted.ndjson` (assigning the next acceptance seq), adds to the index and emits `message` for a `msg`.
6. **Drain pending:** after every verdict, pending ones included, every pending record is re-classified until a round settles none. A pending record can settle others: a removal's kept chain is walked through pending records.
7. **Pins, identities and interest:** newly shown names of kept identities are pinned; `identities.json` follows (a record can name a new fp); the routes of interest (`interestOf`) are pushed to the transport.
8. **Reactions:** an accepted response to this install's own shared invite admits the invitee (a `member add`) while `admissionDue` holds ([protocol.md → Admission](protocol.md#admission-after-an-accepted-shared-invite)).

**Boot recovery:** after rebuilding the index, pending entries already accepted are dropped and the pending set is drained once; whenever a transport starts (at boot, or later when a human saves one after a boot that started none), every admission `admissionDue` still owes is written. That closes the crash windows between accepting a record and acting on it.

**Sending** (`publish`): sign → `transport.send` → ingest locally like any other record. A `SHARE_UNSAFE` send is the exception: the action is refused with that code and nothing is admitted or queued. Every other outcome lets the action succeed, with what was not delivered kept in the outbox.

**Outbox** (`outbox.json`, entries `{route, to, bytes}`):
- An entry stays while `to` (the recipients still pending) is non-empty, **or while its write is owed**: the send threw a retryable error. An owed write may have `to: []` (an announce before this install knows anyone, a message in an inbox with no other member): the record must still reach the share for readers nobody can name.
- **Retryable** (`isRetryableSendError`, `src/engine.js`): `SHARE_UNAVAILABLE` (the file share's root does not exist: a mount not up) and any system error code (`E…`: `EIO`, `ENOSPC`, `ENOTDIR`, `EACCES`, …). Any other throw keeps only its recipients (none: dropped, with a log line). `SHARE_UNSAFE` refuses a fresh action; met during a re-send, it keeps the entry until a human fixes the share. A permanent `E…` (`EACCES`, `EROFS`) therefore retries until fixed too: it is visible, below.
- **Re-sending:** a full flush re-sends every entry, owed writes included, and drops each once a send succeeds; `peerOnline(fp)` re-sends only the entries addressed to `fp`. Every flush runs under the engine lock, so no entry is sent by two flushes at once.
- **When:** a full flush after every successful transport start (boot, `setShare`, `setNetwork`); on the `OUTBOX_RETRY_MS` timer (injected `schedule`), armed exactly while the outbox is non-empty and cleared by `engine.stop()`; and on `engine.sync()`. In network mode a re-send goes through `send`, which never reconnects a connection: connections reconnect on their own backoff only (the test "outbox retries never reconnect a connection faster than its backoff"). A network transport never puts an announce in the outbox; on the file share the announce file is an owed write like any other.
- **Failures are visible, not refusals:** `state().transport.outboxError` is `{code, message}` of the latest send failure that holds a write (`SHARE_UNAVAILABLE`, `SHARE_UNSAFE`, `EACCES`, …); a full flush in which every send goes through, or an empty outbox, clears it. The Transport panel shows it with the outbox count. A failure is logged when its code differs from the last one logged, so a retry timer failing the same way logs once.
- **On load,** an `outbox.json` entry whose route fails `isRoute` or whose `to` holds a non-fingerprint is dropped with a log line (`store.load`).

**`sendMessage(inbox, body)`** is the one path for both surfaces. In order it refuses `TRANSPORT_UNCONFIGURED`, `INBOX_UNKNOWN` (no such inbox known), `NOT_MEMBER` (known, but not a party or current member), `BAD_REQUEST` (not a non-empty string), `BODY_TOO_LARGE` (over `BODY_MAX_BYTES`, or `encodeRecord`'s `RECORD_TOO_LARGE`). A shared message cites the current epoch and, as `prev`, this install's last **valid** message in that inbox (`lastValidOf`; never one a removal refused). `removeMember` writes `keepHead` the same way.

### Acceptance seq, not `ts`

Cursors, unread counts, the notifier's watermark and `read_messages {after}` use the local acceptance seq. The signer's `ts` is its own clock: a backdated message still shows as unread and still notifies.

### Message validity is recomputed

`messagesOf` filters an inbox's accepted messages through the same rule as ingest, against everything known now. A later decline, a removal whose kept chain does not reach a message (and so everything built on it), or a same-seq member record with a lower id can invalidate an earlier message; it is then hidden (listed in diagnostics) on every install. `verdictOf` follows `prev` iteratively down to the first settled message and judges the path upward, so chain length costs neither stack nor a re-walk. Settled verdicts (valid or refused) are kept in `index.verdicts`, cleared when a record other than a `msg` is accepted (membership, removals, invites, responses) and when a record is refused. A completed kept-chain walk is kept per removal in `index.chains`, cleared when a record is refused: a walk may have crossed a pending record that is refused later, which would end it sooner. Undecided verdicts are never kept.

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

## Network endpoint lifecycle

- **Start** (`startTransport` → `setAnnounce(own)` → `start(sink)`): at boot the stored config is checked first (network settings as on save, except that a connection host need not resolve yet; a share dir by `checkStoredShareDir`, which never requires it to exist; an invalid one starts nothing and the refusal is shown in `state().transport.error`). Then attach the binding (closing the endpoint's sessions if it already had others), load `peer-cursors.json`, open every link (the listener listens, where a failure leaves no transport and refuses `LISTEN_FAILED`, at boot logged and shown, not fatal; each connection starts its first attempt and resolves at once), run `maintain` and then every `syncMs`. After any successful start (boot, `setShare`, `setNetwork`) the engine writes every admission still owed (`reconcileAdmissions`).
- **Listener errors** after it is up close the listener (freeing the port) and forget it; existing sessions stay.
- **Connections** run independently of contacts, each on its own timer: `connecting` → `up`, or `waiting` with backoff on a failure; a peer-mode connection whose session lost the duplicate rule (or whose peers all have another direct session) goes `idle`; a hub link replaced by a duplicate registration is `stopped` ([transport.md → Connections](transport.md#connections)).
- **Maintain:** due connections up (awaited) → contacts still without a session dialed through the hubs, in configured order → pull from every session the routes of interest that peer could serve (`view.mayPull`). Maintain runs and pulls of one binding never overlap.
- **Session ready:** the duplicate rule (direct first); each binding's announce pushed to the peer; `peerOnline` (the engine flushes its outbox for that peer); a pull of the binding's interest from that peer.
- **Inbound frames** of one session are processed one at a time, each awaited; `rec` waits for the engine lock through `sink.record`. Writes never wait on inbound processing, so a `send` under the engine lock cannot deadlock against it.
- **Stop:** closes every session, then every link synchronously (the listener; each connection's timer, greeting socket, peer session or hub link with `bye STOP`) before anything is awaited, and never awaits a pending sink call (the engine lock may hold it). The engine drops whatever the old sink still offers.
- **Hub link:** on `ok` resets its backoff, gives the hub its announces and queues every binding's maintain; roster `peer` notices feed the memory directory (`sink.announce`) and dial contacts; on close ends every stream (their sessions leave the pool) and reconnects, except after `bye DUPLICATE` on the current link (`HUB_DUPLICATE`: stopped). A binding attached or detached on a shared endpoint leaves the current link and re-registers, stopped or not; the left link is ignored from then on and never arms a reconnect ([hub.md → The hub mode of a connection](hub.md#the-hub-mode-of-a-connection)).
- **Hub server:** one `hubConn` per accepted socket, a fingerprint → link map, each link's announces and owed roster entries, and stream pairs, in memory only ([hub.md → Hub server behaviour](hub.md#hub-server-behaviour-srchubhubjs)).
- **Card import** (`importCard`) notes the announce in memory and writes it to `identities.json` (`imported: true`) under the lock, then, outside the lock, starts a transport `sync()` so the new contact is dialed at once where a hub has it.

## UI build

- `frontend/dist` is gitignored and built by `npm run prepare` (`vite build`), which `npm install` runs.
- `.code-conductor/post-worktree-merge.sh` rebuilds it after a cc merge into the main checkout: `npm run prepare` when the merge changed `frontend/`, `npm install` when it changed `package.json`, nothing when the target is a linked worktree. A build failure prints `BUILD FAILED` as the last line and does not fail the merge.
- A backend restart does not rebuild the UI. A rebuild is live on page reload, because the backend reads `frontend/dist` from disk on each request.
- A merge or pull that did not go through cc needs `npm run prepare` run by hand; until then the page serves the previous build, which can render blank against a changed `api/state`.

## Tests

`npm test` runs `node --test "tests/**/*.test.mjs"` then vitest. Everything is in-process on temp dirs; no live cc and no real `PROJECTS_ROOT`.

| Helper (`tests/helpers.mjs`) | Gives |
|---|---|
| `makeInstall(shareDir, {name, env, schedule, dataDir})` | A whole install (`wire`) with its own temp data dir; the share is polled (and network mode maintained) only when a test calls `engine.sync()`. `rest(method, path, body)` calls its HTTP app as the page does |
| `makeNetwork(names)`, `syncAll`, `connectPersonal` | Announced installs on one share; a sync round; an accepted personal inbox |
| `fakeCc()` | An HTTP fake of `/api/instances`, `/api/plugins`, `/mcp/tools/send_prompt`, `/api/plugins/:id/autostart`, recording every hit; its `env` goes to `makeInstall` |
| `fakeClock()` | `schedule`/`advance`/`now` for the notifier |
| `mcpCall(assert, mcp, tool, args, format)` | Calls a tool and asserts cc's reply contract (json validated against the manifest `outputSchema` with a port of cc's schema subset) |

- `tests/transportContract.test.mjs` runs one contract against the file share, an in-memory push transport (offline peers, outbox, `peerOnline`), and network mode three ways on real loopback sockets: `direct` (node 0 listens, the others connect to it), `hub` (everyone connects to a loopback hub) and `mixed` (both; every pooled session ends direct). An implementation's optional `setup()` / `teardown()` start and stop the hub. A transport without a directory bootstraps as humans do: every node after the first imports node 0's contact card (identity only); routes come from the network settings.
- `tests/tcp.test.mjs` pins the listener and direct-connection invariants (pooling, addressing, handshake refusals and untargeted proofs, limits, outbox, cursors, `mayRead`, strangers never dialed, duplicates, reconnect backoff, listening, settings). `tests/network.test.mjs` pins network mode end to end (peer or hub detection, a far end that is not v2, direct winning the duplicate rule whichever side dialed, moving between hub and direct, hub order, the idle rule, port forwards, shared-inbox reach, settings, stop, `api/state`, inviting strangers seen on a hub or met on a connection). `tests/directory.test.mjs` pins announces in memory only (never logged nor in the data dir, `identities.json`, pins, the directory route, the re-signed own announce). Loopback sockets, port 0, short injected limits and a fake clock for backoff. `tests/netHelpers.mjs` gives `netNode` (an engine in network mode, optionally on a shared endpoint, with injected `connect`, `createServer`, `limits` or a spied `view`) and `relay` (a TCP port forward that records frames); `tests/tcpHelpers.mjs` gives `rawPeer`/`rawConnect` (a raw protocol client), `stubView`, `stubSink`, `countingListener`, `waitFor`, `settle` and `personal`.
- `tests/hub.test.mjs` pins the hub invariants (routing by proven fingerprint, unauthenticated power, proof binding, newest registration wins and `HUB_DUPLICATE`, self-supersession and no reconnect from a left link, re-registering after a duplicate on detach, `HUB_REFUSED` with retries, end-to-end target and writer binding through a lying hub, presence never `peerOnline`, outbox delivery, many clients, least disclosure, no contact list reaching a hub, the roster (newcomer burst, `gone`, a slow reader), announce signatures, framing limits, caps, per-stream back-pressure on both ends, stream caps and control frames that never cost the receiver its link, restart, the standalone import graph). `tests/hubHelpers.mjs` gives `startHub` (a real hub on port 0; `createServer` injection reaches its sockets, e.g. to `cork` one), `rawHubLink` (a raw hub-link client), `tunnelPeer` (a raw endpoint dialing through a stream) and `lyingHub` (a test-only hub on `hubConn` that speaks the roster, misroutes and injects). `tests/hubCli.test.mjs` spawns `node hub.js` with a scrubbed env.
- `tests/outbox.test.mjs` takes the share off its "mount" (renames its dir away and back) and drives the outbox retry timer with a fake clock: owed writes, the boot-time admission, a filesystem error, the timer's arming, and no reconnect storm in network mode.
- `tests/frames.test.mjs` drives the decoder through split and coalesced streams, and `parseFrame` and `parseHubFrame` through every schema violation.
- `tests/concurrency.test.mjs` forks `tests/fixtures/writer.mjs` processes that write one inbox at once.
- `tests/boot.test.mjs` spawns `node server.js` with a scrubbed env.
- `tests/convergence.test.mjs` builds one record set (two removals, a re-add, chains, a fork, a stale write, pre-signed links), then feeds it to fresh readers through `engine.ingest` in fixed and seeded shuffled orders and compares `engine.verdicts(inbox)` with the owner's.
- `tests/recovery.test.mjs` writes a data dir as a crashed backend would leave it (a pending record whose dependency is accepted; an accepted acceptance with no admission) and boots a fresh install from it.
- `frontend/src/test/setup.ts` makes `fetch` a tripwire; UI tests stub it per test.
- `tests/postMergeHook.test.mjs` runs `.code-conductor/post-worktree-merge.sh` in temp git repos with a fake `npm` first on `PATH`: which command runs for which changed paths, the linked-worktree skip, and the failure line.

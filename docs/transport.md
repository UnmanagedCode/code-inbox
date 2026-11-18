# Transports

The engine talks to the network only through the `Transport` interface (`src/transport/index.js`). A transport moves opaque record bytes along routes; it is never trusted with authenticity: the engine verifies, binds and authorizes every record it hands over.

## Interface

```js
/** Route    = {kind:'directory'} | {kind:'mailbox', fp} | {kind:'inbox', id}
 *  Incoming = {route, writer, bytes}   // writer: the fingerprint the transport attributes the record to
 *  Sink     = { record(i: Incoming): Promise<{retry: boolean}>, announce(bytes): void, peerOnline(fp): void }
 *  Transport {
 *    capabilities: { directory: boolean, push: boolean, pull: boolean }
 *    start(sink): Promise<void>
 *    setInterest(routes: Route[]): void    // the routes this install wants delivered (see the delivery-position contract)
 *    setAnnounce(bytes | null): void       // this install's current signed announce
 *    send(bytes, {route, to: fp[]}): Promise<{delivered: fp[], pending: fp[]}>
 *    sync(): Promise<void>                 // pull now / ask online peers to catch up
 *    stop(): Promise<void>
 *    stats?(): object                      // network mode only: diagnostics, read by the engine for display
 *  } */
```

- The engine never looks at paths or sockets. It always passes `to`: the parties or members other than itself, the invitee, or the owner (an `inbox-create`: the contacts; a shared `inbox-delete`: every fp the inbox's records name).
- `capabilities.pull`: peers pull from each other's served logs (`view.serve`), so a record a `send` misses still arrives by pull. The engine relies on it for the owner relay and the outbox keep-set ([Owner relay](#owner-relay)); a transport without it gets neither.
- Recipients in `pending` (or all of them, if `send` throws) go to the outbox, except where the keep-set narrows it ([Owner relay](#owner-relay)); a retryable throw keeps the write itself owed even with no recipient. The outbox is re-sent after every transport start, on the `OUTBOX_RETRY_MS` timer while it holds anything, on `engine.sync()`, and per peer on `peerOnline(fp)` ([architecture.md → Outbox](architecture.md#ingest-pipeline)).
- **Delivery-position contract:** a route that leaves the interest loses its delivery position; if it returns, the transport delivers it from the start. A transport never learns why a route left and never decodes a record. The engine relies on this when a closed inbox is joined again ([protocol.md → Closing an inbox](protocol.md#closing-an-inbox)); the engine itself admits records only on routes of its current interest, so whatever a transport passes just before a route leaves is dropped. Pinned by the contract test "a route that leaves the interest and returns is delivered from the start".
- `record` answers `{retry: true}` only for bytes that may still be arriving (`BAD_JSON`); the transport offers them again later.
- `writer` is what route binding compares with `payload.signer`: the writer subdir on the file share; in network mode the frame's `from`, an identity the remote endpoint proved on that session, directly or in the handshake tunneled through a hub stream (never the hub's word).
- `announce(bytes)` takes a **hub-relayed announce**: no proven session carried it, so the engine accepts it as an announce only, with writer = its own signer, into its memory directory only (the same narrow exception as a card import).
- `setAnnounce(bytes)` is called before `start` and on every **Announce**. A network transport presents it on every session and to every hub; the file share ignores it (the engine writes the announce file).
- `assertTransport` checks the shape of every transport the engine is given (`TRANSPORT_METHODS`).
- `tests/transportContract.test.mjs` runs one contract against every implementation.

### The factory and the engine view

The engine builds its transport with `makeTransport(config, view)` (`server.js` → `transportFactory`):

- `config` is `settings.transport`: `{kind:'file-share', dir}` or `{kind:'network', listen: {host, port} | null, connections: ["host:port", …]}`.
- `view` is a read-only engine object. Its functions are synchronous, read in-memory state and never take the engine lock. The file share ignores it; in network mode the peer is the store, so the transport needs it to serve pulls and to choose whom to dial.

| `view.` | Returns | Source |
|---|---|---|
| `mayPull(peer, route)` | whether to name `route` in a pull from `peer`: the directory, this install's own mailbox, or an inbox `peer` is a party or current member of here | `mayPull` (`src/state.js`) |
| `contacts()` | the dial set: card-imported identities (`identities.json` entries with `imported: true`), counterparties of records this install signed (`to`, `member`), parties and members of every inbox it belongs to | `contactsOf` (`src/state.js`) |
| `serve(reader, route, since, budgetBytes)` | `{status:'ok', recs:[{seq, bytes}], more, head}` or `{status:'denied'}` (no `head`: a denial reveals nothing of what is held) | the engine's served log (`serveLog`), per route, by acceptance seq: the records **signed by this install**, plus, on a shared inbox **this install owns**, every record it accepted there, whoever signed it; **never the reader's own** records. Gated by `mayRead` (`src/state.js`). `head` = the highest acceptance seq. The log never holds an announce, so the `directory` route serves `inbox-create` records only |

- `mayRead(index, reader, route)`: the directory to any proven identity; a mailbox to its owner; a personal inbox to its inviter and invitee; a shared inbox to its current members; nothing else.

### Selecting a transport

One transport at a time, set on the page (`POST api/share` or `POST api/network`). Settings hold `transport: null | {kind:'file-share', dir} | {kind:'network', listen, connections}`.

- **Network settings** are checked by `resolveNetworkConfig` (`src/transport/network.js`): `validateNetworkConfig` (pure), then DNS for every non-literal host, outside the engine lock (a slow resolver blocks no other action), each lookup bounded by `TCP_LOOKUP_MS`. A listen host must resolve, on a save and at boot. A connection host that resolves to every interface is refused; one that does not resolve (or not in time) is refused on a save only: at boot it may be unreachable for now, and the connection keeps retrying. Refusal: `NETWORK_INVALID`. Saving (`setNetwork`) stores the whole config and rebuilds the transport; there is no hot add or remove of a connection.
- A share dir is checked by `checkStoredShareDir`: its path rules (`checkShareDirPath`: absolute, neither inside the data dir nor containing it, as resolved paths), plus the same rule on real paths when the dir resolves (a link into or above the data dir is refused); it is not required to exist or be writable, so a share whose mount is not up yet still starts, its scans pick the directory up once it appears, and writes made meanwhile wait in the outbox until a retry finds its root. A stored share whose root exists but is a link (`code-inbox` or `v1`) is refused `SHARE_UNSAFE`. Saving a share (`setShare`) runs the full `validateShareDir` (also: an existing, writable directory; overlap compared by realpath) and creates the share's root (`ensureShareRoot`).

**The root marker.** A write needs `<share>/code-inbox/v1` (`SHARE_ROOT`) to exist already, and only saving the share creates it. So a mount point that is missing, or an empty directory, takes no write, without comparing devices (a local share dir legitimately shares its parent's device). What the marker proves is only that the root exists, not that the mount is up. A share whose root already exists is unaffected. Not detected: an unmounted mount point that itself holds a `code-inbox/v1` tree on the local disk, whether copied there, written before this rule, or **created by saving the share while its mount was down** (the save cannot tell either; the page says to save with the share mounted). A share saved but never written to by an older version has no root: saving it again creates one.

- **At boot** an invalid stored config starts nothing and shows its refusal in `state().transport.error`: `NETWORK_INVALID`, `SHARE_INVALID`, `SHARE_UNSAFE`, or `TRANSPORT_INVALID` for any other kind. A listener that cannot bind is `LISTEN_FAILED` (on a save: refused 409, and no transport is configured after it). Whenever a transport starts (at boot, or when a human saves one), admissions owed since (`admissionDue`) are written.
- **One mode, never both.** The file share reports every recipient delivered (the share stores everything), so a composite with network mode would drop a network-only peer's outbox entry. Inside network mode, direct and hub routes compose: the pool is keyed by fingerprint.

## File share (v1, `src/transport/fileShare.js`)

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: true, push: false, pull: false}`: the share already stores and forwards, so the owner never relays there |
| `setAnnounce` | Nothing: the engine writes the announce file itself (a directory-route send) |
| `send` | Atomic write under the route's dir in this install's own fingerprint subdir; every `to` is `delivered`. Before each write (`checkWritable`): the share's root `<dir>/SHARE_ROOT` must already exist, else the retryable `SHARE_UNAVAILABLE` and nothing is created; neither the share dir nor its root may resolve into or above the data dir (real paths, re-checked on every write), else `SHARE_UNSAFE`. The route and writer subdirs under the root are created as needed, after a check that their path stays inside the root (`SHARE_UNSAFE` otherwise) |
| Reading | Scans the routes of interest every `SHARE_POLL_MS`; `sync()` scans once. Announce files go to the engine's memory directory, never its log. A route that leaves the interest is forgotten (its files handed over or awaiting a retry, by path prefix), so its next scan after it returns offers every file again |
| `peerOnline` | Never fires |

Layout and filename rules: [protocol.md → Routes and the share layout](protocol.md#routes-and-the-share-layout).

## Network endpoint (`src/transport/network.js`, `endpoint.js`)

Network mode is the endpoint core (`endpoint.js`) with **links**: an optional listener (`listener.js`) and one link per configured connection (`connection.js`). A connection is an address and nothing else: no name, fingerprint or pin. Whoever answers there is detected from its first `hello`: an endpoint (a peer's listener, directly or through a port forward or SSH tunnel) or a hub ([hub.md](hub.md)). Wire format, handshake and limits: [protocol.md → Endpoint wire format](protocol.md#endpoint-wire-format).

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: false, push: true, pull: true}` |
| `send` | A `rec` frame to each recipient with a ready session whose write buffer is under `TCP_WRITE_BUFFER_MAX`: `delivered`. Everyone else is `pending`; a pending recipient in the dial set (contacts, plus a `mailbox` route's fp) is dialed through the hubs in the background |
| `setAnnounce` | Stored per binding; pushed at once on every ready session, and to every hub-mode connection |
| Push | Inbound `rec` frames call `sink.record` when the route is in the addressed identity's interest; otherwise they are dropped and counted |
| `sync()` | Runs `maintain` and awaits it |
| `peerOnline` | Fires for every remote fingerprint when a session becomes ready, on any route |
| `stats()` | `{presence, listening, connections: [status…], sessionCount, handshaking, sessions: [{role, via, address, remote}], handshakeFailures, dropped}` |

### Core and links

- `createEndpoint({makeLinks, limits, now, schedule, syncMs, log})` holds the bindings, sessions, the pool and duplicate rule, `peerOnline`, frame serving (`rec`, `pull`), the announce push, pulls and cursors, the maintain loop and the Transport object. `makeLinks(core)` → the listener (first, at most one), then one connection link per configured address, in configured order.
- `createNetworkEndpoint({listen, connections, connect, createServer, limits, now, schedule, syncMs, log})` → `{attach(binding), stats(), close()}`; `connect` (net.connect) and `createServer` (net.createServer) are injectable (tests). `createNetwork(opts)` = one endpoint with one binding: what `server.js` builds for `{kind:'network'}`.
- `binding = {identity: proofSigner(identity), view, cursors: {load(), save(obj)}}`. The transport only ever holds `signProof` (handshake proofs), never a general `sign`.

  | Link hook | Listener (`listener.js`) | Connection (`connection.js`) |
  |---|---|---|
  | `open()` (every binding start; a rejection fails `start`) | listen | start connecting, unless a hub link is already up or registering with exactly these identities; resolves at once |
  | `identitiesChanged()` (a detach leaving bindings) | — | peer: the session re-handshakes; hub: leave and re-register (clears a `HUB_DUPLICATE` stop) |
  | `shutdown()` (synchronous) | close the server | cancel the timer; close the greeting socket, the peer session or the hub link (`bye STOP`) |
  | `connect()` (maintain step 1) | — | reconnect if due (below) and await an attempt in progress; never waits for a backoff timer |
  | `dial(fp)` | — | hub mode: one stream dial to `fp` |
  | `announceChanged()` | — | hub mode: send the announces again |
  | `present()` | `[]` | hub mode: the fps the hub's roster reports |
  | `status()` | `{listening}` | `{address, kind: 'peer'\|'hub'\|null, state, remote: [fp], error}` |

  The core hands links `lim`, `now`, `schedule`, `log`, `signers()`, `fps()`, `isLocal(fp)`, `contacts()` (every binding's dial set), `hasSession(fp)`, `hasDirectSession(fp)`, `readySessions()`, `canDial()`, `dialHubs(fp)`, `announces()`, `offerAnnounce(bytes)`, `countDropped()`, `accept(socket, {via, link})` (destroys it beyond the caps), `dial(socket, target | null, {via, link, greeted})` and `syncAll()`.
- One endpoint and one pool of sessions serve every identity attached to it. Starting or stopping a binding on a live endpoint closes its sessions: they re-handshake with the new identity set when next needed. A binding's cursors load before its links open.
- `stop()` closes the listener and every connection's timer, socket, session or link **synchronously, before anything is awaited**, and never awaits a pending sink call. Re-saving network settings on the same port therefore rebinds at once, under the engine lock.

### The listener

- Binds `listen.host` (default `127.0.0.1`; a wildcard is allowed: nothing is advertised) on `listen.port` (default `TCP_DEFAULT_PORT`; `0` = ephemeral). A bind failure fails the start: `LISTEN_FAILED`.
- Every accepted socket is an `accept` session with `via: 'direct'`. A listener that fails after it is up is closed (its port freed) and forgotten; its sessions stay.
- `listen: null` opens no port.

### Connections

Each attempt:

1. **Precheck:** a connection whose kind is not known to be a hub needs a free session slot (`canDial()`); a hub link takes none.
2. `connect({host, port})`, then **the greeting** (`greeting.js`): send this install's `hello` (kind `endpoint`) and read the far end's. Anything but a v2 `hello` of a known kind fails the attempt `CONNECTION_PROTOCOL`; nothing within `TCP_HANDSHAKE_MS`, `CONNECTION_TIMEOUT`.
3. **Peer mode** (the far end said `endpoint`): an untargeted `dial` session (`target: null`, `via: 'direct'`) on the greeted socket. It accepts whoever proves there, except this install's own identities (a connection to its own listener fails `CONNECTION_REFUSED`). Up once the session is ready.
4. **Hub mode** (the far end said `hub`): a hub-link client (`hubConn.js`) registers every identity; up on `ok` ([hub.md → The hub mode of a connection](hub.md#the-hub-mode-of-a-connection)).

| After | Then |
|---|---|
| A failed attempt: a socket error, a greeting failure or timeout, a handshake failure, `bye PROOF`, `HUB_REFUSED` | `failures += 1`; reconnect timer after `min(redialMinMs · 2^(failures−1), redialMaxMs)` (`TCP_REDIAL_MIN_MS`, `TCP_REDIAL_MAX_MS`); `state: 'waiting'`, `error` set |
| An attempt that reached ready (peer) or `ok` (hub) | `failures = 0`, `error = null`, `state: 'up'` |
| An up connection ends | reconnect after `redialMinMs`, except in the next two rows |
| Peer mode: the session closed as the duplicate loser, or at its close every fp it reached has a direct session | `state: 'idle'`: no timer; maintain step 1 reconnects it once one of those fps lacks a **direct** session |
| Hub mode: `bye DUPLICATE` on the current link | `state: 'stopped'`, `HUB_DUPLICATE`; no reconnect until a binding attaches or detaches (a settings save rebuilds the endpoint) |
| `shutdown()` | nothing is armed |

- Timers use the injected `schedule` and `now`. A connection's reconnects never depend on contacts: whoever is at the address becomes reachable, strangers and hubs included.
- **Errors** on a connection's row (never a REST refusal: connecting is asynchronous): a socket code (`ECONNREFUSED`, `ENOTFOUND`, …), `CONNECTION_TIMEOUT`, `CONNECTION_PROTOCOL` (not a v2 hello, a `bye` before it, or the handshake broke the protocol), `CONNECTION_REFUSED` (a `PROOF` refusal either way), `CONNECTION_LIMIT` (no session slot when the greeting ended), `CONNECTION_CLOSED` (the far end closed during the handshake), `HUB_REFUSED`, `HUB_DUPLICATE`.
- Two connections that reach the same hub register the same identities: the later registration wins and the other shows `HUB_DUPLICATE`.

### Pooling and duplicates

- The pool maps each remote fingerprint to one ready session. Two endpoints share one session for all of their identities. Each session records `via` locally: `direct` (accepted on the listener, or a connection's peer dial) or `hub` (a hub stream, either way).
- **Duplicate rule** (`keeps`): when a session becomes ready for a fingerprint that already has one, the session kept is the **direct** one if the two differ in route; otherwise the one whose dialer's smallest proven fingerprint sorts lowest; on a tie, the older. Only the losing session's dialer closes it (`bye DUPLICATE`).
- Both ends agree without a further message: a port forward or an SSH tunnel is a TCP socket at both ends, and a hub stream is a hub stream at both ends, so both ends classify a session the same way.
- When a pooled session closes, the best remaining ready session proving that fingerprint (by the same rule) takes its place.
- With a hub session up and the direct route back, the direct session wins and the hub session's dialer closes it: a contact moves back to direct.

### Dial policy

- **Maintain** runs at `start`, every `syncMs` (`TCP_SYNC_MS`) and on `sync()`; per binding, maintain runs and pulls queue behind each other and never overlap:
  1. bring due connections up and await them (`connect()` on every link);
  2. dial each contact still without a session through the first hub-mode connection, in configured order, whose roster shows it present and that is not backing off for it (`dialHubs(fp)`);
  3. pull from every remote fingerprint on every session the routes of interest it could serve.
- A roster `peer` notice for a contact without a session triggers `dialHubs(fp)` at once.
- **Strangers** (a non-contact that dialed in, was met on a connection, or is on a hub's roster) are served (`mayRead`), pulled from (`mayPull`) and receive what is addressed to them, and are listed in the directory with where they are present. Maintain never dials one, and a roster notice never does. A human's invite makes it a counterparty, and so a contact: the invite itself goes out on a live session, or through the first hub that has it (a `mailbox` route's fp is dialable).
- A hub stream dial is per (hub, fp): a failure (an `ABSENT` or `LIMIT` close, or a failed handshake) backs that fp off on that hub from `redialMinMs`, doubling to `redialMaxMs`; a roster `peer` notice resets it.
- Caps: `TCP_MAX_CONNECTIONS` sessions in all, `TCP_MAX_HANDSHAKING` handshaking, whatever the route; `CONNECTIONS_MAX` configured connections. An inbound socket or stream beyond a cap is destroyed at accept; no dial starts beyond the total.

### Announces, pulls and cursors

- **On session ready:** each side pushes each binding's announce to each remote fp (`rec` on the `directory` route; `from` is proven, so the writer is bound), then `peerOnline(fp)` for every remote fingerprint and local binding, then a (scoped) pull of that binding's interest from it. **Announce** pushes the new announce on every ready session.
- **Scoped pulls:** a pull names only the routes `view.mayPull(peer, route)` allows, judged by this install's own state: the directory, this install's mailbox, and an inbox only when the peer is a party of that personal inbox or a current member of that shared inbox. A pull names no route key the peer has no part in. The directory carries this install's `inbox-create` and shared `inbox-delete` records (shared inbox ids and names) to any peer that pulls it (personal inbox ids are never in the directory).
- **New routes:** `setInterest` schedules (never awaits; it runs under the engine lock) a pull of each newly added route from every session.
- **A pull** asks for the records the remote identity serves on each route (`view.serve` on its side: its own records, and on a shared inbox it owns every record it accepted there, except the asker's own) with seq > the cursor, loops while a route answers `more`, and stops if an answer makes no progress. Each record is offered with writer = that remote identity.
- **Cursors** are per (peer fp, route key), over the peer's acceptance seqs of what it serves on that route, persisted in `pull-cursors.json`. No frame names a signer: a member keeps one cursor on (owner, `inbox:<id>`) covering every signer, plus its own cursors on (co-member, `inbox:<id>`) for direct pulls of that co-member's records. A file under any other name is never read. A cursor moves only once its batch has been offered to the sink, and only on pull answers, never on pushes, so a push gap cannot skip records. A `denied` route keeps its cursor: pulling an inbox before being admitted does not skip its history. A server answering `head` < cursor (its data was reset) resets the cursor to 0. **A route that leaves the interest loses its cursors** (for every peer): dropped in memory and in `pull-cursors.json` at `setInterest`, pruned from the file at start, and never set again by a pull answer still in flight, so it is pulled from 0 if it returns.
- **Delivered** means written to a ready session under the write-buffer cap; `send` never waits for the flush because it runs under the engine lock. A frame lost on a dying socket is recovered by the pull on reconnect and by the periodic pull.

### Owner relay

The group of a shared inbox is a star around its owner: members connected only to the owner receive each other's messages through it.

- **Served log:** on a shared inbox it owns, the owner serves every record it accepted on that route (its own, and its members' `msg` records), never the reader's own (no echo to the author). Everywhere else an install serves only its own records.
- **Live push:** when the owner accepts a co-member's `msg` on an inbox it owns (pushed, pulled or drained from pending), it `send`s it to every current member except itself and the author, with `from` = the owner. Best-effort: a member without a live session is not put in the outbox; its next pull (on session ready, on maintain) fetches the record from the owner's served log. Only a record newly accepted is relayed, so a second arrival triggers nothing.
- **Keep-set:** a non-owner's shared `msg` is still sent to every current member (direct pushes stay live), but the outbox keeps only the **owner** if it is pending (plus an owed write). A co-member a member never meets is never retried.
- Both apply only where `capabilities.pull` is true (network mode). The file share stores everything and does not relay; a push transport without pulls keeps "send to all, outbox to all".
- **Who receives what** (`mayRead`): a current member gets pushes and pulls the whole served log from its cursor; a new member pulls the inbox's full history, a removed member's kept messages included; a re-added member gets everything after its kept cursor; a removed or not-yet-admitted member is `denied` (its cursor kept) and gets no relay pushes.
- **A purge** of a closed inbox removes its records from the served log too ([protocol.md → Closing an inbox](protocol.md#closing-an-inbox)): what is servable is fixed at acceptance except for a purge.
- The owner serves every record it accepted on the route, including ones no longer valid (a removed member's off-chain messages accepted before the removal), so readers hold the same records and reach the same verdicts.

### Route binding

- **The writer is the proven `from`.** `Incoming.writer` is the frame's `from`, which must be an identity the remote proved on that session (any other `from` closes the session). The engine checks `routeFor(payload) === route` and `payload.signer === writer`, with one exception: **the owner relay**. A record signed by someone else is accepted only when `mayRelay(index, writer, route, payload)` holds: the payload is a `msg`, the route is a shared inbox, and that inbox's owner, by this install's own state, is `writer`. Every other third-party record is refused `ROUTE_MISMATCH`. The exception is not self-certifying: it needs a session-proven `from` that owns the inbox here, and it applies on any transport (the file share never exercises it).
- **Two self-certifying exceptions, announces only, into memory only:** a contact-card import (`engine.importCard`) and a hub-relayed announce (`sink.announce`). The writer is the announce's own signer; anything but an announce is refused.
- **Least disclosure:** no *frame* asks about, or names, any identity other than the session's two proven parties. The *records* served on a shared inbox may be co-members' records, but only to a current member (`mayRead`), who already sees the member list. A session serves only records its proven `from` may read; pulls name only routes the peer could serve (`mayPull`); a denial carries no head.

### Known limitations

- **Both ends must be online at once** (or the sender keeps the record in its outbox until the recipient reconnects), except a shared inbox's members, whose records the owner relays: a member only needs to reach the owner.
- **A shared inbox depends on its owner.** The owner can withhold records (skip, delay, or serve some members and not others); it can never forge, alter or re-route one.
- **Plaintext, loopback by default** (below).

### Network security

1. **Trust assumption (owner ruling).** Peers, hubs, connection targets and strangers on a hub are trusted parties. No defence is designed against their abuse: no rate limits, no presence anti-spoofing, no announce-forgery handling beyond the signature check.
2. **Kept:**
   - every record and announce is signature-verified (`decodeRecord` on every path; hubs and clients both decode announces);
   - the writer is the proven `from`, end to end on every route, with one exception: the owner relay (`mayRelay`: a `msg` on a shared inbox whose owner here is the writer); the two self-certifying exceptions (card import, hub-relayed announces) take announces only, into memory only;
   - `mayRead` and `mayPull`, and head-less denials;
   - the handshake proofs (below), with direct dials untargeted;
   - every cap: sessions, handshakes, hub links, streams and buffers, per-stream back-pressure, frame sizes and deadlines;
   - the loopback listener default; `POST api/network` behind the mutating-request guard;
   - `stop()` synchronous under the lock.
3. **Handshake.** Each side contributes a fresh 32-byte nonce per connection and both are signed, so a proof recorded on one connection fails on any other; a role label (`dial`, `accept`, `hub`) stops one kind of proof being presented as another; `PROOF_DOMAIN` differs from the record domain. The dialer proves first and the acceptor signs nothing before that proof verifies. The acceptor's proof is bound to the dialer's proven fingerprints. A targeted dial (a hub stream: `target` = the fp it means to reach) is bound to its target, and the dialer refuses an acceptor that does not prove it: a misrouting hub gets no session. A direct dial is untargeted (`target: null`, bound `''`): a connection names no fingerprint.
4. **Still exposed:**
   - **Plaintext:** anyone on the path reads every record (bodies, names, membership, proven fingerprints) and timing, and can drop or inject frames; an injected frame cannot forge a record, and drops are recovered by the outbox and pulls.
   - **A listener reveals its fingerprints:** a direct dial is untargeted, so anyone who reaches a listener and proves any key gets the listener's accept proof: which fingerprints sit behind that address. That stranger is then a proven non-contact: it reads the public directory (`inbox-create` names and ids) and may push its announce and mailbox records to this install, as any reachable party can.
   - **A connection target can relay a session live** (a port forward does exactly that honestly): an on-path relay sees, drops or injects frames, and an injected `pull` reads whatever the far peer serves this install. It can never forge a record or a `from`.
   - **The owner of a shared inbox** can withhold its members' records: skip, delay, or serve some members and not others. It can never forge or alter one (every record is signature-verified, its id is the hash of its payload, and `inbox`, `signer` and `prev` are signed) nor re-route one (`sameRoute`, and `mayRelay` only for an inbox the writer owns here). A gap shows: a member's later message whose `prev` was withheld stays pending (`PREV_UNSEEN`, `diagnostics.pending`), and validity is prefix-closed, so nothing built on the gap becomes valid. The owner already controlled membership; relaying grants it no power over which messages are valid.
   - **Hubs:** [hub.md → Hub security](hub.md#hub-security). Every client on a hub sees every other client's fingerprint, name and online times; a hub never receives a contact list.
   - **Invites:** anyone who can reach this install (on a common hub, or over a connection) can invite it. Invites are human-gated (Accept or Decline); there is no rate or volume limit.
5. **In scope:** peer-supplied names (`NAME_RE`) and fingerprints render only as React text; presence addresses are the user's own saved strings. The REST guard covers `POST api/network` and every invite route. Realistic input: the caps above, the hub roster's coalescing, `ANNOUNCE_MAX_BYTES`.

### File-share write safety

- Every write checks, in order: the share's root exists (`SHARE_UNAVAILABLE`) and neither `code-inbox` nor `v1` is a link (`rootState`, `SHARE_UNSAFE`); the share dir and its root do not resolve into or above the data dir (`SHARE_UNSAFE`); the route's path stays inside the root, lexically, before anything is created (`SHARE_UNSAFE`). The share dir itself may be a link (a mount or a local alias); nothing below it may be.
- The route and writer subdirs are created one component at a time (`mkdirsInside`), each checked before anything is created under it: a component that is a symlink, or resolves outside the root, is refused `SHARE_UNSAFE`. A link a peer plants anywhere in the share (`code-inbox`, `v1`, `inboxes`, `inboxes/<id>`, a writer subdir) creates and writes nothing outside it. The same `rootState` rule refuses a root that is a link when the share is saved (before the root is created), at boot (a stored share whose root is a link starts nothing: `SHARE_UNSAFE` in `state().transport.error`), and on every write.
- Right before the record is written, the writer subdir's real path is checked once more against the root's.
- **Remaining race:** a check and the next `mkdir` or write are separate system calls, so a component swapped for a link in between can still get one empty directory created, or one record file written, through the link. Only someone who already controls the share's contents can do it, and the write is a no-overwrite (exclusive tmp + rename to a fresh random name) of this install's own signed record, which is published anyway.

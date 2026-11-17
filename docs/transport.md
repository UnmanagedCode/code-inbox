# Transports

The engine talks to the network only through the `Transport` interface (`src/transport/index.js`). A transport moves opaque record bytes along routes; it is never trusted. Every record it hands over goes through `decodeRecord`, route binding and `state.classify` like any other.

## Interface

```js
/** Route    = {kind:'directory'} | {kind:'mailbox', fp} | {kind:'inbox', id}
 *  Incoming = {route, writer, bytes}   // writer: the fingerprint the transport attributes the record to
 *  Sink     = { record(i: Incoming): Promise<{retry: boolean}>, peerOnline(fp): void }
 *  Transport {
 *    capabilities: { directory: boolean, push: boolean }
 *    addresses(): string[]                 // goes into announce.addr (rendezvous)
 *    start(sink): Promise<void>
 *    setInterest(routes: Route[]): void    // the routes this install wants delivered
 *    send(bytes, {route, to: fp[]}): Promise<{delivered: fp[], pending: fp[]}>
 *    sync(): Promise<void>                 // pull now / ask online peers to catch up
 *    stop(): Promise<void>
 *  } */
```

- The engine never looks at paths or sockets. It always passes `to`: the parties or members other than itself, the invitee, or the owner (directory records: every known identity).
- Recipients in `pending` (or all of them, if `send` throws) go to the outbox; a retryable throw keeps the write itself owed even with no recipient. The outbox is re-sent after every transport start, on the `OUTBOX_RETRY_MS` timer while it holds anything, on `engine.sync()`, and per peer on `peerOnline(fp)` ([architecture.md → Outbox](architecture.md#ingest-pipeline)).
- `record` answers `{retry: true}` only for bytes that may still be arriving (`BAD_JSON`); the transport offers them again later.
- `writer` is what route binding compares with `payload.signer`: the writer subdir on the file share, the frame's proven `from` over TCP.
- `assertTransport` checks the shape of every transport the engine is given.
- `tests/transportContract.test.mjs` runs one contract against every implementation.

### The factory and the engine view

The engine builds its transport with `makeTransport(config, view)` (`server.js` → `transportFactory`):

- `config` is `settings.transport`: `{kind:'file-share', dir}` or `{kind:'tcp', host, port, advertise}`.
- `view` is a read-only engine object. Its functions are synchronous, read in-memory state and never take the engine lock. The file share ignores it; over TCP the peer is the store, so the transport needs it to serve pulls and to choose whom to dial.

| `view.` | Returns | Source |
|---|---|---|
| `addrsOf(fp)` | `string[]`: the `addr` of `fp`'s current announce (shown or not), else `[]` | `directory()` |
| `announceFor(requester, fp)` | the bytes of `fp`'s current announce if `requester` and `fp` share an inbox here, else `null` | `sharesInbox` (`src/state.js`), then `directory()` identity `id` → the engine's announce bytes |
| `mayPull(peer, route)` | whether to name `route` in a pull from `peer`: the directory, this install's own mailbox, or an inbox `peer` is a party or current member of here | `mayPull` (`src/state.js`) |
| `contacts()` | the dial set: card-imported identities (`contacts.json`), counterparties of records this install signed (`to`, `member`), parties and members of every inbox it belongs to | `contactsOf` (`src/state.js`) |
| `serve(reader, route, since, budgetBytes)` | `{status:'ok', recs:[{seq, bytes}], more, head}` or `{status:'denied'}` (no `head`: a denial reveals nothing of what is held) | the engine's log of records **signed by this install**, per route, by acceptance seq; gated by `mayRead` (`src/state.js`). `head` = the highest acceptance seq |

- `mayRead(index, reader, route)`: the directory to any proven identity; a mailbox to its owner; a personal inbox to its inviter and invitee; a shared inbox to its current members; nothing else.
- `sharesInbox(index, a, b)`: `a` and `b` are the two parties of a personal inbox, or both current members of a shared inbox, as this install knows them.

### Selecting a transport

A stored transport is checked at boot. A TCP config is checked as when it was saved (`resolveTcpConfig`, DNS included). A share dir is checked by `checkStoredShareDir`: its path rules (`checkShareDirPath`: absolute, neither inside the data dir nor containing it, as resolved paths), plus the same rule on real paths when the dir resolves (a link into or above the data dir is refused); it is not required to exist or be writable, so a share whose mount is not up yet still starts, its scans pick the directory up once it appears, and writes made meanwhile wait in the outbox until a retry finds its root. Saving a share (`setShare`) runs the full `validateShareDir` (also: an existing, writable directory; overlap compared by realpath) and creates the share's root (`ensureShareRoot`).

**The root marker.** A write needs `<share>/code-inbox/v1` (`SHARE_ROOT`) to exist already, and only saving the share creates it. So a mount point that is missing, or an empty directory, takes no write, without comparing devices (a local share dir legitimately shares its parent's device). What the marker proves is only that the root exists, not that the mount is up. A share whose root already exists is unaffected. Not detected: an unmounted mount point that itself holds a `code-inbox/v1` tree on the local disk, whether copied there, written before this rule, or **created by saving the share while its mount was down** (the save cannot tell either; the page says to save with the share mounted). A share saved but never written to by an older version has no root: saving it again creates one. An invalid stored config starts nothing and shows its refusal (`TCP_INVALID`, `SHARE_INVALID`, `TRANSPORT_INVALID` for an unknown kind) in `state().transport.error`; so does a TCP listener that cannot bind (`TCP_LISTEN_FAILED`). Whenever a transport starts (at boot, or when a human saves one), admissions owed since (`admissionDue`) are written.

One transport at a time, set on the page (`POST api/share` or `POST api/tcp`). Settings hold `transport: null | {kind:'file-share', dir} | {kind:'tcp', host, port, advertise}`.

- The file share reports every recipient delivered (the share stores everything), so a composite with TCP would drop a TCP-only peer's outbox entry.
- Route binding requires writer = signer on the share and writer = the proven `from` over TCP, so an install could not relay between the two groups anyway.
- Consequence: installs on the file share and installs on TCP cannot reach each other. A group picks one medium.

## File share (v1, `src/transport/fileShare.js`)

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: true, push: false}` |
| `addresses()` | `[]` |
| `send` | Atomic write under the route's dir in this install's own fingerprint subdir; every `to` is `delivered`. Before each write (`checkWritable`): the share's root `<dir>/SHARE_ROOT` must already exist, else the retryable `SHARE_UNAVAILABLE` and nothing is created; neither the share dir nor its root may resolve into or above the data dir (real paths, re-checked on every write), else `SHARE_UNSAFE`. The route and writer subdirs under the root are created as needed, after a check that their path stays inside the root (`SHARE_UNSAFE` otherwise) |
| Reading | Scans the routes of interest every `SHARE_POLL_MS`; `sync()` scans once |
| `peerOnline` | Never fires |

Layout and filename rules: [protocol.md → Routes and the share layout](protocol.md#routes-and-the-share-layout).

## Direct TCP (`src/transport/tcp.js`)

Wire format, handshake and limits: [protocol.md → TCP wire format](protocol.md#tcp-wire-format).

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: false, push: true}` |
| `addresses()` | `[tcp://<advertise>:<bound port>]` once listening, else `[]` |
| `send` | A `rec` frame to each recipient with a ready session whose write buffer is under `TCP_WRITE_BUFFER_MAX`: `delivered`. Everyone else is `pending`; pending recipients in the dial set are dialed in the background |
| Push | Inbound `rec` frames call `sink.record` when the route is in the addressed identity's interest; otherwise they are dropped and counted |
| `sync()` | Runs `maintain` and awaits it |
| `peerOnline` | Fires for every remote fingerprint when a session becomes ready |
| No directory | Identities find each other through contact cards (a signed announce pasted on the page) and the announces pulled at every handshake |

### Endpoint and bindings

- `createTcpEndpoint({host, port, advertise, limits, now, schedule, syncMs, log})` → `{attach(binding), stats(), close()}`. One listener and one pool of sessions serve every identity attached to it. `createTcp(opts)` = one endpoint with one binding: what `server.js` uses.
- `binding = {identity: proofSigner(identity), view, cursors: {load(), save(obj)}}`. The transport only ever holds `signProof` (handshake proofs), never a general `sign`.
- The listener starts on the first `start()`. Starting or stopping a binding on a live endpoint closes its sessions: they re-handshake with the new identity set when next needed.
- `stop()` closes the listener **synchronously, before anything is awaited**, then every socket, and never awaits a pending sink call. Re-saving TCP settings on the same port therefore rebinds at once, under the engine lock.
- `stats()` → `{listening, connections, handshaking, sessions: [{role, remote: [fp]}], handshakeFailures, dropped}`. The Transport object exposes it too (tests and the multi-identity checks use it).
- `validateTcpConfig({host, port, advertise})`: host an IP literal or hostname (default `127.0.0.1`); port an integer 0–65535 (default `TCP_DEFAULT_PORT`; 0 = ephemeral); `advertise` defaults to host and is required (and must not be a wildcard) when host is a wildcard. Wildcards are decided on the parsed address (`isWildcardHost`): `0.0.0.0` and every spelling of `::` (`::0`, `0:0:0:0:0:0:0:0`, `::ffff:0.0.0.0`, …). Otherwise `TCP_INVALID`. Pure.
- `resolveTcpConfig(input)`: `validateTcpConfig`, then a host or advertised host that is not an IP literal is looked up (`dns.lookup`, every address) and refused `TCP_INVALID` if any address is a wildcard: `0`, `00.0.0.0` and `0x0.0.0.0` pass as hostnames but resolve to `0.0.0.0`. A listen host that does not resolve is refused `TCP_INVALID`; an advertised host that does not resolve here is allowed (peers may resolve it where this install cannot). A lookup that does not answer within `TCP_LOOKUP_MS` is refused `TCP_INVALID`, for either name. `setTcp` resolves before it takes the engine lock, so a slow resolver blocks no other action; the boot check uses it too.

### Pooling and duplicates

- The pool maps each remote fingerprint to one ready session. Two endpoints share one session for all of their identities.
- **Duplicate rule:** when a session becomes ready for a fingerprint that already has one, the session kept is the one whose dialer's smallest proven fingerprint sorts lowest; on a tie, the older. Only the losing session's dialer closes it (`bye DUPLICATE`), so both sides agree without a further message.
- When a pooled session closes, another ready session proving that fingerprint takes its place.

### Dial policy

- The transport dials only `view.contacts()` and the `fp` of a `mailbox` route it is sending on. It never dials a stranger whose announce arrived on an inbound session; that stranger still gets records over its live session, and through the outbox when it reconnects.
- Addresses: the `tcp://` entries of `view.addrsOf(fp)`, plus whois hints (below). Other schemes are ignored.
- Dials are deduplicated per address. A failed dial (refused, or a handshake that does not complete) backs that address off from `TCP_REDIAL_MIN_MS`, doubling up to `TCP_REDIAL_MAX_MS`; a successful handshake resets it. Backoff is clock-based: nothing redials until a send or `maintain` asks.
- Caps: `TCP_MAX_CONNECTIONS` total, `TCP_MAX_HANDSHAKING` handshaking. An inbound socket beyond either is destroyed at accept; no dial starts beyond the total.

### Maintain, pulls and cursors

`maintain` runs at `start`, every `syncMs` (`TCP_SYNC_MS`) and on `sync()`. Per binding, maintain runs and pulls queue behind each other and never overlap.

1. **Whois:** for every contact without a session and without any address, ask every connected session for its announce.
2. **Dial** contacts without a session (backoff permitting), awaiting each handshake.
3. **Pull** from every remote fingerprint on every session the routes of interest it could serve.

- **Scoped pulls:** a pull names only the routes `view.mayPull(peer, route)` allows, judged by this install's own state: the directory, this install's mailbox, and an inbox only when the peer is a party of that personal inbox or a current member of that shared inbox. A pull names no route key the peer has no part in. The directory itself is public, though: it still carries this install's `inbox-create` records, so their shared inbox ids and names reach any peer that pulls it (personal inbox ids are never in the directory).
- **On session ready:** `peerOnline(fp)` for every remote fingerprint and local binding, then a (scoped) pull of that binding's interest from it. The directory is always pulled, so this is the announce exchange at the handshake.
- **New routes:** `setInterest` schedules (never awaits; it runs under the engine lock) a pull of each newly added route from every session.
- **A pull** asks for records signed by the remote identity on each route with seq > the cursor, loops while a route answers `more`, and stops if an answer makes no progress.
- **Cursors** are per (peer fp, route key), persisted in `peer-cursors.json`. A cursor moves only once its batch has been offered to the sink, and only on pull answers, never on pushes, so a push gap cannot skip records. A `denied` route keeps its cursor: pulling an inbox before being admitted does not skip its history. A server answering `head` < cursor (its data was reset) resets the cursor to 0.
- **Delivered** means written to a ready session under the write-buffer cap; `send` never waits for the flush because it runs under the engine lock. A frame lost on a dying socket is recovered by the pull on reconnect and by the periodic pull.

### Route binding over TCP

- **The writer is the proven `from`.** `Incoming.writer` is the frame's `from`, which must be an identity the remote proved on that session (any other `from` closes the session). The engine still checks `payload.signer === writer` and `routeFor(payload) === route`. A peer therefore pushes and serves only records it signed itself; a relayed third-party record is refused `ROUTE_MISMATCH`, like a file in the wrong share subdir.
- **Contact-card import** is the one path where the writer is not a transport identity: `engine.importCard` accepts only an `announce` and ingests it with route `directory` and writer = its signer. Every other check still runs.
- **Whois answers only for a shared inbox.** A peer asking about `fp` gets `fp`'s announce only if the two share an inbox on this install (`view.announceFor`): the member-discovery case. Anything else is answered with nothing, so whois is no oracle for this install's contacts or third parties' addresses.
- **Whois hints are never ingested.** A `cards` reply is used only for the `tcp://` addresses of announces that decode, are `announce`s, and are signed by a fingerprint that was asked for. The engine receives that identity's announce from the identity itself, by the pull after the handshake. A forged or mismatched hint is dropped; a hint pointing at the wrong place fails the handshake proof.

### Known limitations

- **A member's records come only from that member.** A shared-inbox message reaches a member that was offline when it was sent only once that member and the message's author are online at the same time; another member or the owner cannot pass it on. A removed member is no longer pulled from, so a member who joins after a removal never receives the removed member's earlier messages.
- **Both ends must be online at once** (or the sender keeps the record in its outbox until the recipient reconnects).
- **Plaintext, loopback by default** (below).

### TCP security

1. **Open port, default binding.**
   - The listener binds `127.0.0.1` unless a human saves a non-loopback host; the page warns when the host is not loopback. A wildcard host needs an explicit advertised host.
   - `POST api/tcp` sits behind the mutating-request guard (`Sec-Fetch-Site`/`Origin`, JSON only). Like every REST route, any local process can call it.
2. **Plaintext, by design.** An on-path observer reads every record (bodies, names, membership, proven fingerprints), sees which identities share an endpoint and when installs pull. The advertised host is in the signed, public announce. With no session keys there is **no per-frame authentication after the handshake**: an on-path attacker can drop or inject frames. An injected frame cannot forge a record (every record still passes `decodeRecord`, route binding and `classify`); an injected `pull` only makes the server send records into a stream the attacker already reads. Drops are recovered by the outbox and by pulls.
3. **Framing limits.**
   - The frame size limit depends on the phase (`TCP_HELLO_FRAME_MAX` before ready, `TCP_FRAME_MAX` after) and is enforced from the 4-byte header, before the body is buffered.
   - Every frame has an exact schema; anything else closes the session.
   - Deadlines: the whole handshake within `TCP_HANDSHAKE_MS`; a started post-ready frame within `TCP_FRAME_MS`; nothing received for `TCP_IDLE_MS` closes. Together they bound slowloris and partial frames.
   - The inbound queue pauses the socket at `TCP_INBOUND_QUEUE` frames; more than `TCP_WRITE_BUFFER_MAX` unflushed bytes destroys it.
   - Connection caps (`TCP_MAX_CONNECTIONS`, `TCP_MAX_HANDSHAKING`) bound memory. There is no per-IP fairness: availability against a hostile flooder is out of scope.
4. **Handshake replay and binding.**
   - Each side contributes a fresh 32-byte random nonce per connection and both are signed, so a proof recorded on one connection fails on any other. No clock is involved.
   - A role label stops a dial proof being presented as an accept proof, and the reverse.
   - The dialer's proof names the **target fingerprint**; the acceptor's names the **dialer's fingerprints**. If M gets A to dial M and replays A's proof to B, the proof names M as its target and M is not attached at B, so B refuses. M cannot reuse B's accept proof either: it is bound to M's own fingerprints. The dialer also refuses an acceptor that does not prove the target it dialed.
   - `PROOF_DOMAIN` differs from the record domain: no handshake signature is ever a record signature.
   - The transport holds only `signProof`. A remote proving one of this endpoint's own fingerprints is refused.
5. **What an unauthenticated connection can make the process do:** take one connection slot and one handshake slot; generate one 32-byte nonce and write one `hello` (about 100 bytes); buffer at most `TCP_HELLO_FRAME_MAX`; parse at most three small JSON frames; run up to `TCP_MAX_IDENTITIES` Ed25519 verifies. It cannot cause any signing, any sink or engine call, any disk write, any dial, or a log line (failures are counted in `stats().handshakeFailures`). It learns nothing about the identities served, because the acceptor proves second.
6. **Authority after the proof.**
   - The writer is the proven `from`: pushes and pulls carry only the sender's own records.
   - A `pull` is gated by `mayRead`: inbox records go only to its parties or current members, a mailbox only to its owner. This is least privilege, not confidentiality (see 2).
   - Pushes on routes outside the addressed identity's interest are dropped, as the share reads only routes of interest.
   - `whois` is answered only about identities the requester shares an inbox with here; replies never reach the engine. Card import accepts only announces.
   - Pulls name only routes the peer could serve by this install's state (scoped pulls): a pull names no route key the peer has no part in, and a denied answer carries no `head`, so it reveals nothing of how many records are held. The public directory still carries this install's `inbox-create` records (shared inbox ids and names), served to any proven peer.
7. **Dial-hint residue.** A dial address comes from an announce: one a contact signed (pulled from it or imported from its card), or one fetched by `whois` and signed by the contact asked about. Such an address can name any host and port. So **an identity in the dial set (an inbox owner or member, a card a human imported, a counterparty) can steer this process into a TCP connect to an address of its choosing.** What leaves the process on such a connection:
   - at once, `hello`: the protocol version and a fresh random nonce;
   - as soon as anything answers with a well-formed `hello`, the dialer's `prove`: the target fingerprint, the raw public key of **every identity attached to the endpoint**, and per key a signature over `PROOF_DOMAIN` ‖ `["dial", dialer nonce, answerer nonce, target]`. The listener at the steered address learns which identities share this endpoint.
   - nothing else: no record, route, or other frame is sent before the answerer proves the target identity in its own `prove`.

   The signatures cannot be reused: each is bound to this connection's two nonces (any other acceptor contributes a different nonce), to the `dial` role (never valid as an accept proof), to the target fingerprint (refused by any endpoint where that identity is not attached), and to `PROOF_DOMAIN` (never a record signature). What bounds the residue:
   - only identities in the dial set can do it; a stranger's announce never causes a dial (dial policy);
   - each address is dialed at most once per backoff period, so a failing target is retried at most at the backoff schedule;
   - the steering identity already knows the target fingerprint; with one identity per install (production), the public key it learns is the install's own, published in its announce anyway.

### File-share write safety

- Every write checks, in order: the share's root exists (`SHARE_UNAVAILABLE`); the share dir and its root do not resolve into or above the data dir (`SHARE_UNSAFE`); the route's path stays inside the root, lexically, before anything is created (`SHARE_UNSAFE`).
- The route and writer subdirs are created one component at a time (`mkdirsInside`), each checked before anything is created under it: a component that is a symlink, or resolves outside the root, is refused `SHARE_UNSAFE`. A link a peer plants anywhere in the share (`inboxes`, `inboxes/<id>`, a writer subdir) creates nothing outside it. Saving the share creates its root the same way: a `code-inbox` or `v1` that is a link, or resolves outside the share or into the data dir, is refused `SHARE_UNSAFE`.
- Right before the record is written, the writer subdir's real path is checked once more against the root's.
- **Remaining race:** a check and the next `mkdir` or write are separate system calls, so a component swapped for a link in between can still get one empty directory created, or one record file written, through the link. Only someone who already controls the share's contents can do it, and the write is a no-overwrite (exclusive tmp + rename to a fresh random name) of this install's own signed record, which is published anyway.

## Sketched follow-up (not built): hub client (`hubClient.js`)

| Interface concern | Hub client |
|---|---|
| Addressing | Registers the fingerprints it serves with the hub, proving each with a challenge signature. The hub forwards by recipient fingerprint only |
| `addresses()` / `announce.addr` | `hub+wss://host/` (rendezvous) |
| `send(..., {to})` | Recipients the hub reports offline are `pending`. The hub stores nothing |
| Offline peers | Engine outbox + `peerOnline` from the hub's presence notices |
| Push vs poll | `push: true` |
| No global listing | `directory: false`, same contact cards as TCP |
| `sync()` | Same pulls as TCP, through the hub to online peers |
| Trust | The hub is never trusted for authenticity. Replays are deduplicated by record id; drops are recovered by the outbox and `sync` |

**What it reuses from TCP:** `frames.js`, `handshake.js` and `tcpSession.js` unchanged. Every session frame carries `from`/`to` fingerprints, so a routing-only hub forwards `rec`/`pull`/`recs`/`whois`/`cards` by `to` without parsing records. A client proves its identities to the hub with the same `prove` (role `dial`, target = the hub's fingerprint). Per-peer cursors, `view.serve`, `mayRead`, the dial policy and the outbox/`peerOnline` contract carry over.

**What it must decide:** through a hub, `from` is attested only by the hub, so writer binding degrades to "the hub says"; signatures are unaffected. The fix is to tunnel the endpoint-to-endpoint `hello`/`prove`/`ok` as frames addressed through the hub; the frame format already allows it.

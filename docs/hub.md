# Hub

A hub is a standalone router for installs that cannot reach each other directly (behind NAT, across networks). Every install dials out to the same hub, proves its fingerprints on that connection, and opens **streams** to other fingerprints through it. The unchanged endpoint handshake (`hello` / `prove` / `ok`, [protocol.md → Handshake](protocol.md#handshake)) and every session frame run inside a stream, so:

- the writer of a record is still the `from` the **remote endpoint** proved, never the hub's word;
- the hub moves opaque bytes: it parses only its own link frames, never a tunneled byte;
- the hub stores nothing, holds no key and signs nothing. It is never trusted for authenticity, but it **sees everything** it relays (see [Hub security](#hub-security)).

Wire format: [protocol.md → Hub link wire format](protocol.md#hub-link-wire-format). The client shares the endpoint core with direct TCP: [transport.md → Endpoint and bindings](transport.md#endpoint-and-bindings).

## Running the hub

| | |
|---|---|
| Command | `node hub.js [--host HOST] [--port PORT]`, or `npm run hub -- …`, from a checkout. No `npm install` needed: no runtime dependencies |
| `--host` | Default `127.0.0.1`. Any IP literal or hostname; a wildcard (`0.0.0.0`, `::`) or an interface IP exposes the hub |
| `--port` | Default `HUB_DEFAULT_PORT` (`src/hub/hub.js`); `0` = ephemeral |
| Output | `code-inbox hub listening on <host>:<port>`; on a non-loopback host, a second line on stderr warning that the port is open and records and metadata travel unencrypted |
| Refusals | A bad or unknown flag (strict `util.parseArgs`), a host that is not a host, or a port outside 0–65535 (`validateHubListen`): the reason and usage on stderr, exit 2 |
| Stop | SIGTERM / SIGINT → `hub.close()` → exit 0 |
| State | None. A restart loses nothing: clients reconnect and re-register, and writes made meanwhile wait in their outboxes |
| Imports | Nothing of the plugin host (`server.js`, the engine, store, state, routes, HTTP, MCP, notifier, cc client, config): `src/hub/hub.js` uses the transport's pure framing, proof and link modules (pinned by a test) |

Exposure is deliberate: bind loopback and front the hub with an SSH tunnel or reverse proxy, or pass `--host`. Every install of a group must save the same hub; a contact on TCP or another hub is never reachable through it.

### Limits (`src/hub/hub.js`, `src/transport/frames.js`)

| Constant | Bounds |
|---|---|
| `HUB_MAX_LINKS` | links at once; one more is destroyed at accept |
| `HUB_MAX_HANDSHAKING` | links not yet registered; one more is destroyed at accept |
| `HUB_MAX_STREAMS` | streams per link, opened or received; an `open` beyond it (the opener's or the target's) is answered `close LIMIT` |
| `HUB_WRITE_BUFFER_MAX` | unflushed stream data the hub holds toward one **stream end**; a `data` that would pass it closes that stream on both ends (`LIMIT`) |
| `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` | the link's **data total**: unflushed stream data toward one link, every end counted, closed streams' still-unflushed bytes included; a `data` that would pass it closes the stream it belongs to (`LIMIT`) |
| `HUB_CONTROL_BUFFER_MAX` | how far the link's **whole total** (every unflushed byte toward it, data and control frames together) may go beyond the data total. It is not a reserve: a control frame (`incoming`, `close`, `present`, `presence`, `ping`, `pong`) is admitted while the whole total has room, so control frames may fill data room data does not use. Any frame that would pass the whole total is **dropped**, never the link; a `data` frame dropped this way closes its stream (`LIMIT`) |
| `HUB_FRAME_MAX`, `HUB_CHUNK_BYTES`, `HUB_DATA_MAX`, `HUB_WATCH_MAX` | frame size after `ok`; raw bytes per `data`; its base64url length; fps per `watch` / `present` |
| `TCP_HELLO_FRAME_MAX`, `TCP_HANDSHAKE_MS`, `TCP_FRAME_MS`, `TCP_IDLE_MS`, `TCP_PING_MS` | as on TCP: frame size before `ok`; registration deadline; a partial frame; silence; keepalive |

**Memory bound.** The hub holds at most the whole total, `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` + `HUB_CONTROL_BUFFER_MAX` unflushed bytes, toward one link (with the shipped constants, 256 MiB plus 64 KiB), so at most `HUB_MAX_LINKS` times that in all. The bound is reached only by links that stop reading while others send to them; a flooder can approach it (availability is out of scope, no per-IP fairness). An operator who wants less passes smaller `limits` to `createHub`.

`createHub({host, port, limits, schedule, createServer})` → `{listen(): Promise<{host, port}>, close(), stats()}`; `limits` overrides any of `HUB_LIMITS` (tests). `stats()` → `{listening, links, handshaking, fps, streams, handshakeFailures, dropped}`; `dropped` counts `data` for an unknown stream and every frame a link could not take (data, control, the hub's own pings and pongs).

## Hub server behaviour (`src/hub/hub.js`)

- **Register:** `verifyProofs(ids, 'hub', clientNonce, hubNonce, '')`; a failure is `bye PROOF`. Then, in order: every other link holding one of those fps gets `bye DUPLICATE` and is torn down (**newest registration wins**); the fps map to this link; `ok`; every other link watching one of them gets `presence {fp, online: true}`.
- **`open {s, to}`:** an `s` already open on the link is `bye PROTOCOL`. `close {s, LIMIT}` when the opener or the target is at `HUB_MAX_STREAMS`; `close {s, ABSENT}` when no other link registered `to` (the opener's own fp included). Otherwise the target gets `incoming {s: s2}` (an even id of its own) and the two ends are paired. `incoming` names nobody.
- **`data {s, b}`:** forwarded as `data {peerS, b}` unless it would pass the receiving end's `HUB_WRITE_BUFFER_MAX`, the receiving link's data total, or its whole total: then that stream closes `LIMIT` at both ends, and the receiver's link carries on. While the link is below both totals, its other streams carry on too. An unknown `s` (it raced a close) is dropped and counted in `dropped`.
- **A link that cannot take a control frame** (it would pass the link's whole total) does not get it: the frame is dropped and counted in `dropped`, and the link stays up. A dropped `close` or `incoming` leaves the receiver's session on that stream to its own deadlines (handshake, idle); pulls on the next session recover anything lost. A dropped `presence` is a missed dial hint. The hub never destroys a link for its write buffer.
- **`close {s}`:** the peer end gets `close {peerS, CLOSED}`; the pair is forgotten. An unknown `s` is ignored.
- **`watch {id, fps}`:** replaces the link's watch set; answered `present {id, fps}` with the watched fps registered now on other links.
- **Link close:** its fps still mapped to it are dropped and their watchers get `presence {fp, online: false}`; every stream's peer end gets `close GONE`; its watches are dropped.
- Never pauses reading, never awaits, never logs per-connection failures (counted: `handshakeFailures`, `dropped`).
- **`close()`:** closes the listener synchronously, then `bye STOP` to every link.

## Hub client (`src/transport/hubClient.js`)

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: false, push: true}`: the hub keeps no listing |
| `addresses()` | `[hub://host:port]`, the saved url normalized (`formatHubAddr`). It goes into `announce.addr`; a TCP client ignores the scheme |
| `send` | The endpoint core's: a `rec` on a ready session is `delivered`; everyone else is `pending`, and pending recipients in the dial set are dialed. Never throws |
| `sync()` | The core's maintain, awaited end to end: watch → dial present contacts → pull |
| `peerOnline` | Only when an end-to-end session becomes ready. Hub presence is a dial hint |
| `Incoming.writer` | The `from` the remote endpoint proved in the tunneled handshake |
| `stats().hub` | `{url, connected, error}`; the engine shows `{connected, error}` as `state().transport.hub` |

`createHubEndpoint({url, limits, now, schedule, syncMs, connect, log})` → `{attach, stats, close}` (`connect` opens the link socket; tests inject one). `createHubClient(opts)` = one endpoint, one binding: what `server.js` builds for `{kind:'hub', url}`.

### The link

- **Connect:** `net.connect(host, port)`, then the hub-link hello and a `register` proving every attached identity (`proofSigner`, role `hub`).
- **On `ok`:** the reconnect backoff resets, `error` clears, the watch is sent and every binding's maintain is queued.
- **On close:** every stream ends (its session closes and leaves the pool), presence is forgotten, and a reconnect is scheduled after `redialMinMs`, doubling to `redialMaxMs` (`TCP_REDIAL_MIN_MS`, `TCP_REDIAL_MAX_MS`).
- **`error`**, shown on the page:

  | Code | When | Then |
  |---|---|---|
  | the socket's (`ECONNREFUSED`, `ENOTFOUND`, …) | the connection failed | reconnects with backoff |
  | `HUB_REFUSED` | the hub answered `bye PROOF` | reconnects with backoff |
  | `HUB_DUPLICATE` | the hub answered `bye DUPLICATE`: another endpoint registered one of these identities (a copied identity) | **no reconnect** until a binding is attached or detached (a transport start or save attaches one), so two copies do not knock each other off forever. Detaching re-registers the identities that remain: the detached one may have been the copy |

- **Self-supersession:** a client that reconnects on its own (a binding attached or detached on a shared endpoint, `open()` with other identities) first leaves its current connection (`bye STOP`). Whatever the left connection still hears, a `bye DUPLICATE` caused by its own new registration included, is ignored, and its close arms no reconnect: only the current connection records an error or schedules a reconnect. The same holds for `close()` with a binding still attached.
- `discover` waits for a connect in progress, never for a backoff timer.

### Streams

- Stream ids are per link: odd ids are the client's (streams it opens), even ids the hub's (streams it receives).
- A `HubStream` is the socket-like object a session (`tcpSession.js`, unchanged) runs on: `write` splits into `HUB_CHUNK_BYTES` chunks sent as `data`; `destroy` / `destroySoon` send `close {s, CLOSED}` once; inbound `data` is decoded and emitted; an inbound `close` ends it without a reply.
- **Back-pressure is per stream:** `writableLength` counts only this stream's bytes not yet flushed to the link socket, so a session's `TCP_WRITE_BUFFER_MAX` check never sees, and is never closed by, another session's bytes on the shared link. The link's own cap is `maxConnections` × `writeBufferMax`, the sum of every session's.
- **A paused stream never pauses the link:** it holds inbound chunks; over `HUB_STREAM_BUFFER_MAX` held bytes it closes `LIMIT`, and pulls recover the lost frames on the next session.
- An `incoming` stream goes to the core's `accept`; beyond the core's caps it is closed at once.

### Dial policy and presence

- **Watch set** = every binding's `view.contacts()` plus `wanted` (pending recipients that are not contacts, such as an invitee), minus local fps, sorted, at most `HUB_WATCH_MAX` (a truncation is logged once). Re-sent only when it changes. An fp leaves `wanted` once a session to it is ready.
- **`dial(b, fp)`** does nothing when `fp` is local or has a session; returns the dial in flight to `fp` if any; otherwise does nothing when the link is not registered (`fp` joins `wanted`), `fp` is backing off, `fp` is watched and not present, or the core is at `maxConnections`. An fp not yet watched joins `wanted` and a watch refresh is sent (not awaited: `send` runs under the engine lock), and the dial goes ahead.
- A dial opens a stream (`open {s, to: fp}`) and runs the dialer's handshake on it. Success resets `fp`'s backoff; failure (an `ABSENT` or `LIMIT` close, or a failed handshake) backs it off from `redialMinMs`, doubling to `redialMaxMs`; `ABSENT` also drops `fp` from `present`.
- **Presence:** `presence {online: true}`, or an fp newly in a `present` answer, marks it present, resets its backoff and dials it if it is in the dial set with no session. `online: false` unmarks it. The hub's word only triggers a dial; the handshake decides.

### Discovery

- A card import makes the identity a contact: it is watched, and dialed once present.
- The directory pull at every handshake exchanges announces, as on TCP.
- Members known only by fingerprint (from inbox records) are contacts too, so they are dialed by fingerprint. The client never sends `whois`; the core still answers one, gated by `view.announceFor`.
- Other identities' `addr` entries are never used to dial. A contact on TCP or on another hub is never present here, so it is never dialed.

### Settings

- `validateHubConfig({url})` (pure): `hub://<host>:<port>`, host a hostname, IPv4 address or `[IPv6]` and not a wildcard (`isWildcardHost`), port 1–65535, at most `ADDR_MAX_CHARS` (it goes into `announce.addr`). Normalized by `formatHubAddr`. Anything else: `HUB_INVALID`.
- `resolveHubConfig(input, {lookup, lookupMs, mustResolve})`: then a non-literal host is looked up (`lookupAll`, `TCP_LOOKUP_MS`): any wildcard answer is `HUB_INVALID`; no answer or a timeout is `HUB_INVALID` only with `mustResolve` (a save; at boot the hub may simply be unreachable for now).

## Known limitations

- **The hub reads everything it relays** and sees who talks to whom ([Hub security](#hub-security)).
- **Peers must share the hub.** Hub, TCP and the file share are one transport at a time per install, never composed.
- **Both ends must be online at once** (through the hub), as on TCP; until then the sender keeps the record in its outbox.
- **No per-IP fairness or accounts:** any key holder can register its own fingerprints, and a flooder can exhaust the hub's link and handshake slots.

## Hub security

1. **Open port.**
   - The hub binds `127.0.0.1` unless the operator passes `--host`; exposing it is explicit (a wildcard, an interface IP, or an SSH tunnel or reverse proxy to loopback), and a non-loopback host logs a plaintext warning.
   - No TLS, no accounts, no allow-list: any key holder can register the fingerprints whose keys it holds.
   - On the client, the hub url is saved through `POST api/hub` behind the mutating-request guard, as for TCP.
2. **What an unauthenticated connection can make the hub do:** take one link slot and one handshake slot; generate one nonce and write one `hello`; buffer at most `TCP_HELLO_FRAME_MAX` and parse at most two small frames; run up to `TCP_MAX_IDENTITIES` Ed25519 verifies within `TCP_HANDSHAKE_MS`. It cannot open a stream, watch, learn any registered fingerprint, or cause any signing (the hub has no key) or log line.
3. **Per-client limits.**
   - Links: `HUB_MAX_LINKS`, `HUB_MAX_HANDSHAKING`, enforced at accept.
   - Phase frame limits, checked from the 4-byte header before any body is buffered; exact schemas per role and phase; deadlines for the registration, a partial frame and silence.
   - `HUB_MAX_STREAMS` per link; `HUB_WATCH_MAX` per watch.
   - `HUB_WRITE_BUFFER_MAX` per stream end, the data total `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` per link, and the whole total, `HUB_CONTROL_BUFFER_MAX` beyond it, for data and control frames together ([Memory bound](#limits-srchubhubjs-srctransportframesjs)): a receiver that does not keep up loses streams (`LIMIT`) and control notices (dropped), never its link. While its link is below both totals, a stream over its own cap costs no other stream.
   - Client side: the core's `maxConnections` / `maxHandshaking` apply to streams; `HUB_STREAM_BUFFER_MAX` per paused stream; the session limits inside every stream.
   - No per-IP fairness: availability against a flooder is out of scope.
4. **A malicious hub can:**
   - drop, delay or reorder frames; replay frames (records are deduplicated by id); misroute streams; lie about presence (costing failed dials: a presence notice resets that fp's backoff, so the bound is one dial in flight per fp);
   - inject frames into a live session: there is no per-frame authentication, as for a TCP on-path attacker;
   - **read everything any proven identity on a session it relays may read.** It sees every frame in plaintext, and an injected `pull` makes a server answer the session's proven remote into that stream, including history from before the hub was in use;
   - suppress records by tampering with pull answers (the effect of a drop; a cursor pushed past the server's head resets to 0);
   - register a client's fingerprints at another hub by relaying that client's registration live, which only lets it drop or relay again.

   It **can never:** forge a record (signatures); forge `from` (the writer is proven end to end: a misrouted stream fails the target-bound handshake, and a frame whose `from` the remote did not prove closes the session); make a server answer as an identity other than the one proven on that session; turn presence into `peerOnline`; reuse a registration or handshake proof elsewhere (each is bound to both nonces, its role and its target).
5. **A malicious client can:** register only fingerprints whose key it holds; replace its own fingerprint's older link (newest wins); open streams to any registered fingerprint (the target's acceptor proves second, so it learns nothing beyond presence until it proves a key that names an attached target); hold the target's handshake slots, as a TCP stranger can; watch any fingerprint it knows (a presence oracle, like probing a TCP address); make its watchers redial it by reconnecting. It cannot claim another's fingerprint, read others' streams, make the hub write to a link it opened no stream to (other than presence to watchers of its own fps), or get another client disconnected by flooding it: filling every stream it may open to a client that reads slowly or not at all closes those streams `LIMIT` and drops the control frames that would not fit, but never the victim's link. What it can do is close the victim's *other* streams once the victim's link is full, until the victim reads again: full means it holds its data total in stream data, or its whole total in data and control frames together (the flooder can make the hub queue control frames to it, e.g. `incoming` for streams it opens).
6. **Plaintext metadata the hub sees:** each link's source address and timing; its registered fingerprints (so which identities share an endpoint); its watch set, which is its dial set (contacts, counterparties, co-members: the social graph); every stream open (who dials whom, when); every tunneled byte (records with bodies, names, membership and inbox ids; pulls with route keys and cursors; whois and cards; sizes and timing). The least-disclosure rules (scoped pulls, gated `whois`, head-less denials, [transport.md → TCP security](transport.md#tcp-security)) still bind **peers** end to end, because they run in the shared core inside the tunneled session. The hub sees the union of all traffic it relays.

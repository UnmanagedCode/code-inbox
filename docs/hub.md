# Hub

A hub is a standalone router for installs that cannot reach each other directly (behind NAT, across networks). Installs add a connection to it; it proves their fingerprints on that link, keeps every link told who else is registered (the **roster**), and carries **streams** between fingerprints. The unchanged endpoint handshake (`hello` / `prove` / `ok`, [protocol.md → Handshake](protocol.md#handshake)) and every session frame run inside a stream, so:

- the writer of a record is still the `from` the **remote endpoint** proved, never the hub's word;
- the hub moves opaque bytes: it parses only its own link frames (and checks the announces clients give it), never a tunneled byte;
- the hub stores nothing on disk, holds no key and signs nothing. It is never trusted for authenticity, and it **sees everything** it relays ([Hub security](#hub-security)).

Wire format: [protocol.md → Hub link wire format](protocol.md#hub-link-wire-format). A connection detects a hub from its `hello` and becomes a hub link ([The hub mode of a connection](#the-hub-mode-of-a-connection)); the endpoint core is shared with direct sessions ([transport.md → Network endpoint](transport.md#network-endpoint-srctransportnetworkjs-endpointjs)).

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
| Imports | Nothing of the plugin host (`server.js`, the engine, store, state, routes, HTTP, MCP, notifier, cc client, config): `src/hub/hub.js` uses the record codec (`src/records.js`, to check announces) and the transport's pure framing, proof and link modules (pinned by a test) |

Exposure is deliberate: bind loopback and front the hub with an SSH tunnel or reverse proxy, or pass `--host`. Installs reach it by adding a connection to its `host:port`; an install may use several hubs, and two installs reach each other through any hub both are connected to.

### Limits (`src/hub/hub.js`, `src/transport/frames.js`)

| Constant | Bounds |
|---|---|
| `HUB_MAX_LINKS` | links at once; one more is destroyed at accept |
| `HUB_MAX_HANDSHAKING` | links not yet registered; one more is destroyed at accept |
| `HUB_MAX_STREAMS` | streams per link, opened or received; an `open` beyond it (the opener's or the target's) is answered `close LIMIT` |
| `HUB_WRITE_BUFFER_MAX` | unflushed stream data the hub holds toward one **stream end**; a `data` that would pass it closes that stream on both ends (`LIMIT`) |
| `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` | the link's **data total**: unflushed stream data toward one link, every end counted, closed streams' still-unflushed bytes included; a `data` that would pass it closes the stream it belongs to (`LIMIT`) |
| `HUB_CONTROL_BUFFER_MAX` | how far the link's **whole total** (every unflushed byte toward it, data and control frames together) may go beyond the data total. It is not a reserve: a control frame (`incoming`, `close`, `peer`, `gone`, `ping`, `pong`) is admitted while the whole total has room, so control frames may fill data room data does not use. A frame that would pass the whole total is **dropped**, never the link (a `data` frame dropped this way closes its stream, `LIMIT`), except a roster frame (`peer`, `gone`), which **waits** ([The roster](#the-roster)) |
| `HUB_FRAME_MAX`, `HUB_CHUNK_BYTES`, `HUB_DATA_MAX` | frame size after `ok`; raw bytes per `data`; its base64url length |
| `ANNOUNCE_MAX_BYTES` (`src/records.js`) | one announce: an `announce` frame's `rec`, a `peer` frame's |
| `TCP_HELLO_FRAME_MAX`, `TCP_HANDSHAKE_MS`, `TCP_FRAME_MS`, `TCP_IDLE_MS`, `TCP_PING_MS` | as for endpoint sessions: frame size before `ok`; registration deadline; a partial frame; silence; keepalive |

**Memory bound.** The hub holds at most the whole total, `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` + `HUB_CONTROL_BUFFER_MAX` unflushed bytes, toward one link (with the shipped constants, 256 MiB plus 64 KiB), so at most `HUB_MAX_LINKS` times that in all. The bound is reached only by links that stop reading while others send to them. Announces held: at most `HUB_MAX_LINKS` × `TCP_MAX_IDENTITIES` × `ANNOUNCE_MAX_BYTES` (16 MiB with the shipped constants), in memory only. An operator who wants less passes smaller `limits` to `createHub`.

`createHub({host, port, limits, schedule, createServer})` → `{listen(): Promise<{host, port}>, close(), stats()}`; `limits` overrides any of `HUB_LIMITS` (tests). `stats()` → `{listening, links, handshaking, fps, streams, announces, rosterPending, handshakeFailures, dropped}`; `announces` counts announces held, `rosterPending` the roster entries waiting for their links; `dropped` counts `data` for an unknown stream and every frame a link could not take (data, control, the hub's own pings and pongs), never a waiting roster entry.

## Hub server behaviour (`src/hub/hub.js`)

- **Register:** `verifyProofs(ids, 'hub', clientNonce, hubNonce, '')`; a failure is `bye PROOF`. Then, in order: every other link holding one of those fps gets `bye DUPLICATE` and is torn down (**newest registration wins**); the fps map to this link; `ok`; the roster is updated (below).
- **`announce {rec}`:** checked: it decodes (`decodeRecord`: envelope, signature, schema), is an `announce`, and its signer is an fp this link registered and still holds. Anything else is `bye PROTOCOL`. Kept per link, latest wins; every other ready link is told (`peer`).
- **`open {s, to}`:** an `s` already open on the link is `bye PROTOCOL`. `close {s, LIMIT}` when the opener or the target is at `HUB_MAX_STREAMS`; `close {s, ABSENT}` when no other link registered `to` (the opener's own fp included). Otherwise the target gets `incoming {s: s2}` (an even id of its own) and the two ends are paired. `incoming` names nobody.
- **`data {s, b}`:** forwarded as `data {peerS, b}` unless it would pass the receiving end's `HUB_WRITE_BUFFER_MAX`, the receiving link's data total, or its whole total: then that stream closes `LIMIT` at both ends, and the receiver's link carries on. While the link is below both totals, its other streams carry on too. An unknown `s` (it raced a close) is dropped and counted in `dropped`.
- **A link that cannot take a control frame** (it would pass the link's whole total) does not get it: the frame is dropped and counted in `dropped`, and the link stays up. A dropped `close` or `incoming` leaves the receiver's session on that stream to its own deadlines (handshake, idle); pulls on the next session recover anything lost. The hub never destroys a link for its write buffer.
- **`close {s}`:** the peer end gets `close {peerS, CLOSED}`; the pair is forgotten. An unknown `s` is ignored.
- **Link close:** its announces are dropped; its fps still mapped to it are dropped and every other ready link is told (`gone`); every stream's peer end gets `close GONE`.
- Never pauses reading, never awaits, never logs per-connection failures (counted: `handshakeFailures`, `dropped`).
- **`close()`:** closes the listener synchronously, then `bye STOP` to every link.

### The roster

Each link has a set of roster entries it is owed (`dirty`, one per fp). An entry is written as one frame built from the **current** state when it goes out: `peer {fp, rec}` while `fp` is registered on another ready link (`rec`: that link's announce for `fp`, or `null` while it gave none), else `gone {fp}`.

| Event | Entries owed |
|---|---|
| A link becomes ready (`ok`) | the newcomer's fps, to every other ready link; every fp registered on another link, to the newcomer (**the newcomer burst**) |
| `announce` from a link | its signer, to every other ready link |
| A link closes | each fp it still held, to every other ready link (now absent: `gone`) |
| Newest registration wins | covered by the new link's ready event: the fp is present again, so no `gone` goes out |

- **Pumping:** after each event the hub pumps each affected link once (`setImmediate`, coalesced), so a registration that replaces another settles first. A pump writes owed entries while they fit the link's whole total; one that does not fit **waits** (not dropped, not counted), and every flush toward the link pumps again.
- **What a slow reader sees:** each fp's latest state, late, never a stale or lost one. `peer` and `gone` are idempotent for the client (an unknown `gone` is ignored, a repeated `peer` overwrites). No resync and no reconnect.
- **Bounds** (realistic load): owed entries ≤ the fps registered (ids only); one change fans out to at most `HUB_MAX_LINKS` − 1 links; a newcomer burst is one `peer` per fp registered elsewhere.

## The hub mode of a connection

A configured connection (`src/transport/connection.js`) whose far end says `hello` kind `hub` becomes a hub link (`src/transport/hubLink.js`). It has no settings of its own: its address is the connection's.

| Concern | Answer |
|---|---|
| Registration | `register` proving every attached identity (`proofSigner`, role `hub`), straight after the greeting |
| On `ok` | backoff resets, `error` clears, `state: 'up'`; `announce` for each binding's announce (`core.announces()`), and again whenever one changes; every binding's maintain is queued |
| On close | every stream ends (its session closes and leaves the pool), the roster is forgotten; reconnect as in [transport.md → Connections](transport.md#connections) |
| `peerOnline` | Only when an end-to-end session becomes ready. The roster is a dial hint |
| `Incoming.writer` | The `from` the remote endpoint proved in the tunneled handshake |
| Status | the connection's row: `kind: 'hub'`, `state`, `remote` (the fps of ready sessions on this link), `error` |

- **Errors:**

  | Code | When | Then |
  |---|---|---|
  | the socket's (`ECONNREFUSED`, `ENOTFOUND`, …) | the connection failed | reconnects with backoff |
  | `HUB_REFUSED` | the hub answered `bye PROOF` | reconnects with backoff |
  | `HUB_DUPLICATE` | the hub answered `bye DUPLICATE`: another endpoint registered one of these identities (a copied identity, or a second connection of this install to the same hub) | **no reconnect** (`state: 'stopped'`) until a binding is attached or detached (a transport start or a settings save attaches one), so two copies do not knock each other off forever. Detaching re-registers the identities that remain: the detached one may have been the copy |

- **Self-supersession:** a connection that re-registers on its own (a binding attached or detached on a shared endpoint) first leaves its current link (`bye STOP`). Whatever the left link still says, a `bye DUPLICATE` caused by its own new registration included, is ignored, and its close arms no reconnect: only the current link records an error or schedules a reconnect. The same holds for `shutdown()` with a binding still attached.

### The roster on the client

- **`peer {fp, rec}`** (ignored for a local fp), in order: `fp` joins this hub's `present` set; this hub's backoff for `fp` resets; `rec`, when set, is decoded and must be an `announce` signed by `fp`, then goes to every binding's engine (`sink.announce`: memory only); one that fails is not offered and counts in `dropped`; if `fp` is a contact without a session, `dialHubs(fp)`.
- **`gone {fp}`:** `fp` leaves `present`.
- `stats().presence` lists, per fp, every hub whose roster has it (`{via: 'hub', address}`) next to its sessions; the page's directory shows it.

### Streams

- Stream ids are per link: odd ids are the client's (streams it opens), even ids the hub's (streams it receives).
- A `HubStream` is the socket-like object a session (`tcpSession.js`, unchanged) runs on: `write` splits into `HUB_CHUNK_BYTES` chunks sent as `data`; `destroy` / `destroySoon` send `close {s, CLOSED}` once; inbound `data` is decoded and emitted; an inbound `close` ends it without a reply.
- **Back-pressure is per stream:** `writableLength` counts only this stream's bytes not yet flushed to the link socket, so a session's `TCP_WRITE_BUFFER_MAX` check never sees, and is never closed by, another session's bytes on the shared link. The link's own cap is `maxConnections` × `writeBufferMax`, the sum of every session's.
- **A paused stream never pauses the link:** it holds inbound chunks; over `HUB_STREAM_BUFFER_MAX` held bytes it closes `LIMIT`, and pulls recover the lost frames on the next session.
- An `incoming` stream goes to the core's `accept`; beyond the core's caps it is closed at once.

### Dial policy

- **`dial(fp)`** does nothing when `fp` is local or has a session; returns the dial in flight to `fp` if any; otherwise does nothing unless the link is up, the roster shows `fp` present, and the core has a session slot, and `fp` is past its backoff on this hub.
- A dial opens a stream (`open {s, to: fp}`) and runs the dialer's handshake on it, **targeted** at `fp`. Success resets `fp`'s backoff; failure (an `ABSENT` or `LIMIT` close, or a failed handshake) backs it off from `redialMinMs`, doubling to `redialMaxMs`; `ABSENT` also drops `fp` from `present`.
- Which hub: the core's `dialHubs(fp)` tries the hub-mode connections in configured order, stopping once `fp` has a session ([transport.md → Dial policy](transport.md#dial-policy)). A direct session always wins the duplicate rule over a hub one.

### Discovery

- Every client on a hub learns every other client's fingerprint and announce from the roster; the directory lists them with "on hub `addr`", strangers included.
- A contact is dialed once a hub reports it; a stranger is never dialed until a human invites it, which makes it a counterparty and so a contact.
- A client never sends the hub a contact list.

## Known limitations

- **The hub reads everything it relays** and sees who talks to whom ([Hub security](#hub-security)).
- **Peers must share a hub** (or a direct route): a contact present on no hub this install is connected to is reached only over a connection.
- **Two connections to one hub** register the same identities: the later wins and the other shows `HUB_DUPLICATE`.
- **Both ends must be online at once** (through the hub); until then the sender keeps the record in its outbox.

## Hub security

1. **Trust assumption (owner ruling).** Hubs and the clients on them are trusted parties: no defence is designed against their abuse (no rate limits, no presence anti-spoofing, no announce-forgery handling beyond the signature check). [transport.md → Network security](transport.md#network-security) lists what is kept.
2. **Open port.**
   - The hub binds `127.0.0.1` unless the operator passes `--host`; exposing it is explicit (a wildcard, an interface IP, or an SSH tunnel or reverse proxy to loopback), and a non-loopback host logs a plaintext warning.
   - No TLS, no accounts, no allow-list: any key holder can register the fingerprints whose keys it holds.
   - On the client, a connection is saved through `POST api/network` behind the mutating-request guard.
3. **What an unauthenticated connection can make the hub do:** take one link slot and one handshake slot; generate one nonce and write one `hello`; buffer at most `TCP_HELLO_FRAME_MAX` and parse at most two small frames; run up to `TCP_MAX_IDENTITIES` Ed25519 verifies within `TCP_HANDSHAKE_MS`. It cannot open a stream, give an announce, receive the roster, or cause any signing (the hub has no key) or log line.
4. **Kept limits** (realistic load): `HUB_MAX_LINKS`, `HUB_MAX_HANDSHAKING` at accept; phase frame limits checked from the header; exact schemas per role and phase; deadlines; `HUB_MAX_STREAMS` per link; `HUB_WRITE_BUFFER_MAX` per stream end, the data total and the whole total per link ([Memory bound](#limits-srchubhubjs-srctransportframesjs)): a receiver that does not keep up loses streams (`LIMIT`) and control notices (dropped), never its link, and its roster entries wait. Client side: the core's session caps apply to streams; `HUB_STREAM_BUFFER_MAX` per paused stream; the session limits inside every stream.
5. **End to end, whatever the hub does:** the writer is the proven `from` (a misrouted stream fails the target-bound handshake, and a frame whose `from` the remote did not prove closes the session); records and announces are signature-checked; presence never fires `peerOnline`; a registration proof is bound to both nonces and the `hub` role.
6. **What a hub and its clients see:**
   - every client sees every other client's fingerprint, name (its announce) and online and offline times;
   - the hub sees each link's source address and timing, its registered fingerprints (so which identities share an endpoint), every stream open (who dials whom, when) and every tunneled byte (records with bodies, names, membership and inbox ids; pulls with route keys and cursors; sizes and timing);
   - **a hub never receives a contact list**: a client sends it only its registration, its own announces and stream frames;
   - an injected `pull` in a relayed session makes a server answer the session's proven remote into that stream, history included. The least-disclosure rules (scoped pulls, head-less denials) still bind **peers** end to end inside the tunneled session.

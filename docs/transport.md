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
- Recipients in `pending` (or all of them, if `send` throws) go to the outbox and are re-sent on `peerOnline(fp)` and on every `engine.sync()`.
- `record` answers `{retry: true}` only for bytes that may still be arriving (`BAD_JSON`); the transport offers them again later.
- `writer` is what route binding compares with `payload.signer`.
- `assertTransport` checks the shape of every transport the engine is given.
- `tests/transportContract.test.mjs` runs one contract against every implementation.

## File share (v1, `src/transport/fileShare.js`)

| Concern | Answer |
|---|---|
| `capabilities` | `{directory: true, push: false}` |
| `addresses()` | `[]` |
| `send` | Atomic write under the route's dir in this install's own fingerprint subdir; every `to` is `delivered` |
| Reading | Scans the routes of interest every `SHARE_POLL_MS`; `sync()` scans once |
| `peerOnline` | Never fires |

Layout and filename rules: [protocol.md → Routes and the share layout](protocol.md#routes-and-the-share-layout).

## Sketched follow-ups (not built)

Both fit the interface unchanged. The only engine additions they need are a contact-card import action and a per-peer `sync` cursor.

| Interface concern | Direct TCP (`tcp.js`) | Hub client (`hubClient.js`) |
|---|---|---|
| Addressing | Always by fingerprint. One endpoint can carry several identities: the handshake proves possession of each served key by signing a challenge, then frames are `{from, to, route, bytes}`. One pooled connection per endpoint multiplexes every identity behind it; `from` becomes `writer` | Registers the fingerprints it serves with the hub, proving each with a challenge signature. The hub forwards by recipient fingerprint only |
| `addresses()` / `announce.addr` | `tcp://host:port` | `hub+wss://host/` (rendezvous) |
| `send(..., {to})` | Looks up each recipient's announced `addr`; reachable ones are `delivered`, unreachable ones `pending` | Recipients the hub reports offline are `pending`. The hub stores nothing |
| Offline peers | Engine outbox + `peerOnline` when a connection comes up | Engine outbox + `peerOnline` from the hub's presence notices |
| Push vs poll | `push: true`: inbound frames call `sink.record` | `push: true` |
| No global listing | `directory: false`. Announces travel as contact cards (a signed announce pasted in the page), plus announces exchanged at the handshake | `directory: false`, same contact cards |
| `sync()` | Asks connected peers for records on the routes of interest since a cursor | Same, through the hub to online peers |
| Trust | Every record still goes through `decodeRecord` + route binding + `classify`. The transport is never trusted | The hub is never trusted for authenticity. Replays are deduplicated by record id; drops are recovered by the outbox and `sync` |

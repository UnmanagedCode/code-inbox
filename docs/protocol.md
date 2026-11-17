# Protocol

Every wire format code-inbox owns, and the cc routes it uses. The record codec lives in `src/records.js`; the validity rules in `src/state.js`.

## Records

### Envelope

The bytes of a record (a file on the share, a TCP frame's `rec`, a contact card's payload) are exactly:

```
{"v":1,"key":"<b64url raw public key>","payload":"<b64url payload JSON>","sig":"<b64url signature>"}
```

- Keys in that order, no others, no whitespace: the bytes must equal `JSON.stringify` of the parsed object.
- `key`: the signer's 32-byte raw Ed25519 public key. `sig`: 64 bytes.
- **Signature** over `"code-inbox/v1\0" ‖ payloadBytes`. It signs the stored payload bytes, so no canonicalisation is needed.
- **Record id** = the first 32 hex of sha256(payloadBytes). Records are deduplicated by id.
- **Fingerprint** of an identity = hex sha256 of its raw public key (64 hex). Displayed as its first 32 hex in groups of 4.

### Verification order (on every read)

| Step | Refusal reason |
|---|---|
| 1. size ≤ `RECORD_MAX_BYTES` | `TOO_LARGE` |
| 2. the envelope parses as JSON | `BAD_JSON` (the only retryable reason: the file may still be arriving) |
| 3. strict envelope shape (above) | `BAD_ENVELOPE` |
| 4. Ed25519 verify | `BAD_SIGNATURE` |
| 5. `payload.signer === fingerprint(key)` | `SIGNER_MISMATCH` |
| 6. payload schema for its type | `BAD_PAYLOAD`, `BAD_NAME`, `INBOX_ID_MISMATCH`, `SELF_ADDRESSED` |
| 7. route binding (below) | `ROUTE_MISMATCH` |
| 8. authorization against what is known (record types below) | the type's reason, or held **pending** |

### Bounds

| Constant (`src/records.js`) | Bounds |
|---|---|
| `RECORD_MAX_BYTES` | a whole record. `encodeRecord` refuses to sign a larger one (`RECORD_TOO_LARGE`), so no install signs, or accepts from itself, a record its readers would reject |
| `BODY_MAX_BYTES` | a message body, as UTF-8 bytes. A send whose encoded record would still exceed `RECORD_MAX_BYTES` (heavily escaped characters) is refused `BODY_TOO_LARGE` too |
| `NAME_RE` | identity and inbox names: one short token, so a peer-chosen name cannot carry markup or prose into a prompt |
| `ADDR_MAX`, `ADDR_MAX_CHARS` | `announce.addr` |

Ids and nonces are 32 lowercase hex (`ID_RE`); fingerprints 64 (`FP_RE`); `ts` is an integer from 0 to `TS_MAX` (ms since the epoch, the signer's clock, never trusted for ordering). A `msg` body is non-empty.

### Self-certifying inbox ids

- Personal: `hex(sha256("code-inbox/personal\0" + inviterFp + "\0" + inviteeFp + "\0" + nonce))[0..32]`
- Shared: `hex(sha256("code-inbox/shared\0" + ownerFp + "\0" + nonce))[0..32]`

Verification recomputes the id from the record's own fields (`inbox-create`, and `invite` of both kinds), so nobody can mint a record claiming another's inbox. A shared `invite` carries the inbox's nonce, which also proves the inviter is its owner.

### Record types

Every payload has `type`, `signer`, `ts`; no other fields than listed.

| Type | Fields | Route | Accepted when | Pending while |
|---|---|---|---|---|
| `announce` | `name`, `addr: string[]` (`[]` on the file share; `["tcp://host:port"]` over TCP) | directory | always (it certifies its own key) | — |
| `inbox-create` | `inbox`, `nonce`, `name` | directory | the id recomputes | — |
| `invite` | `to`, `kind: personal\|shared`, `inbox`, `nonce` | mailbox(`to`) | personal: the id recomputes. Shared: the id recomputes from signer + nonce and the `inbox-create` is known (`NOT_OWNER` otherwise) | shared: the `inbox-create` is unseen |
| `invite-response` | `to`, `invite` (record id), `inbox`, `accept: boolean` | mailbox(`to` = inviter) | the invite's `to` is the signer, its signer is `to`, same inbox (`RESPONSE_MISMATCH`) | the invite is unseen |
| `join-request` | `to` (owner), `inbox` | mailbox(owner) | the inbox's owner is `to` (`NOT_OWNER`) | the `inbox-create` is unseen |
| `join-response` | `to`, `request` (record id), `inbox`, `accept: false` | mailbox(requester) | the signer is the request's `to`, `to` its signer (`RESPONSE_MISMATCH`). A decline only: an admission is a `member` record | the request is unseen |
| `member` | `inbox`, `seq ≥ 1`, `op: add\|remove`, `member`, `keepHead: msgId\|null` (on every remove, never on an add) | inbox(id) | the signer is the owner (`NOT_OWNER`), `member` is not the owner (`BAD_MEMBER_OP`) | the `inbox-create` is unseen |
| `msg` | `inbox`, `body`, and on a shared inbox both `epoch` and `prev: msgId\|null` (the same sender's previous message in that inbox; null for its first) | inbox(id) | see below | see below |

**A message to a personal inbox** is valid when its signer is the inviter or invitee (`NOT_PARTY`), it carries no `epoch` (`BAD_EPOCH`), and the invite's response accepts (`INVITE_DECLINED`). Pending while no response is seen.

**A message to a shared inbox** is valid when, in this order:

1. it carries an `epoch` (`BAD_EPOCH`) and the signer was a member at that epoch (`NOT_MEMBER`);
2. its `prev` is `null`, or a currently valid message by the same signer in the same inbox. A `prev` that is another signer's or another inbox's record is `BAD_PREV`; one that is refused or invalid is `PREV_REJECTED`; one unseen, pending or not yet settled leaves the message pending (`PREV_UNSEEN`, `PREV_UNSETTLED`). Validity is therefore prefix-closed along `prev`;
3. for every later `member remove` of the signer, the message is on that removal's kept chain (`REMOVED`; see [Removal](#removal)). Pending while a link of the chain is unseen (`CHAIN_UNSEEN`).

Pending while the inbox or the epoch is unseen.

### Membership by epoch

- `inbox-create` is epoch 0, with the owner as the only member.
- Member record `seq` = n moves the inbox to epoch n; the member set at epoch n applies records 1..n in order. An epoch counts as seen only once every record 1..n is.
- Two member records with the same `seq`: the lowest record id wins, on every install.
- The owner assigns `seq` = highest it knows + 1. A sender cites its current epoch.

### Removal

- Every shared-inbox message names its sender's previous **valid** message there in `prev` (`null` for its first), so each sender's messages form a hash chain: each id commits to its `prev`.
- On removal the owner's install writes `keepHead`: the id of the member's last message **valid** on its install (acceptance order), or `null`. The record has a fixed size however much the member wrote.
- **Kept chain** (`keptChain`, `src/state.js`): `keepHead`, then each `prev` back, walking through accepted **and pending** records, while each link is a message by the member in that inbox. The walk ends at `null`, at a refused id, or at a record that is not the member's.
- **Why the chain is exactly what the owner held:** validity is prefix-closed, so when the owner wrote the removal every message on the chain below its `keepHead` was valid on its install; and since every id commits to its `prev`, no other record can sit on that chain.
- A message cited at an epoch before the removal is valid only if it is on the kept chain. Every reader decides the same way, with no clock involved:
  - a later message (on top of `keepHead` or anything below it) is off the chain, whatever `epoch` it cites;
  - a fork, or a message pre-signed before the removal but not held valid by the owner, is off the chain;
  - a message whose `prev` points at a pre-signed one stays pending on the owner's install (its `prev` is unseen), so it is never on the chain; once the pre-signed one arrives and is refused, it is refused too (`PREV_REJECTED`).
- While a link of the chain is unseen, a message not yet reached waits (`CHAIN_UNSEEN`); the link, when it arrives, is reached by the walk. Once the walk ends without reaching a message, that message is refused for good.
- After a re-add, messages citing the new epoch are valid again; a re-added sender chains onto its last valid message, never onto one the removal refused.
- Validity is recomputed against everything known, so a message accepted before a removal that does not reach it becomes **hidden** everywhere, together with everything built on it.
- **Convergence:** pending records and refused ids take part in every verdict, refusals are terminal, and refused ids are kept across restarts (`rejected.ndjson`). The rule is built so readers that end with the same records hold the same **valid** and **refused** sets, whatever order the records arrived in. Whether a refused message was refused at ingest or accepted first and invalidated later depends on arrival order; which messages are valid does not. The test "readers fed the same records in any order reach the same valid and refused sets with nothing pending" checks this on one record set (two removals, a re-add, chains, a fork, a stale write, pre-signed links) in fixed and seeded shuffled orders, and across a reader restart.
- **Equivocation breaks convergence, for the equivocator's own relationship only.** Where the protocol picks the lowest record id among conflicting records, a party that signs two conflicting ones can make readers diverge:
  - an owner signing two `member` records with one `seq`;
  - an invitee signing both an accept and a decline of one invite: one reader can refuse a message `INVITE_DECLINED` that another holds valid;
  - an inviter signing two personal invites for one inbox id.

  The divergence is permanent: a message a reader has already refused stays refused, even once the conflicting record arrives. Only the inbox relationship of the party that equivocated is affected; no third party can cause it or gain from it.

### Admission after an accepted shared invite

The owner's install writes the `member add` itself when it accepts the invitee's acceptance, and again at boot for any acceptance accepted before a crash. It does so only while `admissionDue` (`src/state.js`) holds:

- the invite's effective response (the lowest record id among its responses) accepts;
- the invitee is not a current member;
- the invite was accepted on the owner's install after the invitee's last `member` record (acceptance seqs, both written by the owner). A re-signed or replayed acceptance of an invite that predates a removal admits nobody; a fresh invite does.

### Names

- **Current announce** of an identity: its latest by `ts`, record id breaking ties.
- **Pinning:** `pins.json` maps name → fingerprint. A name is pinned the first time this install shows it.
- **Pinned to another key** → that identity is not shown: `NAME_TAKEN`.
- **Unpinned, two or more claimant keys** → none shown: `NAME_CONFLICT`. This closes the backdated-`ts` race.
- **Own name:** setting or announcing a name pinned here to another key, or claimed by another key, is refused (`NAME_TAKEN`, `NAME_CONFLICT`).
- An identity whose name is not shown still appears by fingerprint wherever it is a sender or member (name `null`).

## Routes and the share layout

A route says where a record travels: `{kind:'directory'}`, `{kind:'mailbox', fp}`, `{kind:'inbox', id}`. `routeFor(payload)` (`src/records.js`) gives each type's route (table above).

**Route binding** (the engine, for every transport): the record arrived on `routeFor(payload)`, and from writer `payload.signer`. With the signature covering `inbox` and `to`, this is what rejects a record replayed into another inbox, mailbox, writer subdir or session.

| Transport | `writer` is |
|---|---|
| File share | the fingerprint subdir the file sits in |
| TCP | the frame's `from`: an identity the remote proved on that session (any other `from` closes the session) |
| Contact-card import | the announce's own signer. Only an `announce` is accepted this way (`CARD_INVALID` otherwise) |

### File share (`<shareDir>/code-inbox/v1/`, `SHARE_ROOT`)

```
directory/<signerFp>/<ts13>-<rand32hex>.rec
mailbox/<toFp>/<signerFp>/<ts13>-<rand32hex>.rec
inboxes/<inboxId>/<signerFp>/<ts13>-<rand32hex>.rec
```

- A writer writes only below its own fingerprint subdir, by tmp + fsync + rename; tmp names start `.tmp-`. No file is ever rewritten.
- Before writing, the writer subdir must be a real directory (not a symlink) resolving inside the share; otherwise the action is refused `SHARE_UNSAFE` on its surface (REST 409, a coded MCP refusal) and the record is neither admitted locally nor queued.
- Readers skip writer subdirs and record files that are symlinks, and open files without following links.
- Readers offer only names matching `FILE_RE` (`^\d{13}-[0-9a-f]{32}\.rec$`, `src/transport/fileShare.js`) in subdirs that are a fingerprint. That skips tmp files and sync-client conflict copies.

## TCP wire format

Owned by `src/transport/frames.js` (framing, schemas, limits), `src/transport/handshake.js` (proofs) and `src/transport/tcpSession.js` (phases, timeouts). Behaviour on top of it: [transport.md → Direct TCP](transport.md#direct-tcp-srctransporttcpjs).

### Framing

- Every frame: a 4-byte unsigned big-endian length, then that many bytes of UTF-8 JSON: one object with a string `t`.
- A length above the current phase's limit closes the connection as soon as the 4 header bytes arrive, before any body is buffered. A zero length, invalid JSON, an unknown `t`, a frame the phase does not allow, or any schema failure closes the session, after `bye {reason}` where possible.
- Every frame is checked against an exact schema: exactly the keys listed, fingerprints matching `FP_RE`, routes passing `isRoute`, ids and seqs safe integers, bounded arrays, record bytes as canonical base64url decoding to 1..`RECORD_MAX_BYTES` bytes.

| Constant | Where | Bounds |
|---|---|---|
| `TCP_HELLO_FRAME_MAX` | `frames.js` | every frame before the session is ready |
| `TCP_FRAME_MAX` | `frames.js` | every frame after |
| `TCP_BATCH_BYTES` | `frames.js` | record bytes a server packs into one `recs` |
| `TCP_MAX_IDENTITIES` | `frames.js` | ids in one `prove`; identities on one endpoint |
| `TCP_PULL_ROUTES_MAX` | `frames.js` | routes in one `pull` / `recs` |
| `TCP_WHOIS_MAX` | `frames.js` | fingerprints in one `whois`, records in one `cards` |
| `TCP_HANDSHAKE_MS` | `tcpSession.js` | the whole handshake; then the connection is destroyed |
| `TCP_FRAME_MS` | `tcpSession.js` | a post-ready frame, from its first byte to its last |
| `TCP_PING_MS`, `TCP_IDLE_MS` | `tcpSession.js` | keepalive interval; nothing received for this long closes |
| `TCP_REQUEST_MS` | `tcpSession.js` | a `pull` or `whois` without its answer fails |
| `TCP_INBOUND_QUEUE`, `TCP_WRITE_BUFFER_MAX` | `tcpSession.js` | frames queued before the socket pauses; unflushed bytes before it is destroyed |

### Handshake

`PROOF_DOMAIN` = `"code-inbox/tcp-proof/v1\0"` (distinct from the record domain `"code-inbox/v1\0"`).

```
proofBytes(role, proverNonce, verifierNonce, bound) = PROOF_DOMAIN ‖ utf8(JSON.stringify([role, proverNonce, verifierNonce, bound]))
  role  = "dial" | "accept"
  bound = dial:   the target fingerprint the dialer means to reach
          accept: the dialer's proven fingerprints, sorted, joined with ","
```

| Step | Dialer (D) | Acceptor (A) |
|---|---|---|
| 1 | on connect: `{t:'hello', v:1, nonce:nD}` (32 random bytes, 64 hex) | on accept: `{t:'hello', v:1, nonce:nA}` |
| 2 | on A's hello: `{t:'prove', target, ids:[{key, sig}]}`, one per local identity, `sig` over `proofBytes('dial', nD, nA, target)` | — |
| 3 | — | checks `target` is attached here, 1..`TCP_MAX_IDENTITIES` ids, each `key` 32 bytes whose `sig` verifies, no repeated key, none of A's own fingerprints. Failure: `bye PROOF`, close; **A has signed nothing**. Success: `{t:'prove', ids:[…]}` over `proofBytes('accept', nA, nD, sortedDialerFps)` |
| 4 | checks A's ids the same way (role `accept`, bound = D's own sorted fingerprints) and that `target` is among them. Failure: `bye PROOF`. Success: `{t:'ok'}` → **ready** | on `ok` → **ready** |

`key` is the raw Ed25519 public key and `sig` the signature, both base64url; a proven fingerprint is sha256 of `key`, as for records.

### Session frames (after ready)

`from` must be an identity the remote proved on the session (else `bye PROTOCOL`); `to` must be attached locally (else the frame is dropped and counted).

| `t` | Fields | Meaning |
|---|---|---|
| `rec` | `from, to, route, rec` | Push one record. Offered to `to` with writer `from` if `route` is in `to`'s interest; dropped and counted otherwise |
| `pull` | `id, from, to, routes:[{route, since}]` | Ask `to` for records **signed by `to`** on these routes with seq > `since`. Names only routes `to` could serve by the asker's own state ([transport.md → Scoped pulls](transport.md#maintain-pulls-and-cursors)) |
| `recs` | `id, from, to, routes:[{route, status:'ok', recs:[{seq, rec}], more, head} \| {route, status:'denied'}]` | Answer to `pull`: `from` is the pull's `to`, only routes it asked for, seqs ascending. A denied route is exactly `{route, status:'denied'}`: no `head`, so it reveals nothing of what the server holds. Routes the budget did not reach get `recs:[]`, `more:true`. `head` is the server's highest acceptance seq |
| `whois` | `id, from, to, fps` | Ask for the current announces of `fps`. Answered only for those that share an inbox with `from` on the answering install; the others are left out |
| `cards` | `id, from, to, recs:[rec]` | Answer to `whois`: dial hints only, never ingested |
| `ping` / `pong` | — | Keepalive every `TCP_PING_MS` |
| `bye` | `reason`: `PROOF`, `PROTOCOL`, `DUPLICATE`, `LIMIT`, `STOP` | Sent before a deliberate close |

### Addresses

`tcp://<host>:<port>` with host a DNS name, an IPv4 address, or `[IPv6]`, port 1–65535 (`parseTcpAddr` / `formatTcpAddr`, `src/transport/tcp.js`). Entries of `announce.addr` in any other form are ignored.

### Contact card

`CARD_PREFIX` (`"code-inbox-card:v1:"`, `src/records.js`) followed by the base64url of an announce record's bytes. `decodeCard` trims the text, requires the prefix and canonical base64url of at most `RECORD_MAX_BYTES` bytes; the record then goes through `decodeRecord` and must be an `announce` signed by another identity (`CARD_INVALID` otherwise).

## REST routes

All under the backend root; the page calls them relative (`api/...`). Every HTTP answer carries the CSP (`CSP`, `src/http.js`), `nosniff`, `no-referrer` and `no-store`; the bare 400 for a request Node cannot parse (`clientError`) carries only the CSP and `nosniff`. A malformed percent-escape in a path segment is 400 `BAD_REQUEST`.

**Request guard, every POST:** a browser's `Sec-Fetch-Site` must be `same-origin` or `none`; without that header, an `Origin` is refused (403 `FORBIDDEN`). Then `Content-Type: application/json` (415 `UNSUPPORTED_MEDIA_TYPE`). A request body over `MAX_REQUEST_BYTES` is 413 `PAYLOAD_TOO_LARGE`.

**Refusals** are `{error, code}`; the HTTP status per code is `STATUS` in `src/routes.js` (an unlisted code is 409, an unexpected failure 500 `INTERNAL`).

| Route | Body | Answer |
|---|---|---|
| `GET api/health` | — | `{ok: true}` |
| `GET api/state` | — | `{identity, transport, directory, sharedInboxes, invites, joinRequests, inboxes, diagnostics, notify}` (shapes: `frontend/src/types.ts` `State`). `transport` = `{kind, configured, dir, host, port, advertise, addresses, card, cardStale, error, outboxError}`: `outboxError` is `{code, message}` of the latest send failure still holding writes in the outbox (`diagnostics.outbox`), else null; `card` is this install's current announce as a contact card (or null), `cardStale` is true while that announce's `addr` differs from `addresses`, `error` is `{code, message}` when the stored transport was invalid at boot (`TCP_INVALID`, `SHARE_INVALID`, `SHARE_UNSAFE`, `TRANSPORT_INVALID`) or the TCP listener could not start (`TCP_LISTEN_FAILED`) |
| `GET api/inboxes/:id/messages` | — | `{inbox, messages: [{id, seq, sender: {fp, name}, ts, body}]}`: every valid message, in acceptance order |
| `GET api/sessions` | — | `{sessions: [{sessionId, label, status, live}], target, autoStart}`: cc's top-level conductors; 503 `CONDUCTOR_UNAVAILABLE` without cc |
| `POST api/identity` | `{name}` | `{name}` |
| `POST api/share` | `{dir}` | `{shareDir}`; makes the file share the transport. `SHARE_INVALID` 400 |
| `POST api/tcp` | `{host?, port?, advertise?}` | `{host, port, advertise, addresses}`; makes TCP the transport (`validateTcpConfig`). `TCP_INVALID` 400, `TCP_LISTEN_FAILED` 409 (no transport is configured after it) |
| `POST api/contacts` | `{card}` | `{fp, name, shown}`: the imported identity. `CARD_INVALID` 400 |
| `POST api/announce` | `{}` | `{id}` |
| `POST api/invites` | `{to}` (fingerprint) | `{id, inbox}` |
| `POST api/invites/:id/respond` | `{accept: boolean}` | `{id}` |
| `POST api/inboxes` | `{name}` | `{id}` (the new shared inbox) |
| `POST api/inboxes/:id/invites` | `{to}` | `{id}` |
| `POST api/inboxes/:id/join` | `{}` | `{id}` |
| `POST api/join-requests/:id/respond` | `{accept: boolean}` | `{id}` (a `member` record or a `join-response`) |
| `POST api/inboxes/:id/members/:fp/remove` | `{}` | `{id}` |
| `POST api/inboxes/:id/messages` | `{body}` | `{id, inbox}`. Refusals as `send_message`: `NOT_MEMBER` 409, `INBOX_UNKNOWN` 404, `TRANSPORT_UNCONFIGURED` 409, `SHARE_UNSAFE` 409, `BAD_REQUEST` 400 (not a non-empty string), `BODY_TOO_LARGE` 413 |
| `POST api/notify` | `{sessionId}` or `{sessionId: null}` | `{target, autoStart}`; `SESSION_UNKNOWN` unless a top-level conductor |
| `POST api/mcp` | cc's tool call | below |

The page's static files: `/` (and `/index.html`) and `/assets/<name>.(js\|css\|svg\|woff2)` from `frontend/dist`. An unbuilt UI answers 503 plain text. `/pluginBridge.js` and `/pluginTheme.css` are cc's and answer 404 standalone.

## MCP tools

cc POSTs `{tool, arguments, caller, format}` to `api/mcp`; every well-formed call answers HTTP 200 with one of:

- `format: "json"` → `{structured}`, valid against the tool's `outputSchema` in `conductor.plugin.json`;
- `format: "text"` (or absent) → `{text}`;
- a refusal → `{error, code}`: the engine's code, `TOOL_UNKNOWN`, `FORMAT_UNKNOWN`, `BAD_REQUEST`, or `INTERNAL`.

| Tool | Input | json output |
|---|---|---|
| `list_inboxes` | — | `{inboxes: [{id, kind, name, members: [{fp, name}], unread}]}` |
| `read_messages` | `inbox` (required), `after`, `limit` (1–`READ_LIMIT_MAX`, default `READ_LIMIT_DEFAULT`), `markRead` (default true) | `{inbox, notice, messages: [{id, seq, sender: {fp, name}, ts, body, untrusted: true}], cursor}` |
| `send_message` | `inbox`, `body` | `{id, inbox}` |

- **`read_messages` without `after`:** messages from others with an acceptance seq above the read cursor. **With `after`:** every message above it, own included. `markRead` advances the cursor to the last one returned.
- **Untrusted framing (text):** a fixed notice line (`UNTRUSTED_NOTICE`, `src/mcp.js`), then each body between `<<<UNTRUSTED-<nonce>` and `UNTRUSTED-<nonce>>>>`. The nonce is random for each response and redrawn if any body contains it, so a body cannot close its frame.

## cc routes used

Base URLs come from the child env cc sets (`CONDUCTOR_URL`, `CONDUCTOR_MCP_URL`, `CONDUCTOR_PLUGIN_ID`), read on every call (`src/cc.js`).

| Route | Used for |
|---|---|
| `GET $CONDUCTOR_URL/api/instances` | Candidate targets (`project === '.conduct' && !conducted`) and the target's `status` before each send |
| `POST $CONDUCTOR_MCP_URL/tools/send_prompt` `{sessionId, text}` | The notification, anonymously, through the REST alias. Delivered when HTTP 200 carries no `ok: false`, `code` or `error` |
| `GET $CONDUCTOR_URL/api/plugins` | This plugin's `autoStart`, for the page |
| `POST $CONDUCTOR_URL/api/plugins/$CONDUCTOR_PLUGIN_ID/autostart` `{autoStart: true}` | On assigning a target |

The target is stored by its public `sessionId`, which stays the same across `/clear`, renewal, prune and a cc restart that resumes the session.

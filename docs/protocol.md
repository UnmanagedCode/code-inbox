# Protocol

Every wire format code-inbox owns, and the cc routes it uses. The record codec lives in `src/records.js`; the validity rules in `src/state.js`.

## Records

### Envelope

The bytes of a record (a file on the share) are exactly:

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
| `RECORD_MAX_BYTES` | a whole record |
| `BODY_MAX_BYTES` | a message body, as UTF-8 bytes. A send whose encoded record would still exceed `RECORD_MAX_BYTES` (heavily escaped characters) is refused `BODY_TOO_LARGE` too |
| `NAME_RE` | identity and inbox names: one short token, so a peer-chosen name cannot carry markup or prose into a prompt |
| `ADDR_MAX`, `ADDR_MAX_CHARS` | `announce.addr` |

Ids and nonces are 32 lowercase hex (`ID_RE`); fingerprints 64 (`FP_RE`); `ts` is a non-negative integer (ms since the epoch, the signer's clock, never trusted for ordering).

### Self-certifying inbox ids

- Personal: `hex(sha256("code-inbox/personal\0" + inviterFp + "\0" + inviteeFp + "\0" + nonce))[0..32]`
- Shared: `hex(sha256("code-inbox/shared\0" + ownerFp + "\0" + nonce))[0..32]`

Verification recomputes the id from the record's own fields (`inbox-create`, and `invite` of both kinds), so nobody can mint a record claiming another's inbox. A shared `invite` carries the inbox's nonce, which also proves the inviter is its owner.

### Record types

Every payload has `type`, `signer`, `ts`; no other fields than listed.

| Type | Fields | Route | Accepted when | Pending while |
|---|---|---|---|---|
| `announce` | `name`, `addr: string[]` (`[]` on the file share) | directory | always (it certifies its own key) | — |
| `inbox-create` | `inbox`, `nonce`, `name` | directory | the id recomputes | — |
| `invite` | `to`, `kind: personal\|shared`, `inbox`, `nonce` | mailbox(`to`) | personal: the id recomputes. Shared: the id recomputes from signer + nonce and the `inbox-create` is known (`NOT_OWNER` otherwise) | shared: the `inbox-create` is unseen |
| `invite-response` | `to`, `invite` (record id), `inbox`, `accept: boolean` | mailbox(`to` = inviter) | the invite's `to` is the signer, its signer is `to`, same inbox (`RESPONSE_MISMATCH`) | the invite is unseen |
| `join-request` | `to` (owner), `inbox` | mailbox(owner) | the inbox's owner is `to` (`NOT_OWNER`) | the `inbox-create` is unseen |
| `join-response` | `to`, `request` (record id), `inbox`, `accept: false` | mailbox(requester) | the signer is the request's `to`, `to` its signer (`RESPONSE_MISMATCH`). A decline only: an admission is a `member` record | the request is unseen |
| `member` | `inbox`, `seq ≥ 1`, `op: add\|remove`, `member`, `keep?: msgId[]` (remove only) | inbox(id) | the signer is the owner (`NOT_OWNER`), `member` is not the owner (`BAD_MEMBER_OP`) | the `inbox-create` is unseen |
| `msg` | `inbox`, `body`, `epoch?` (shared inboxes only) | inbox(id) | see below | see below |

**A message to a personal inbox** is valid when its signer is the inviter or invitee (`NOT_PARTY`), it carries no `epoch` (`BAD_EPOCH`), and the invite's response accepts (`INVITE_DECLINED`). Pending while no response is seen.

**A message to a shared inbox** is valid when it carries an `epoch` (`BAD_EPOCH`), the signer was a member at that epoch (`NOT_MEMBER`), and for every later `member remove` of the signer the message id is in that record's `keep` (`REMOVED`). Pending while the inbox or the epoch is unseen.

### Membership by epoch

- `inbox-create` is epoch 0, with the owner as the only member.
- Member record `seq` = n moves the inbox to epoch n; the member set at epoch n applies records 1..n in order. An epoch counts as seen only once every record 1..n is.
- Two member records with the same `seq`: the lowest record id wins, on every install.
- The owner assigns `seq` = highest it knows + 1. A sender cites its current epoch.

### Removal

- On removal the owner's install lists in `keep` the ids of the member's messages it has accepted.
- Every reader then decides the same way, with no clock involved: a message cited at an epoch before the removal is valid only if kept. A backdated `epoch` does not help.
- After a re-add, messages citing the new epoch are valid again.
- Validity is recomputed against everything known, so a message accepted before a removal that does not keep it becomes **hidden** everywhere.

### Names

- **Current announce** of an identity: its latest by `ts`, record id breaking ties.
- **Pinning:** `pins.json` maps name → fingerprint. A name is pinned the first time this install shows it.
- **Pinned to another key** → that identity is not shown: `NAME_TAKEN`.
- **Unpinned, two or more claimant keys** → none shown: `NAME_CONFLICT`. This closes the backdated-`ts` race.
- **Own name:** setting or announcing a name pinned here to another key, or claimed by another key, is refused (`NAME_TAKEN`, `NAME_CONFLICT`).
- An identity whose name is not shown still appears by fingerprint wherever it is a sender or member (name `null`).

## Routes and the share layout

A route says where a record travels: `{kind:'directory'}`, `{kind:'mailbox', fp}`, `{kind:'inbox', id}`. `routeFor(payload)` (`src/records.js`) gives each type's route (table above).

**Route binding** (the engine, for every transport): the record arrived on `routeFor(payload)`, and from writer `payload.signer`. With the signature covering `inbox` and `to`, this is what rejects a record replayed into another inbox, mailbox or writer subdir.

### File share (`<shareDir>/code-inbox/v1/`, `SHARE_ROOT`)

```
directory/<signerFp>/<ts13>-<rand32hex>.rec
mailbox/<toFp>/<signerFp>/<ts13>-<rand32hex>.rec
inboxes/<inboxId>/<signerFp>/<ts13>-<rand32hex>.rec
```

- A writer writes only below its own fingerprint subdir, by tmp + fsync + rename; tmp names start `.tmp-`. No file is ever rewritten.
- Readers offer only names matching `FILE_RE` (`^\d{13}-[0-9a-f]{32}\.rec$`, `src/transport/fileShare.js`) in subdirs that are a fingerprint. That skips tmp files and sync-client conflict copies.

## REST routes

All under the backend root; the page calls them relative (`api/...`). Every answer carries the CSP (`CSP`, `src/http.js`), `nosniff`, `no-referrer` and `no-store`.

**Request guard, every POST:** a browser's `Sec-Fetch-Site` must be `same-origin` or `none`; without that header, an `Origin` is refused (403 `FORBIDDEN`). Then `Content-Type: application/json` (415 `UNSUPPORTED_MEDIA_TYPE`). A request body over `MAX_REQUEST_BYTES` is 413 `PAYLOAD_TOO_LARGE`.

**Refusals** are `{error, code}`; the HTTP status per code is `STATUS` in `src/routes.js` (an unlisted code is 409, an unexpected failure 500 `INTERNAL`).

| Route | Body | Answer |
|---|---|---|
| `GET api/health` | — | `{ok: true}` |
| `GET api/state` | — | `{identity, share, directory, sharedInboxes, invites, joinRequests, inboxes, diagnostics, notify}` (shapes: `frontend/src/types.ts` `State`) |
| `GET api/inboxes/:id/messages` | — | `{inbox, messages: [{id, seq, sender: {fp, name}, ts, body}]}`: every valid message, oldest first |
| `GET api/sessions` | — | `{sessions: [{sessionId, label, status, live}], target, autoStart}`: cc's top-level conductors; 503 `CONDUCTOR_UNAVAILABLE` without cc |
| `POST api/identity` | `{name}` | `{name}` |
| `POST api/share` | `{dir}` | `{shareDir}` |
| `POST api/announce` | `{}` | `{id}` |
| `POST api/invites` | `{to}` (fingerprint) | `{id, inbox}` |
| `POST api/invites/:id/respond` | `{accept: boolean}` | `{id}` |
| `POST api/inboxes` | `{name}` | `{id}` (the new shared inbox) |
| `POST api/inboxes/:id/invites` | `{to}` | `{id}` |
| `POST api/inboxes/:id/join` | `{}` | `{id}` |
| `POST api/join-requests/:id/respond` | `{accept: boolean}` | `{id}` (a `member` record or a `join-response`) |
| `POST api/inboxes/:id/members/:fp/remove` | `{}` | `{id}` |
| `POST api/inboxes/:id/messages` | `{body}` | `{id, inbox}`. Refusals as `send_message`: `NOT_MEMBER` 409, `INBOX_UNKNOWN` 404, `SHARE_UNCONFIGURED` 409, `BODY_TOO_LARGE` 413 |
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

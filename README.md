# code-inbox

Signed inboxes between code-conductor (cc) installs that can reach the same directory (Dropbox, SMB, NFS) or each other over direct TCP.

- **Identity is the install.** Each cc install has one Ed25519 key; everything it writes is signed with it, and every reader verifies it.
- **Humans control who is connected.** On the plugin's Inbox page a human announces the install, invites others, answers invites and join requests, and manages shared inboxes.
- **Agents read and write.** Every agent of the install gets three MCP tools: `list_inboxes`, `read_messages`, `send_message`.
- **A conductor hears about new mail.** One top-level conductor session per install gets a short prompt when mail arrives, without polling.

Records are signed, not encrypted: anyone who can read the share, or the TCP traffic, can read the messages.

## Functional overview

### Who it is for

Several people (or one person on several machines) who each run cc and want their conductors and agents to exchange messages they can trust: who sent what is proven by signature, not by where a file sits.

### Inboxes

| Kind | Members | How it comes to exist |
|---|---|---|
| Personal | Exactly two installs | One invites the other from the directory; it exists once the invitee accepts |
| Shared | An owner plus members | The owner creates it; others join by the owner's invite (accepted) or by a join request (admitted by the owner). The owner can remove members |

Details of every flow: [docs/features.md](docs/features.md).

### Setup (on each install, after the plugin is installed in cc)

1. Settings → Plugins → **Rescan**, then **Enable** `code-inbox`.
2. Run `npm install` in the plugin's checkout. This also builds the UI (`prepare`).
3. Open **Inbox** in cc's navigation.
4. Set a **name** and pick a **transport**: the absolute path of a **share directory**, or **TCP** (a listen host and port; loopback by default). Then press **Announce**.
   - On TCP, give your **contact card** (Contacts panel → Copy) to the other humans and **Import** theirs; importing the owner's card is enough to join a shared inbox.
5. Under **Notifications**, pick the conductor session to notify. This turns on the plugin's Auto-start in cc so the backend (and the notifier) runs from cc's boot.

Repeat on every install. Then invite each other from the **Directory**.

### Agent tools

| Tool | Does |
|---|---|
| `list_inboxes` | The inboxes this install belongs to, with members and unread counts |
| `read_messages` | Unread messages from others (advancing the read cursor), or every message after a given seq |
| `send_message` | Sends to an inbox this install is a party or member of |

Contracts: [docs/protocol.md → MCP tools](docs/protocol.md#mcp-tools). Human-only operations (identity, transport, contacts, invites, membership, notifications) are not tools.

## Technical overview

- **Backend:** Node ≥ 22, ESM, plain JavaScript on `node:http` and `node:crypto` (Ed25519). No runtime dependencies.
- **UI:** React 19 + Vite, plain CSS on cc's theme tokens, built by `npm install` → `prepare` into `frontend/dist/`.
- **Tests:** `node:test` for the backend, vitest + happy-dom for the UI. No live cc: a fake cc stands in at the HTTP boundary.

```
 Inbox page (humans) ─┐                  ┌─ MCP tools (agents: list / read / send)
                      ▼                  ▼
                 routes.js ─────────► engine.js ◄──── notifier.js ──► cc send_prompt
                                     │  ▲      │
            records.js (verify) ◄────┘  │      └──► store.js ($DATA: accepted log, pending, outbox, cursors)
            state.js (pure fold) ◄──────┘
                                     │
                       transport interface (src/transport/index.js)
                                     │
                       fileShare.js │ tcp.js (frames.js, handshake.js, tcpSession.js)
```

Module responsibilities, the data dir and the ingest pipeline: [docs/architecture.md](docs/architecture.md).

### Run and test

| Command | Does |
|---|---|
| `npm install` | Installs dev tools and builds the UI |
| `npm start` | Starts the backend standalone (needs `CONDUCTOR_PLUGIN_DATA_DIR`, an absolute path; `PORT` defaults to an ephemeral port) |
| `npm test` | Backend tests, then UI tests |
| `npm run test:server` / `npm run test:ui` | One side only |
| `npm run typecheck` | Type-checks the UI |

### Key defaults

| Constant | Where | Governs |
|---|---|---|
| `RECORD_MAX_BYTES`, `BODY_MAX_BYTES`, `NAME_RE` | `src/records.js` | Record size cap, message body cap, name syntax |
| `SHARE_POLL_MS` | `src/transport/fileShare.js` | How often the share is scanned |
| `TCP_DEFAULT_PORT`, `TCP_SYNC_MS`, `TCP_MAX_CONNECTIONS`, `TCP_MAX_HANDSHAKING`, `TCP_REDIAL_MIN_MS`, `TCP_REDIAL_MAX_MS` | `src/transport/tcp.js` | Default listen port (the host defaults to `127.0.0.1`); how often contacts are dialed and pulled; connection caps; redial backoff |
| `TCP_HELLO_FRAME_MAX`, `TCP_FRAME_MAX`, `TCP_BATCH_BYTES`, `TCP_MAX_IDENTITIES`, `TCP_PULL_ROUTES_MAX`, `TCP_WHOIS_MAX` | `src/transport/frames.js` | TCP frame sizes and counts |
| `TCP_HANDSHAKE_MS`, `TCP_FRAME_MS`, `TCP_IDLE_MS`, `TCP_PING_MS`, `TCP_REQUEST_MS`, `TCP_INBOUND_QUEUE`, `TCP_WRITE_BUFFER_MAX` | `src/transport/tcpSession.js` | TCP deadlines, keepalive and buffers |
| `NOTIFY_DEBOUNCE_MS`, `NOTIFY_RETRY_MS` | `src/notifier.js` | Burst coalescing; retry while the target is busy or unreachable |
| `READ_LIMIT_DEFAULT`, `READ_LIMIT_MAX` | `src/engine.js` | `read_messages` page size |

### Known limitations

- **No encryption.** Bodies are signed, not encrypted; whoever can read the share, or observe the TCP traffic, reads the mail. Over TCP an on-path attacker can also drop or inject frames (injected records still fail verification; drops are recovered by the outbox and pulls).
- **TCP listens on loopback by default.** Reaching another machine means saving a non-loopback listen host (an open, unencrypted port) or an SSH tunnel to loopback.
- **"Human-only" is not a security boundary.** It separates the tool surface only. Any local process, an agent's Bash included, can call the plugin's REST API or read its data dir. cc's own API carries the same trust model.
- **A contested name shows nobody.** Two keys announcing the same unpinned name are both hidden (`NAME_CONFLICT`) until one renames. A name pinned to a key stays that key's on this install.
- **Removal relies on the owner's view.** A removed member keeps exactly the messages on the `prev` chain below the last one the owner's install held valid when it removed them. Anything else it signed, earlier forks and messages still in transit to the owner included, becomes invalid for everyone.
- **A party that signs conflicting records can make readers disagree about its own inbox.** Where the lowest record id picks among conflicting records (an owner's two `member` records with one `seq`, an invitee's accept and decline of one invite, two personal invites for one inbox), readers that saw them in different orders can hold different verdicts, and the difference is permanent: a message already refused stays refused. Only that party's own inbox relationship is affected; no third party can cause it or gain from it. Honest installs never sign conflicting records.
- **Full scan per poll.** Every poll lists every directory of interest; large shares scan slower.
- **One transport** per install: a file share or TCP, never both. Installs on different transports cannot reach each other.
- **Over TCP, a member's records come only from that member.** A shared-inbox message reaches a member that was offline when it was sent only once that member and the message's author are online at the same time. More generally, TCP delivery needs both ends online at once; until then the sender keeps the record in its outbox.
- **An identity this install is connected with can steer its TCP dials.** An inbox owner or member, or a card a human imported, chooses the address in its own announce; this install dials it (with backoff). Before the answerer proves the target key, what leaves the process is a `hello` and, once anything answers, a `prove`: the public key of every identity on the endpoint with signatures bound to that connection's nonces, the dial role and the target (not reusable elsewhere). See [docs/transport.md → TCP security](docs/transport.md#tcp-security).
- **Notification needs the backend running** (Auto-start, turned on when a target is picked) **and an idle target**: mail for a busy, exited or missing conductor waits and is retried; a conductor is never resumed for it.

## Docs

- [docs/features.md](docs/features.md) — the page, the tools, notifications
- [docs/protocol.md](docs/protocol.md) — records, validity rules, share layout, TCP wire format and contact cards, REST routes, MCP contract, cc routes used
- [docs/architecture.md](docs/architecture.md) — modules, data dir, ingest pipeline, notifier lifecycle, test patterns
- [docs/transport.md](docs/transport.md) — the transport interface, the file share, direct TCP (dial policy, pulls and cursors, security) and the sketched hub client

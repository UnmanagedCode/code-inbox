# code-inbox

Signed inboxes between code-conductor (cc) installs that can reach the same directory (Dropbox, SMB, NFS), each other over direct TCP, or a shared hub.

- **Identity is the install.** Each cc install has one Ed25519 key; everything it writes is signed with it, and every reader verifies it.
- **Humans control who is connected.** On the plugin's Inbox page a human announces the install, invites others, answers invites and join requests, and manages shared inboxes.
- **Agents read and write.** Every agent of the install gets three MCP tools: `list_inboxes`, `read_messages`, `send_message`.
- **A conductor hears about new mail.** One top-level conductor session per install gets a short prompt when mail arrives, without polling.

Records are signed, not encrypted: anyone who can read the share, the TCP traffic or the hub can read the messages.

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
4. Set a **name** and pick a **transport**: the absolute path of a **share directory**, **TCP** (a listen host and port; loopback by default), or a **hub** (`hub://host:port`, the same for every install of the group: [Run the hub](#run-the-hub)). Then press **Announce**.
   - On TCP or a hub, give your **contact card** (Contacts panel → Copy) to the other humans and **Import** theirs; importing the owner's card is enough to join a shared inbox.
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
             fileShare.js │ endpoint.js core (frames.js, handshake.js, tcpSession.js)
                                 ├─ tcp.js link ──────────► peers' listeners
                                 └─ hubClient.js link (hubConn.js) ──► hub.js (src/hub/hub.js) ──► other installs
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
| `npm run hub -- --host H --port P` | Runs a hub ([Run the hub](#run-the-hub)) |

### Key defaults

| Constant | Where | Governs |
|---|---|---|
| `RECORD_MAX_BYTES`, `BODY_MAX_BYTES`, `NAME_RE` | `src/records.js` | Record size cap, message body cap, name syntax |
| `SHARE_POLL_MS` | `src/transport/fileShare.js` | How often the share is scanned |
| `TCP_DEFAULT_PORT` | `src/transport/tcp.js` | Default listen port (the host defaults to `127.0.0.1`) |
| `TCP_SYNC_MS`, `TCP_MAX_CONNECTIONS`, `TCP_MAX_HANDSHAKING`, `TCP_REDIAL_MIN_MS`, `TCP_REDIAL_MAX_MS` | `src/transport/endpoint.js` | How often contacts are dialed and pulled; session caps; redial (and hub reconnect) backoff. TCP and the hub client alike |
| `TCP_HELLO_FRAME_MAX`, `TCP_FRAME_MAX`, `TCP_BATCH_BYTES`, `TCP_MAX_IDENTITIES`, `TCP_PULL_ROUTES_MAX`, `TCP_WHOIS_MAX` | `src/transport/frames.js` | TCP frame sizes and counts |
| `TCP_HANDSHAKE_MS`, `TCP_FRAME_MS`, `TCP_IDLE_MS`, `TCP_PING_MS`, `TCP_REQUEST_MS`, `TCP_INBOUND_QUEUE`, `TCP_WRITE_BUFFER_MAX` | `src/transport/tcpSession.js` | TCP deadlines, keepalive and buffers |
| `NOTIFY_DEBOUNCE_MS`, `NOTIFY_RETRY_MS` | `src/notifier.js` | Burst coalescing; retry while the target is busy or unreachable |
| `READ_LIMIT_DEFAULT`, `READ_LIMIT_MAX` | `src/engine.js` | `read_messages` page size |
| `OUTBOX_RETRY_MS` | `src/engine.js` | How often writes waiting in the outbox are re-sent |
| `TCP_LOOKUP_MS` | `src/transport/addr.js` | How long a TCP or hub host's DNS lookup may take when settings are checked |
| `HUB_DEFAULT_PORT`, `HUB_MAX_LINKS`, `HUB_MAX_HANDSHAKING`, `HUB_MAX_STREAMS`, `HUB_WRITE_BUFFER_MAX`, `HUB_CONTROL_BUFFER_MAX` | `src/hub/hub.js` | The hub's default port (host `127.0.0.1`); link, handshake and per-link stream caps; stream data held toward one stream end; how far a link's whole total (data and control frames) may pass its data total. The hub holds at most `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` + `HUB_CONTROL_BUFFER_MAX` toward one link ([docs/hub.md → Limits](docs/hub.md#limits-srchubhubjs-srctransportframesjs)) |
| `HUB_FRAME_MAX`, `HUB_CHUNK_BYTES`, `HUB_WATCH_MAX` | `src/transport/frames.js` | Hub-link frame size; tunneled bytes per `data` frame; fps per watch |
| `HUB_STREAM_BUFFER_MAX` | `src/transport/hubClient.js` | Inbound bytes a paused stream holds before it is closed |

### Run the hub

```
node hub.js [--host HOST] [--port PORT]      # or: npm run hub -- --host HOST --port PORT
```

- Listens on `127.0.0.1:HUB_DEFAULT_PORT` by default. Expose it deliberately: `--host 0.0.0.0` (or an interface IP), or an SSH tunnel or reverse proxy to loopback. A non-loopback host logs a warning.
- Stores nothing, holds no key, needs no `npm install` and no cc. SIGTERM / SIGINT stop it; a restart loses nothing.
- Every install of a group saves the same `hub://host:port`. The hub cannot forge a sender, but it reads every record and sees who talks to whom.
- Details, limits and the threat model: [docs/hub.md](docs/hub.md).

### Known limitations

- **No encryption.** Bodies are signed, not encrypted; whoever can read the share, or observe the TCP traffic, reads the mail. Over TCP an on-path attacker can also drop or inject frames (injected records still fail verification; drops are recovered by the outbox and pulls).
- **TCP listens on loopback by default.** Reaching another machine means saving a non-loopback listen host (an open, unencrypted port) or an SSH tunnel to loopback.
- **"Human-only" is not a security boundary.** It separates the tool surface only. Any local process, an agent's Bash included, can call the plugin's REST API or read its data dir. cc's own API carries the same trust model.
- **A contested name shows nobody.** Two keys announcing the same unpinned name are both hidden (`NAME_CONFLICT`) until one renames. A name pinned to a key stays that key's on this install.
- **Removal relies on the owner's view.** A removed member keeps exactly the messages on the `prev` chain below the last one the owner's install held valid when it removed them. Anything else it signed, earlier forks and messages still in transit to the owner included, becomes invalid for everyone.
- **A party that signs conflicting records can make readers disagree about its own inbox.** Where the lowest record id picks among conflicting records (an owner's two `member` records with one `seq`, an invitee's accept and decline of one invite, two personal invites for one inbox), readers that saw them in different orders can hold different verdicts, and the difference is permanent: a message already refused stays refused. Only that party's own inbox relationship is affected; no third party can cause it or gain from it. Honest installs never sign conflicting records.
- **Full scan per poll.** Every poll lists every directory of interest; large shares scan slower.
- **A share that is not mounted holds writes back.** Saving the share creates `<share>/code-inbox/v1` (`SHARE_ROOT`); from then on a write needs that root to exist already. While it does not (the mount is down, and the mount point is missing or an empty directory), sends succeed but wait in the outbox (the Transport panel shows the count and the last error) and are retried every `OUTBOX_RETRY_MS`; nothing is written under the mount point. Readers see those records only after the retry.
  - **Not detected:** an unmounted mount point that itself holds a `code-inbox/v1` tree on the local disk takes writes like a mounted share. That tree can be copied there, written before this rule, or **created by saving the share while its mount was down**: save the share only with it mounted.
  - **A share saved but never written to** by an older version has no root yet: it stays unavailable until a human saves the share again.
- **One transport** per install: a file share, TCP or a hub, never two. Installs on different transports (or different hubs) cannot reach each other.
- **A hub reads and can tamper with what it relays.** It sees every record, every fingerprint registered on it and who dials whom; it can drop, delay or inject frames, and an injected pull makes a peer send it anything that peer's proven counterpart may read, history included. It can never forge a record or a sender. See [docs/hub.md → Hub security](docs/hub.md#hub-security).
- **Over TCP or a hub, a member's records come only from that member.** A shared-inbox message reaches a member that was offline when it was sent only once that member and the message's author are online at the same time. More generally, delivery needs both ends online at once (the hub stores nothing); until then the sender keeps the record in its outbox.
- **An identity this install is connected with can steer its TCP dials.** An inbox owner or member, or a card a human imported, chooses the address in its own announce; this install dials it (with backoff). Before the answerer proves the target key, what leaves the process is a `hello` and, once anything answers, a `prove`: the public key of every identity on the endpoint with signatures bound to that connection's nonces, the dial role and the target (not reusable elsewhere). See [docs/transport.md → TCP security](docs/transport.md#tcp-security).
- **Notification needs the backend running** (Auto-start, turned on when a target is picked) **and an idle target**: mail for a busy, exited or missing conductor waits and is retried; a conductor is never resumed for it.

## Docs

- [docs/features.md](docs/features.md) — the page, the tools, notifications
- [docs/protocol.md](docs/protocol.md) — records, validity rules, share layout, TCP and hub-link wire formats and contact cards, REST routes, MCP contract, cc routes used
- [docs/architecture.md](docs/architecture.md) — modules, data dir, ingest pipeline, notifier lifecycle, test patterns
- [docs/transport.md](docs/transport.md) — the transport interface, the file share, the network endpoint core and direct TCP (dial policy, pulls and cursors, security)
- [docs/hub.md](docs/hub.md) — the hub and the hub client: running it, streams, dial policy and presence, limits, security

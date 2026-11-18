# code-inbox

Signed inboxes between code-conductor (cc) installs that can reach the same directory (Dropbox, SMB, NFS), or each other over the network: directly, or through one or more hubs.

- **Identity is the install.** Each cc install has one Ed25519 key; everything it writes is signed with it, and every reader verifies it.
- **Humans control who is connected.** On the plugin's Code Inbox page a human announces the install, invites others, answers invites and join requests, and manages shared inboxes.
- **Agents read and write.** Every agent of the install gets three MCP tools: `list_inboxes`, `read_messages`, `send_message`.
- **A conductor hears about new mail.** One top-level conductor session per install gets a short prompt when mail arrives, without polling.

Records are signed, not encrypted: anyone who can read the share, the network traffic or a hub can read the messages.

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
3. Open **Code Inbox** in cc's navigation.
4. Set a **name** and pick a **transport**: the absolute path of a **share directory**, or **Network**: an optional listener (a host and port; loopback by default) plus any number of **connections** (`host:port` of another install's listener or of a hub: [Run the hub](#run-the-hub)). Then press **Announce**.
   - In network mode everyone you are connected to, or who shares a hub with you, appears in the **Directory** and can be invited. A **contact card** (Contacts panel → Copy) says who you are, not where: importing one makes that identity a contact.
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
Code Inbox page (humans) ─┐              ┌─ MCP tools (agents: list / read / send)
                          ▼              ▼
                      routes.js ────► engine.js ◄──── notifier.js ──► cc send_prompt
                                     │  ▲      │
            records.js (verify) ◄────┘  │      └──► store.js ($DATA: accepted log, pending, outbox, cursors)
            state.js (pure fold) ◄──────┘
                                     │
                       transport interface (src/transport/index.js)
                                     │
             fileShare.js │ network.js → endpoint.js core (frames.js, handshake.js, tcpSession.js)
                                 ├─ listener.js ◄──────────────────────── peers' connections
                                 └─ connection.js (greeting.js) ─┬─ peer ──► a peer's listener
                                                                 └─ hub (hubLink.js, hubConn.js) ──► hub.js (src/hub/hub.js) ──► other installs
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
| `ANNOUNCE_MAX_BYTES` | `src/records.js` | An announce record's size: announces are held in memory and broadcast by hubs |
| `TCP_DEFAULT_PORT`, `CONNECTIONS_MAX` | `src/transport/network.js` | Default listen port (the host defaults to `127.0.0.1`); configured connections |
| `TCP_SYNC_MS`, `TCP_MAX_CONNECTIONS`, `TCP_MAX_HANDSHAKING`, `TCP_REDIAL_MIN_MS`, `TCP_REDIAL_MAX_MS` | `src/transport/endpoint.js` | How often connections are maintained, contacts dialed and pulled; session caps; reconnect and hub-dial backoff |
| `TCP_HELLO_FRAME_MAX`, `TCP_FRAME_MAX`, `TCP_BATCH_BYTES`, `TCP_MAX_IDENTITIES`, `TCP_PULL_ROUTES_MAX` | `src/transport/frames.js` | Endpoint frame sizes and counts |
| `TCP_HANDSHAKE_MS`, `TCP_FRAME_MS`, `TCP_IDLE_MS`, `TCP_PING_MS`, `TCP_REQUEST_MS`, `TCP_INBOUND_QUEUE`, `TCP_WRITE_BUFFER_MAX` | `src/transport/tcpSession.js` | Session deadlines (the greeting's too), keepalive and buffers |
| `NOTIFY_DEBOUNCE_MS`, `NOTIFY_RETRY_MS` | `src/notifier.js` | Burst coalescing; retry while the target is busy or unreachable |
| `READ_LIMIT_DEFAULT`, `READ_LIMIT_MAX` | `src/engine.js` | `read_messages` page size |
| `OUTBOX_RETRY_MS` | `src/engine.js` | How often writes waiting in the outbox are re-sent |
| `TCP_LOOKUP_MS`, `ADDRESS_MAX_CHARS` | `src/transport/addr.js` | How long a host's DNS lookup may take when network settings are checked; a connection address's length |
| `HUB_DEFAULT_PORT`, `HUB_MAX_LINKS`, `HUB_MAX_HANDSHAKING`, `HUB_MAX_STREAMS`, `HUB_WRITE_BUFFER_MAX`, `HUB_CONTROL_BUFFER_MAX` | `src/hub/hub.js` | The hub's default port (host `127.0.0.1`); link, handshake and per-link stream caps; stream data held toward one stream end; how far a link's whole total (data and control frames) may pass its data total. The hub holds at most `HUB_MAX_STREAMS` × `HUB_WRITE_BUFFER_MAX` + `HUB_CONTROL_BUFFER_MAX` toward one link ([docs/hub.md → Limits](docs/hub.md#limits-srchubhubjs-srctransportframesjs)) |
| `HUB_FRAME_MAX`, `HUB_CHUNK_BYTES` | `src/transport/frames.js` | Hub-link frame size; tunneled bytes per `data` frame |
| `HUB_STREAM_BUFFER_MAX` | `src/transport/hubLink.js` | Inbound bytes a paused stream holds before it is closed |

### Run the hub

```
node hub.js [--host HOST] [--port PORT]      # or: npm run hub -- --host HOST --port PORT
```

- Listens on `127.0.0.1:HUB_DEFAULT_PORT` by default. Expose it deliberately: `--host 0.0.0.0` (or an interface IP), or an SSH tunnel or reverse proxy to loopback. A non-loopback host logs a warning.
- Stores nothing, holds no key, needs no `npm install` and no cc. SIGTERM / SIGINT stop it; a restart loses nothing.
- Every install that uses it adds a connection to its `host:port`; an install may use several hubs. The hub tells every client who else is on it (fingerprints and names); it cannot forge a sender, but it reads every record and sees who talks to whom.
- Details, limits and the threat model: [docs/hub.md](docs/hub.md).

### Known limitations

- **No encryption.** Bodies are signed, not encrypted; whoever can read the share, or observe the network traffic, reads the mail. On the network an on-path party can also drop or inject frames (injected records still fail verification; drops are recovered by the outbox and pulls).
- **Network parties are trusted.** Peers, hubs, connection targets and strangers on a hub are assumed not to abuse the network: signatures, writer binding, scoped serving and the caps hold, but no rate limits or anti-abuse defences are designed. Anyone who can reach this install (a common hub, a connection) can invite it; invites are answered by a human.
- **The listener binds loopback by default.** Reaching another machine means saving a non-loopback listen host (an open, unencrypted port) or an SSH tunnel to loopback. A listener reveals which fingerprints sit behind its address to anyone who proves a key there.
- **"Human-only" is not a security boundary.** It separates the tool surface only. Any local process, an agent's Bash included, can call the plugin's REST API or read its data dir. cc's own API carries the same trust model.
- **A contested name shows nobody.** Two keys announcing the same unpinned name are both hidden (`NAME_CONFLICT`) until one renames. A name pinned to a key stays that key's on this install.
- **Removal relies on the owner's view.** A removed member keeps exactly the messages on the `prev` chain below the last one the owner's install held valid when it removed them. Anything else it signed, earlier forks and messages still in transit to the owner included, becomes invalid for everyone.
- **A party that signs conflicting records can make readers disagree about its own inbox.** Where the lowest record id picks among conflicting records (an owner's two `member` records with one `seq`, an invitee's accept and decline of one invite, two personal invites for one inbox), readers that saw them in different orders can hold different verdicts, and the difference is permanent: a message already refused stays refused. Only that party's own inbox relationship is affected; no third party can cause it or gain from it. Honest installs never sign conflicting records.
- **Full scan per poll.** Every poll lists every directory of interest; large shares scan slower.
- **A share that is not mounted holds writes back.** Saving the share creates `<share>/code-inbox/v1` (`SHARE_ROOT`); from then on a write needs that root to exist already. While it does not (the mount is down, and the mount point is missing or an empty directory), sends succeed but wait in the outbox (the Transport panel shows the count and the last error) and are retried every `OUTBOX_RETRY_MS`; nothing is written under the mount point. Readers see those records only after the retry.
  - **Not detected:** an unmounted mount point that itself holds a `code-inbox/v1` tree on the local disk takes writes like a mounted share. That tree can be copied there, written before this rule, or **created by saving the share while its mount was down**: save the share only with it mounted.
  - **A share saved but never written to** by an older version has no root yet: it stays unavailable until a human saves the share again.
- **One mode** per install: the file share or network mode, never both. Installs in different modes cannot reach each other; in network mode, two installs need a common hub or a connection between them.
- **A hub sees a lot.** Every client on a hub sees every other client's fingerprint, name and online times. The hub reads every record it relays, sees who dials whom, and can drop, delay or inject frames; it never receives a contact list and can never forge a record or a sender. See [docs/hub.md → Hub security](docs/hub.md#hub-security).
- **Two connections to one hub** register the same identity twice: the later wins and the other shows `HUB_DUPLICATE`.
- **In network mode, a member's records come only from that member.** Two members of a shared inbox exchange records only over a session between them (a common hub, or a connection from one to the other); members connected only to the owner exchange with the owner, never with each other. A message reaches a member that was offline when it was sent only once that member and its author are online at the same time; until then the sender keeps the record in its outbox.
- **Strangers' names are not kept.** Announces live in memory; only contacts' and counterparties' names survive a restart.
- **Notification needs the backend running** (Auto-start, turned on when a target is picked) **and an idle target**: mail for a busy, exited or missing conductor waits and is retried; a conductor is never resumed for it.

## Docs

- [docs/features.md](docs/features.md) — the page, the tools, notifications
- [docs/protocol.md](docs/protocol.md) — records, validity rules, share layout, endpoint and hub-link wire formats and contact cards, REST routes, MCP contract, cc routes used
- [docs/architecture.md](docs/architecture.md) — modules, data dir, ingest pipeline, notifier lifecycle, test patterns
- [docs/transport.md](docs/transport.md) — the transport interface, the file share, network mode (listener, connections, duplicates, dial policy, pulls and cursors, security)
- [docs/hub.md](docs/hub.md) — the hub and the hub mode of a connection: running it, the roster, streams, dial policy, limits, security

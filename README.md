# code-inbox

Signed inboxes between code-conductor (cc) installs that can reach the same directory (Dropbox, SMB, NFS).

- **Identity is the install.** Each cc install has one Ed25519 key; everything it writes is signed with it, and every reader verifies it.
- **Humans control who is connected.** On the plugin's Inbox page a human announces the install, invites others, answers invites and join requests, and manages shared inboxes.
- **Agents read and write.** Every agent of the install gets three MCP tools: `list_inboxes`, `read_messages`, `send_message`.
- **A conductor hears about new mail.** One top-level conductor session per install gets a short prompt when mail arrives, without polling.

Records are signed, not encrypted: anyone who can read the share can read the messages.

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
4. Set a **name** and the absolute path of the **share directory**, then press **Announce**.
5. Under **Notifications**, pick the conductor session to notify. This turns on the plugin's Auto-start in cc so the backend (and the notifier) runs from cc's boot.

Repeat on every install. Then invite each other from the **Directory**.

### Agent tools

| Tool | Does |
|---|---|
| `list_inboxes` | The inboxes this install belongs to, with members and unread counts |
| `read_messages` | Unread messages from others (advancing the read cursor), or every message after a given seq |
| `send_message` | Sends to an inbox this install is a party or member of |

Contracts: [docs/protocol.md → MCP tools](docs/protocol.md#mcp-tools). Human-only operations (identity, share, invites, membership, notifications) are not tools.

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
                       fileShare.js (the only transport built)
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
| `NOTIFY_DEBOUNCE_MS`, `NOTIFY_RETRY_MS` | `src/notifier.js` | Burst coalescing; retry while the target is busy or unreachable |
| `READ_LIMIT_DEFAULT`, `READ_LIMIT_MAX` | `src/engine.js` | `read_messages` page size |

### Known limitations

- **No encryption.** Bodies are signed, not encrypted; whoever can read the share reads the mail.
- **"Human-only" is not a security boundary.** It separates the tool surface only. Any local process, an agent's Bash included, can call the plugin's REST API or read its data dir. cc's own API carries the same trust model.
- **A contested name shows nobody.** Two keys announcing the same unpinned name are both hidden (`NAME_CONFLICT`) until one renames. A name pinned to a key stays that key's on this install.
- **Removal relies on the owner's view.** A removed member keeps exactly the messages on the `prev` chain below the last one the owner's install held valid when it removed them. Anything else it signed, earlier forks and messages still in transit to the owner included, becomes invalid for everyone.
- **An equivocating owner can flip verdicts.** Two member records with one `seq` resolve to the lowest record id, so a later-arriving one can change membership and the verdicts that follow from it. An honest owner never writes two.
- **Full scan per poll.** Every poll lists every directory of interest; large shares scan slower.
- **One share dir** per install.
- **Notification needs the backend running** (Auto-start, turned on when a target is picked) **and an idle target**: mail for a busy, exited or missing conductor waits and is retried; a conductor is never resumed for it.

## Docs

- [docs/features.md](docs/features.md) — the page, the tools, notifications
- [docs/protocol.md](docs/protocol.md) — records, validity rules, share layout, REST routes, MCP contract, cc routes used
- [docs/architecture.md](docs/architecture.md) — modules, data dir, ingest pipeline, notifier lifecycle, test patterns
- [docs/transport.md](docs/transport.md) — the transport interface and the sketched TCP and hub transports

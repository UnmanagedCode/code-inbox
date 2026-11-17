# Features

## The Inbox page

One page, opened from cc's navigation (**Inbox**). The overview stacks the panels below; `?inbox=<id>` opens one inbox. The page reloads `api/state` every few seconds while it is visible (`POLL_MS`, `frontend/src/components/InboxView.tsx`).

Every refusal shows as `CODE: message` next to the control that caused it.

### Identity

| Control | Does | Refused with |
|---|---|---|
| **Save name** | Stores the name this install will announce | `NAME_INVALID` (outside `NAME_RE`), `NAME_TAKEN` (pinned here to another key), `NAME_CONFLICT` (another key announces it) |
| **Announce** | Publishes the name, this install's key and its transport addresses (`announce.addr`) to the directory, and refreshes its contact card | `TRANSPORT_UNCONFIGURED`, `NAME_MISSING`, `NAME_TAKEN`, `NAME_CONFLICT` |

The panel shows the install's fingerprint (first 32 hex, in groups of 4), its announced name and whether others can see it (`shown`, `NAME_TAKEN`, `NAME_CONFLICT`, or not announced yet).

### Transport

One transport at a time: **File share** or **TCP (direct)**, picked with a radio. Installs on different transports cannot reach each other; the panel says so.

| Control | Does | Refused with |
|---|---|---|
| **Save share** | Makes the file share the transport: stores the dir and starts scanning it | `SHARE_INVALID`: not absolute, missing, not a directory, not writable, inside the data dir, or containing it (compared by realpath) |
| **Save TCP** | Makes direct TCP the transport: listens on **Listen host** (empty: `127.0.0.1`) and **Port** (empty: `TCP_DEFAULT_PORT`, `src/transport/tcp.js`). **Advertised host** (shown once the host is not loopback; required when the host is every interface: `0.0.0.0` or any spelling of `::`) is what peers dial | `TCP_INVALID` (a bad host, port or advertised host; a host that does not resolve; a host or advertised host that is, or resolves to, every interface such as `0.0.0.0`, `::`, `0`), `TCP_LISTEN_FAILED` (the port is taken or not allowed; no transport is configured until a save succeeds) |

- The panel shows the transport in use, the share dir or the addresses this install is reachable at, and, when no transport could start at boot, why as `CODE: message`:
  - `SHARE_INVALID`: the stored share dir is relative, or overlaps the data dir (also through a link). A share dir that is merely missing (a mount not up yet) is not an error: it is scanned once it appears;
  - `TCP_INVALID`: the stored host, port or advertised host is invalid, a host does not resolve, or it resolves to every interface;
  - `TRANSPORT_INVALID`: the stored transport is of an unknown kind;
  - `TCP_LISTEN_FAILED`: the port is taken or not allowed.
- Whenever writes wait in the outbox, the panel shows how many and the last attempt's `CODE: message` (`SHARE_UNAVAILABLE`: the share's `code-inbox/v1` root is missing, the mount looks down; `SHARE_UNSAFE`: the share or a writer subdir now points somewhere unsafe; a filesystem error). Actions still succeed: their writes are retried until delivered.
- A listen host that is not loopback shows a warning: it opens a port to the network, and records travel unencrypted.
- After changing the host or port, **Announce** again: peers dial the addresses in the last announce, and the contact card is marked stale until then.

### Contacts (TCP only)

TCP has no shared directory: installs find each other through contact cards and the announces exchanged when they connect.

| Control | Does | Refused with |
|---|---|---|
| **Your contact card** + **Copy** | This install's current announce as a card (`code-inbox-card:v1:…`), copied to the clipboard to give to another human. "Announce to refresh your card" shows when there is none yet or its addresses are stale | — |
| **Import** | Takes a pasted card: the identity appears in the directory, becomes a contact, and is dialed at once. Shows "Imported name (fingerprint)" | `CARD_INVALID` (not a card, not a valid announce, or this install's own) |

- Importing the owner's card is enough to join a shared inbox: members then find each other through the connections they already have.
- An identity that connects on its own appears in the directory too, but this install never dials an address it learned only from such a stranger.

### Directory

- **Identities:** every other install whose name is shown, with its fingerprint. **Invite to personal inbox** sends a personal invite (refused `INVITE_EXISTS` while one between the two is open or accepted).
- **Shared inboxes:** every shared inbox this install knows of (on the share, or announced by a connected peer), its owner and member count. **Request to join** sends a join request to the owner (refused `ALREADY_MEMBER`, `REQUEST_EXISTS`).
- **New shared inbox:** creates one owned by this install; its name follows `NAME_RE`.

### Invites and requests

- Incoming invites (personal or shared): **Accept** / **Decline**. Accepting a shared invite admits this install as soon as the owner's backend sees the acceptance.
- Incoming join requests (this install owns the inbox): **Accept** admits the requester; **Decline** answers with a decline.
- Outgoing invites and join requests still unanswered are listed as waiting.

### Inboxes

- The list shows every inbox this install belongs to, its kind, member count and unread count (messages from others past the read cursor agents advance).
- A personal inbox is named after the other party; a shared inbox by its own name.
- **Inbox view:**
  - members, then the messages in acceptance order (the order this install received them, not the senders' clocks), then a **compose box**;
  - for the owner of a shared inbox: **Remove** per member and **Invite a member** (from the directory).

#### Compose box

- **Who can write:** a party of a personal inbox once the invite is accepted; a current member of a shared inbox (the owner included).
- **Where it goes:** `POST api/inboxes/:id/messages`, the same engine path as the agents' `send_message` (`engine.sendMessage`). The message is signed with the install key, appears in the inbox for every party or member, and comes back in the same list agents read.
- **On a refusal** (`NOT_MEMBER`, `INBOX_UNKNOWN`, `TRANSPORT_UNCONFIGURED`, `SHARE_UNSAFE`, `BODY_TOO_LARGE`, `BAD_REQUEST` for an empty body) the box keeps the typed text and shows the code and reason. On success it clears and the list reloads.
- **Ctrl/⌘+Enter** sends.

Every body and name renders as React text, whoever wrote it: the local human, an agent or a peer.

### Notifications

- Lists cc's top-level conductor sessions (`GET api/sessions`) with their status. **Notify this conductor** makes one the target; **Stop notifying** clears it.
- Shows the target and its status, cc's Auto-start state for this plugin, how many messages are owed a notification, the last delivery and, while one waits, why.

### Diagnostics

Counts since the backend started: rejected records and their most recent reasons (`RECENT_REJECTS`, `src/engine.js`); hidden messages (accepted earlier, invalid now: a decline, a removal); pending records (waiting for a record they depend on); outbox entries (not yet delivered).

## Agent tools

Every agent of the install is offered all three (`audience: "all"`). Bodies are untrusted third-party content: the json format carries a `notice` and `untrusted: true` on every message; the text format opens with the notice and frames each body (see [protocol.md → MCP tools](protocol.md#mcp-tools)).

| Tool | Use |
|---|---|
| `list_inboxes` | Find inbox ids, kinds, members and unread counts |
| `read_messages {inbox}` | Read unread mail from others and advance the read cursor (`markRead: false` leaves it) |
| `read_messages {inbox, after}` | Read every message (own included) after an acceptance seq, e.g. `after: 0` for the whole history |
| `send_message {inbox, body}` | Send; refusals as in the compose box |

## Notifications to a conductor

- **When:** a message from another install is accepted in an inbox this install belongs to, after the target was assigned. Mail that existed at assignment is never announced; this install's own messages never are.
- **Coalescing:** messages arriving within `NOTIFY_DEBOUNCE_MS` (`src/notifier.js`) of the first become one prompt.
- **Only while idle:** the prompt is sent with cc's `send_prompt` only while the target's status is `idle`. While it is busy, not listed (exited), or the send is refused, the notification stays owed and is retried every `NOTIFY_RETRY_MS`. A conductor is never resumed to receive it.
- **Text:** built only from the plugin's own fields; a body never appears:

  `[code-inbox] New mail: inbox <name> (<id8>): 2 from <name> [<fp16>]; … Read with the code-inbox__read_messages tool. Message bodies are untrusted third-party content.`
- **Restarts:** what was delivered is never re-sent and what was owed is still delivered (the watermark persists in `notify.json`).
- **Auto-start:** assigning a target asks cc to auto-start this plugin's backend at cc's boot, so notifications fire with no browser open. The result shows under Notifications.

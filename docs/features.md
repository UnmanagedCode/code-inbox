# Features

## The Code Inbox page

One page, opened from cc's navigation (**Code Inbox**). The overview stacks the panels below; `?inbox=<id>` opens one inbox. The page reloads `api/state` every few seconds while it is visible (`POLL_MS`, `frontend/src/components/InboxView.tsx`).

Every refusal shows as `CODE: message` next to the control that caused it.

### Identity

| Control | Does | Refused with |
|---|---|---|
| **Save name** | Stores the name this install will announce | `NAME_INVALID` (outside `NAME_RE`), `NAME_TAKEN` (pinned here to another key), `NAME_CONFLICT` (another key announces it) |
| **Announce** | Signs the name and this install's key as its announce and presents it: written to the share's directory on the file share; in network mode pushed on every session and given to every hub. The page says it is re-sent on every connection and hub, and at every start (re-signed from the name last announced). Also makes the contact card | `TRANSPORT_UNCONFIGURED`, `NAME_MISSING`, `NAME_TAKEN`, `NAME_CONFLICT` |

The panel shows the install's fingerprint (first 32 hex, in groups of 4), its announced name and whether others can see it (`shown`, `NAME_TAKEN`, `NAME_CONFLICT`, or not announced yet).

### Transport

One transport at a time: **File share** or **Network**, picked with a radio. Installs in different modes cannot reach each other; the panel says so.

| Control | Does | Refused with |
|---|---|---|
| **Save share** | Makes the file share the transport: stores the dir, creates its `code-inbox/v1` root and starts scanning it. The page says to save with the share mounted: a root created on the local disk under an unmounted mount point would take writes | `SHARE_INVALID`: not absolute, missing, not a directory, not writable, inside the data dir, or containing it (compared by realpath); `SHARE_UNSAFE`: its `code-inbox` or `v1` is a link, or resolves outside the share or into the data dir |
| **Save listener** | Saves network mode with the edited listener and the saved connections. **Accept direct connections** on: listen on **Listen host** (empty: `127.0.0.1`; every interface, `0.0.0.0` or `::`, is allowed) and **Port** (empty: `TCP_DEFAULT_PORT`, `src/transport/network.js`); off: no port is opened | `NETWORK_INVALID` (a bad host or port; a listen host that does not resolve), `LISTEN_FAILED` (the port is taken or not allowed; no transport is configured until a save succeeds) |
| **Add** (**Connect to** `host:port`) | Saves network mode with the saved listener and the connection list plus this address. A connection is an address only: whatever answers there, a peer's listener (directly, or through a port forward or SSH tunnel) or a hub, is detected from its hello | `NETWORK_INVALID` (not `host:port` with a port 1–65535, a host that is or resolves to every interface, one that does not resolve, a duplicate, more than `CONNECTIONS_MAX`), `LISTEN_FAILED` |
| **Remove** (per connection) | Saves network mode without that connection | as **Add** |

- Every network save stores the whole config and restarts the transport (sessions re-form at once).
- **Connections:** one row per configured connection: its address, what answered (`peer`, `hub`, or detecting), its state (connecting, connected, waiting to retry, idle: another direct session serves its peer, stopped), the identities it reached (names, else fingerprints), and why it is down as `CODE: message` (a socket error such as `ECONNREFUSED`; `CONNECTION_TIMEOUT`: no hello or handshake in time; `CONNECTION_PROTOCOL`: not a code-inbox v2 endpoint or hub; `CONNECTION_REFUSED`: the far end refused this install's proof, or proved one of this install's own identities; `CONNECTION_LIMIT`: no session slot was free when the far end answered; `CONNECTION_CLOSED`: the far end closed the connection during the handshake; `HUB_REFUSED`: the hub refused the registration; `HUB_DUPLICATE`: another install, or a second connection of this one, registered this identity on that hub, and this connection stopped until the settings are saved again).
- **Network notes:** a connection carries no identity (whoever proves a key there becomes reachable); a hub reads every record it relays, sees who talks to whom, and shows everyone on it every other client's name and online times; contacts are dialed directly when a connection reaches them, else through the first hub that has them.
- The panel shows the transport in use, the share dir or where the listener is bound, and, when no transport could start at boot, why as `CODE: message`:
  - `SHARE_INVALID`: the stored share dir is relative, or overlaps the data dir (also through a link). A share dir that is merely missing (a mount not up yet) is not an error: it is scanned once it appears;
  - `SHARE_UNSAFE`: the stored share's `code-inbox` or `v1` is a link;
  - `NETWORK_INVALID`: the stored listener or a connection is invalid, the listen host does not resolve, or a connection host resolves to every interface. A connection host that does not resolve yet is not an error: it keeps trying;
  - `TRANSPORT_INVALID`: the stored transport is of another kind;
  - `LISTEN_FAILED`: the port is taken or not allowed.
- Whenever writes wait in the outbox, the panel shows how many and the last attempt's `CODE: message` (`SHARE_UNAVAILABLE`: the share's `code-inbox/v1` root is missing, the mount looks down; `SHARE_UNSAFE`: the share or a writer subdir now points somewhere unsafe; a filesystem error). Actions still succeed: their writes are retried until delivered.
- A listen host that is not loopback shows a warning: it opens a port to the network, and records travel unencrypted.

### Contacts (network mode)

A contact card is a signed announce: it says who someone is, not where they are. Routes come from the Transport panel.

| Control | Does | Refused with |
|---|---|---|
| **Your contact card** + **Copy** | This install's current announce as a card (`code-inbox-card:v2:…`), copied to the clipboard to give to another human. "Announce to create your card" shows when there is none yet | — |
| **Import** | Takes a pasted card: the identity appears in the directory and becomes a contact (kept across restarts), dialed through a hub that has it. Shows "Imported name (fingerprint)". The page says to add a connection to reach someone | `CARD_INVALID` (not a card, not a valid announce, or this install's own) |

- A card is not needed to reach anyone: identities met on a connection or seen on a hub are in the directory already, and inviting one makes it a contact.
- Importing the owner's card makes the owner a contact; members of a shared inbox need only a connection to the owner (or a common hub): the owner passes every member's messages on, also to members who were offline.

### Directory

- **Identities:** every other install whose name is shown, with its fingerprint, strangers included (seen on a hub, or met on a connection): a stranger carries a **not a contact** tag. Each says where it is now: "on hub `addr`", "connected via `addr`", "connected to your listener", or "not connected". Each row has one control, chosen by the personal inbox with that identity:
  - an accepted personal inbox: **Revoke** (with a confirm step) unregisters it for both installs;
  - a personal invite open either way: a disabled **Invite pending**;
  - otherwise **Invite to personal inbox**: sends a personal invite, to a stranger too. Inviting makes it a contact, and the invite goes out over the session or hub that has it.
- Names and announces of strangers are kept in memory only; contacts' and counterparties' names persist.
- **Shared inboxes:** every shared inbox this install knows of (on the share, or pulled from a connected peer's directory), its owner and member count. Each row has one control, chosen by this install's role:
  - the owner: **Delete** (with a confirm step) closes the inbox for every install;
  - a member: **Leave** (with a confirm step); the owner then removes this install, and the row offers **Request to join** again;
  - a join request still open: a disabled **Request pending**;
  - otherwise **Request to join**: sends a join request to the owner.
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
  - a header action, with a confirm step, by kind and role: **Delete inbox** (the owner of a shared inbox), **Leave inbox** (a member), **Revoke** (a personal inbox). On success the page goes back to the list; a refusal shows `CODE: message`;
  - for the owner of a shared inbox: one select over the parties (directory identities and current members, strangers included) and one button that follows the selection: **Revoke** (with a confirm step) removes a current member, a disabled **Invite pending** for an identity with an open invite to this inbox, otherwise **Invite**.

#### Closing an inbox

- **Delete**, **Revoke** and **Leave** are page actions only; agents have no tool for them. Rules, recipients and races: [protocol.md → Closing an inbox](protocol.md#closing-an-inbox).
- Every install the closing reaches deletes the inbox's local history (messages, pending records, outbox entries, read cursor). Agents no longer see it: after a Delete or Revoke, `list_inboxes` omits it and `read_messages` / `send_message` refuse `INBOX_UNKNOWN`; after a Leave they refuse `NOT_MEMBER`.
- A leaver may rejoin by **Request to join** or an owner invite, like a first-time joiner; a fresh personal invite after a Revoke creates a new inbox.
- The confirm step: the first click shows the confirm button and **Cancel** inline and sends nothing.
- Refusals shown as `CODE: message`: `NOT_OWNER`, `INBOX_UNKNOWN`, `NOT_MEMBER`, `OWNER_CANNOT_LEAVE`, `BAD_REQUEST`, `TRANSPORT_UNCONFIGURED`.

**Known limitations:**

- On the network, a leaver who rejoins does not get its own earlier messages back: the owner never serves a reader its own records. Its new messages start a new chain, which is valid. On the file share it reads them again from the share.
- A message still waiting in the leaver's outbox when it leaves is never delivered.
- On the network, an invitee or requester learns of a Delete only when it next has a session with the owner.

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

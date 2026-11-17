import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, readJson, writeFileAtomic, writeJson } from './fsAtomic.js';
import { withLock } from './mutex.js';
import { FP_RE } from './records.js';
import { isRoute } from './transport/index.js';

// The install's local state under the data dir, written only by this backend (docs/architecture.md → Data dir).
// Every write goes through one lock per data dir. accepted.ndjson is append-only and assigns the acceptance seq.
export const FILES = {
  settings: 'settings.json',
  pins: 'pins.json',
  accepted: 'accepted.ndjson',
  pending: 'pending.ndjson',
  rejected: 'rejected.ndjson',
  outbox: 'outbox.json',
  cursors: 'cursors.json',
  notify: 'notify.json',
  peerCursors: 'peer-cursors.json',
  contacts: 'contacts.json',
};

export const DEFAULT_SETTINGS = { name: null, transport: null, notifyTarget: null };

// One-shot settings migration: {shareDir} becomes transport {kind:'file-share', dir} (null: none), and the
// shareDir key is dropped. Resolves the settings as stored; writes only when something changed.
async function migrateSettings(file) {
  const raw = await readJson(file, {});
  if (!Object.hasOwn(raw, 'shareDir')) return raw;
  const { shareDir, ...rest } = raw;
  const next = { ...rest, transport: rest.transport ?? (shareDir ? { kind: 'file-share', dir: shareDir } : null) };
  await writeJson(file, next);
  return next;
}

const toLine = (e) => `${JSON.stringify({ seq: e.seq, id: e.id, route: e.route, bytes: Buffer.from(e.bytes).toString('base64') })}\n`;

// Parses an ndjson file of {route, bytes(b64), …}; a line that does not parse (a torn last write) is skipped and logged.
async function readNdjson(file, log) {
  return (await readLines(file, log)).map((e) => ({ ...e, bytes: Buffer.from(e.bytes, 'base64') }));
}

// Parses an ndjson file; a line that does not parse (a torn last write) is skipped and logged.
async function readLines(file, log) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      log.warn(`code-inbox: ${path.basename(file)} line ${i + 1} does not parse (a torn write?): skipped`);
    }
  });
  return out;
}

export function createStore(dataDir, { log = console } = {}) {
  const file = (k) => path.join(dataDir, FILES[k]);
  const locked = (fn) => withLock(`store:${dataDir}`, fn);
  let lastSeq = 0;

  return {
    dataDir,
    // Everything persisted; creates the data dir (0700) on first use.
    async load() {
      await ensurePrivateDir(dataDir);
      const accepted = await readNdjson(file('accepted'), log);
      lastSeq = accepted.reduce((m, e) => Math.max(m, e.seq), 0);
      const settings = await locked(() => migrateSettings(file('settings')));
      return {
        settings: { ...DEFAULT_SETTINGS, ...settings },
        pins: await readJson(file('pins'), {}),
        accepted,
        pending: await readNdjson(file('pending'), log),
        rejected: await readLines(file('rejected'), log),
        outbox: validOutbox(await readJson(file('outbox'), []), log),
        cursors: await readJson(file('cursors'), {}),
        notify: await readJson(file('notify'), { watermark: 0 }),
        contacts: await readJson(file('contacts'), []),
      };
    },
    loadNotify: () => readJson(file('notify'), { watermark: 0 }),
    // Appends one accepted record, durably; resolves its acceptance seq.
    appendAccepted({ id, route, bytes }) {
      return locked(async () => {
        const seq = lastSeq + 1;
        const handle = await fs.open(file('accepted'), 'a', 0o600);
        try {
          await handle.appendFile(toLine({ seq, id, route, bytes }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        lastSeq = seq;
        return seq;
      });
    },
    // Appends the id (and what it was) of a record refused for good.
    appendRejected(entry) {
      return locked(async () => {
        const handle = await fs.open(file('rejected'), 'a', 0o600);
        try {
          await handle.appendFile(`${JSON.stringify(entry)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    },
    savePending: (list) => locked(() => writeFileLines(file('pending'), list)),
    saveOutbox: (list) => locked(() => writeJson(file('outbox'), list.map((e) => ({ route: e.route, to: e.to, bytes: Buffer.from(e.bytes).toString('base64') })))),
    saveSettings: (s) => locked(() => writeJson(file('settings'), s)),
    savePins: (p) => locked(() => writeJson(file('pins'), p)),
    saveCursors: (c) => locked(() => writeJson(file('cursors'), c)),
    saveNotify: (n) => locked(() => writeJson(file('notify'), n)),
    saveContacts: (list) => locked(() => writeJson(file('contacts'), list)),
    // {peerFp: {routeKey: seq}}: the TCP transport's pull cursors.
    loadPeerCursors: () => readJson(file('peerCursors'), {}),
    savePeerCursors: (c) => locked(() => writeJson(file('peerCursors'), c)),
  };
}

// The outbox entries that can be sent: a valid route, recipients that are fingerprints, bytes. Any other entry is
// dropped and logged: a send must never take a path or an address from a damaged file.
function validOutbox(list, log) {
  if (!Array.isArray(list)) { log.warn('code-inbox: outbox.json is not a list: ignored'); return []; }
  const ok = (e) => e && typeof e === 'object' && isRoute(e.route) && Array.isArray(e.to) && e.to.every((fp) => typeof fp === 'string' && FP_RE.test(fp)) && typeof e.bytes === 'string';
  return list.filter((e, i) => ok(e) || (log.warn(`code-inbox: outbox.json entry ${i} is invalid: dropped`), false))
    .map((e) => ({ route: e.route, to: e.to, bytes: Buffer.from(e.bytes, 'base64') }));
}

function writeFileLines(file, list) {
  return writeFileAtomic(file, list.map((e) => `${JSON.stringify({ route: e.route, bytes: Buffer.from(e.bytes).toString('base64') })}\n`).join(''));
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, readJson, writeFileAtomic, writeJson } from './fsAtomic.js';
import { withLock } from './mutex.js';

// The install's local state under the data dir, written only by this backend (docs/architecture.md → Data dir).
// Every write goes through one lock per data dir. accepted.ndjson is append-only and assigns the acceptance seq.
export const FILES = {
  settings: 'settings.json',
  pins: 'pins.json',
  accepted: 'accepted.ndjson',
  pending: 'pending.ndjson',
  outbox: 'outbox.json',
  cursors: 'cursors.json',
  notify: 'notify.json',
};

export const DEFAULT_SETTINGS = { name: null, shareDir: null, notifyTarget: null };

const toLine = (e) => `${JSON.stringify({ seq: e.seq, id: e.id, route: e.route, bytes: Buffer.from(e.bytes).toString('base64') })}\n`;

// Parses an ndjson file of {route, bytes(b64), …}; a line that does not parse (a torn last write) is skipped and logged.
async function readNdjson(file, log) {
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
      const e = JSON.parse(line);
      out.push({ ...e, bytes: Buffer.from(e.bytes, 'base64') });
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
      return {
        settings: { ...DEFAULT_SETTINGS, ...(await readJson(file('settings'), {})) },
        pins: await readJson(file('pins'), {}),
        accepted,
        pending: await readNdjson(file('pending'), log),
        outbox: (await readJson(file('outbox'), [])).map((e) => ({ ...e, bytes: Buffer.from(e.bytes, 'base64') })),
        cursors: await readJson(file('cursors'), {}),
        notify: await readJson(file('notify'), { watermark: 0 }),
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
    savePending: (list) => locked(() => writeFileLines(file('pending'), list)),
    saveOutbox: (list) => locked(() => writeJson(file('outbox'), list.map((e) => ({ route: e.route, to: e.to, bytes: Buffer.from(e.bytes).toString('base64') })))),
    saveSettings: (s) => locked(() => writeJson(file('settings'), s)),
    savePins: (p) => locked(() => writeJson(file('pins'), p)),
    saveCursors: (c) => locked(() => writeJson(file('cursors'), c)),
    saveNotify: (n) => locked(() => writeJson(file('notify'), n)),
  };
}

function writeFileLines(file, list) {
  return writeFileAtomic(file, list.map((e) => `${JSON.stringify({ route: e.route, bytes: Buffer.from(e.bytes).toString('base64') })}\n`).join(''));
}

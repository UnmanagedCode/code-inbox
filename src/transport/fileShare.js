import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodedError } from '../errors.js';
import { TMP_PREFIX, writeFileAtomic } from '../fsAtomic.js';
import { FP_RE, RECORD_MAX_BYTES } from '../records.js';

// The v1 transport: a directory every install can reach (Dropbox, SMB, NFS). Layout under <shareDir>/code-inbox/v1/
// (docs/protocol.md → Share layout); every writer writes only below its own fingerprint subdir and never rewrites
// a file, so the share holds no mutable file two installs could race on.
export const SHARE_POLL_MS = 2000;
export const SHARE_ROOT = path.join('code-inbox', 'v1');
export const FILE_RE = /^\d{13}-[0-9a-f]{32}\.rec$/;
const YIELD_EVERY = 64;

const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const shareRefusal = (dir) => (why) => { throw new CodedError('SHARE_INVALID', `share dir ${JSON.stringify(dir)} ${why}`); };

// The rules a share dir path must meet without touching the filesystem (a stored share is checked only against
// these at boot, so a mount that is not up yet is picked up once it appears): an absolute path that neither lies
// inside the data dir nor contains it, compared as resolved paths. Refuses SHARE_INVALID; resolves the dir unchanged.
export function checkShareDirPath(dir, dataDir) {
  const refuse = shareRefusal(dir);
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) refuse('is not an absolute path');
  const resolved = path.resolve(dir);
  const data = path.resolve(dataDir);
  if (isInside(data, resolved)) refuse('is inside the data dir');
  if (isInside(resolved, data)) refuse('contains the data dir');
  return dir;
}

// The full check when a human saves a share dir: checkShareDirPath, then it must be an existing writable directory
// that neither contains the data dir nor lies inside it compared by realpath (symlinks resolved): the private key
// must never sit on the share. Refuses SHARE_INVALID; resolves the dir unchanged.
export async function validateShareDir(dir, dataDir) {
  const refuse = shareRefusal(dir);
  checkShareDirPath(dir, dataDir);
  let st;
  try { st = await fs.stat(dir); } catch { refuse('does not exist'); }
  if (!st.isDirectory()) refuse('is not a directory');
  const real = await fs.realpath(dir);
  const realData = await fs.realpath(dataDir);
  if (isInside(realData, real)) refuse('is inside the data dir');
  if (isInside(real, realData)) refuse('contains the data dir');
  const probe = path.join(dir, `${TMP_PREFIX}probe-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fs.writeFile(probe, '', { flag: 'wx' });
    await fs.rm(probe, { force: true });
  } catch (err) {
    refuse(`is not writable (${err.code ?? err.message})`);
  }
  return dir;
}

// The share dir that holds a route's records; writers sit one level below it.
export function routeDir(root, route) {
  if (route.kind === 'directory') return path.join(root, 'directory');
  if (route.kind === 'mailbox') return path.join(root, 'mailbox', route.fp);
  return path.join(root, 'inboxes', route.id);
}

// Reads at most RECORD_MAX_BYTES + 1 bytes: an oversize file is still offered (and rejected) without being read whole.
// Opened without following a symlink, so a link swapped in after the lstat is not read through either.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
async function readCapped(file) {
  const handle = await fs.open(file, READ_FLAGS);
  try {
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return buf.subarray(0, total);
  } finally {
    await handle.close();
  }
}

const tick = () => new Promise((r) => setImmediate(r));

/** @returns {import('./index.js').Transport} */
export function createFileShare({ shareDir, selfFp, pollMs = SHARE_POLL_MS, now = Date.now, log = console }) {
  const root = path.join(shareDir, SHARE_ROOT);
  let interest = [];
  let sink = null;
  let timer = null;
  let stopped = false;
  let chain = Promise.resolve();
  const offered = new Set(); // paths handed over for good
  const retry = new Map(); // path → "size:mtime" of a file whose bytes may be incomplete

  // Offers one file; never throws, so one bad file cannot stall the rest of its route. Symlinks (a writer subdir or a
  // file a peer swapped for a link out of the share) are skipped.
  async function offerFile(route, writer, file) {
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) return;
      const key = `${st.size}:${st.mtimeMs}`;
      if (retry.get(file) === key) return;
      const bytes = await readCapped(file);
      const r = await sink.record({ route, writer, bytes });
      if (r?.retry) retry.set(file, key); else { offered.add(file); retry.delete(file); }
    } catch (err) {
      log.warn(`code-inbox: offering ${file} failed, retried next scan: ${err.message}`);
    }
  }

  async function scanRoute(route, counter) {
    const base = routeDir(root, route);
    let writers;
    try { writers = await fs.readdir(base); } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const writer of writers.sort()) {
      if (!FP_RE.test(writer)) continue;
      const dir = path.join(base, writer);
      let names;
      try {
        if (!(await fs.lstat(dir)).isDirectory()) continue;
        names = await fs.readdir(dir);
      } catch { continue; }
      for (const name of names.sort()) {
        if (stopped) return;
        if (!FILE_RE.test(name)) continue;
        const file = path.join(dir, name);
        if (offered.has(file)) continue;
        await offerFile(route, writer, file);
        counter.n += 1;
        if (counter.n % YIELD_EVERY === 0) await tick();
      }
    }
  }

  // This install's own subdir for `route`, created if missing. Refused (SHARE_UNSAFE) when it is a symlink or not a
  // real directory, or resolves outside the share: a peer could otherwise redirect this install's writes.
  async function ownDir(route) {
    const parent = routeDir(root, route);
    await fs.mkdir(parent, { recursive: true });
    const dir = path.join(parent, selfFp);
    try { await fs.mkdir(dir); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new CodedError('SHARE_UNSAFE', `${dir} is not a real directory`);
    const [real, realRoot] = await Promise.all([fs.realpath(dir), fs.realpath(root)]);
    if (!isInside(realRoot, real)) throw new CodedError('SHARE_UNSAFE', `${dir} resolves outside the share`);
    return dir;
  }

  async function scan() {
    if (!sink || stopped) return;
    const counter = { n: 0 };
    for (const route of interest) {
      try {
        await scanRoute(route, counter);
      } catch (err) {
        log.warn(`code-inbox: scanning ${routeDir(root, route)} failed: ${err.message}`);
      }
    }
  }

  // Scans never overlap: each queues behind the last.
  const queueScan = () => { chain = chain.then(scan, scan); return chain; };

  function loop() {
    timer = null;
    queueScan().finally(() => { if (!stopped) { timer = setTimeout(loop, pollMs); timer.unref?.(); } });
  }

  return {
    capabilities: { directory: true, push: false },
    root,
    addresses: () => [],
    async start(s) {
      sink = s;
      loop();
    },
    setInterest(routes) { interest = [...routes]; },
    // The share stores everything, so every recipient counts as delivered.
    async send(bytes, { route, to }) {
      const dir = await ownDir(route);
      const name = `${String(now()).padStart(13, '0')}-${crypto.randomBytes(16).toString('hex')}.rec`;
      await writeFileAtomic(path.join(dir, name), bytes, 0o644);
      return { delivered: [...to], pending: [] };
    },
    sync: () => queueScan(),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain;
    },
  };
}

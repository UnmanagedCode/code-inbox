import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodedError } from '../errors.js';
import { TMP_PREFIX, writeFileAtomic } from '../fsAtomic.js';
import { FP_RE, RECORD_MAX_BYTES } from '../records.js';
import { isRoute } from './index.js';

// The v1 transport: a directory every install can reach (Dropbox, SMB, NFS). Layout under <shareDir>/code-inbox/v1/
// (docs/protocol.md → Share layout); every writer writes only below its own fingerprint subdir and never rewrites
// a file, so the share holds no mutable file two installs could race on.
export const SHARE_POLL_MS = 2000;
export const SHARE_ROOT = path.join('code-inbox', 'v1');
export const FILE_RE = /^\d{13}-[0-9a-f]{32}\.rec$/;
const YIELD_EVERY = 64;

// Whether `child` is `parent` or below it. Only a `..` path component leaves `parent`: a name such as `..share`
// is an ordinary entry inside it.
export const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
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

// Why a real path (symlinks resolved) overlaps the real data dir `realData`, or null.
function realOverlap(real, realData) {
  if (isInside(realData, real)) return 'is inside the data dir (through a link)';
  if (isInside(real, realData)) return 'contains the data dir (through a link)';
  return null;
}

// The overlap rule on real paths, for a share dir that exists (`real` is its realpath).
async function checkRealOverlap(dir, real, dataDir) {
  const why = realOverlap(real, await fs.realpath(dataDir));
  if (why) shareRefusal(dir)(why);
}

const unsafe = (why) => { throw new CodedError('SHARE_UNSAFE', why); };

// Creates `base/<parts…>` one component at a time, never through a link: each component that exists must be a real
// directory (a symlink: SHARE_UNSAFE; anything else: ENOTDIR) whose real path stays inside `realBase` (and, given `realData`, does not overlap the
// data dir), checked before anything is created under it. Refuses SHARE_UNSAFE. Resolves the final path.
// What remains is the race between a check and the next mkdir: a peer swapping a checked component for a link in
// between can still get one empty directory created through it.
async function mkdirsInside(base, parts, realBase, realData = null) {
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    try { await fs.mkdir(cur); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const st = await fs.lstat(cur);
    if (st.isSymbolicLink()) unsafe(`${cur} is a link, not a real directory`);
    // Something else in a directory's place redirects nothing: a plain filesystem error, retried.
    if (!st.isDirectory()) throw Object.assign(new Error(`${cur} is not a directory`), { code: 'ENOTDIR' });
    const real = await fs.realpath(cur);
    if (!isInside(realBase, real)) unsafe(`${cur} resolves outside the share`);
    const why = realData && realOverlap(real, realData);
    if (why) unsafe(`${cur} ${why}`);
  }
  return cur;
}

// The state of the share's root `<dir>/SHARE_ROOT`, component by component (`code-inbox`, then `v1`), never
// following a link: 'present' (each is a real directory), or 'missing' (a component does not exist or is not a
// directory). A component that is a symlink is refused SHARE_UNSAFE: it would carry every write (or, at save, the
// root's creation) to wherever it points. The share dir itself may be a link. The one rule for save, boot and write.
export async function rootState(dir) {
  let cur = dir;
  for (const part of SHARE_ROOT.split(path.sep)) {
    cur = path.join(cur, part);
    let st;
    try { st = await fs.lstat(cur); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
      throw err;
    }
    if (st.isSymbolicLink()) unsafe(`${cur} is a link, not the share's own directory`);
    if (!st.isDirectory()) return 'missing';
  }
  return 'present';
}

// Creates the share's root (`<dir>/SHARE_ROOT`) when a human saves the share (the dir passed validateShareDir): from
// then on a send requires the root to exist. A `code-inbox` or `v1` that is a link, or resolves outside the share
// or into the data dir, is refused SHARE_UNSAFE before anything is created through it.
export async function ensureShareRoot(dir, dataDir) {
  await rootState(dir);
  const [realDir, realData] = await Promise.all([fs.realpath(dir), fs.realpath(dataDir)]);
  await mkdirsInside(dir, SHARE_ROOT.split(path.sep), realDir, realData);
  return dir;
}

// The check of a stored share dir at boot: checkShareDirPath, plus, when the dir resolves, the real-path overlap rule
// (a link into or above the data dir is refused) and rootState (a root that is a link is refused SHARE_UNSAFE). A dir that cannot be resolved yet (missing, or a mount not up)
// passes, so the share still starts and is scanned once it appears. Refuses SHARE_INVALID; resolves the dir unchanged.
export async function checkStoredShareDir(dir, dataDir) {
  checkShareDirPath(dir, dataDir);
  let real;
  try { real = await fs.realpath(dir); } catch { return dir; }
  await checkRealOverlap(dir, real, dataDir);
  // A root that is a link is refused (SHARE_UNSAFE); a root that cannot be read yet waits for the mount like a
  // missing one.
  try { await rootState(dir); } catch (err) { if (err instanceof CodedError) throw err; }
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
  await checkRealOverlap(dir, await fs.realpath(dir), dataDir);
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
// `dataDir` is the install's data dir: every write re-checks that the share does not overlap it.
export function createFileShare({ shareDir, dataDir, selfFp, pollMs = SHARE_POLL_MS, now = Date.now, log = console }) {
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

  // This install's own subdir for `route`, created if missing (the root itself must exist). Refused (SHARE_UNSAFE)
  // when its path leaves the root before anything is created, when it is a symlink or not a real directory, or when
  // it resolves outside the share: a peer could otherwise redirect this install's writes.
  // Resolves {dir, realRoot}.
  async function ownDir(route) {
    const parent = routeDir(root, route);
    const dir = path.join(parent, selfFp);
    const resolvedRoot = path.resolve(root);
    if (!isRoute(route) || !isInside(resolvedRoot, path.resolve(dir)) || path.resolve(dir) === resolvedRoot) {
      throw new CodedError('SHARE_UNSAFE', `the route ${JSON.stringify(route).slice(0, 80)} does not stay inside the share`);
    }
    const realRoot = await fs.realpath(root);
    await mkdirsInside(root, path.relative(root, dir).split(path.sep), realRoot);
    return { dir, realRoot };
  }

  // Before any write: the share's root must already exist (else SHARE_UNAVAILABLE: an unmounted mount point, or a
  // share never saved) as real directories, not links (rootState, else SHARE_UNSAFE), and neither the share dir nor
  // its root may resolve into or above the data dir (else SHARE_UNSAFE: a link that appeared after the share was
  // checked).
  async function checkWritable() {
    if (await rootState(shareDir) === 'missing') throw new CodedError('SHARE_UNAVAILABLE', `the share ${shareDir} has no ${SHARE_ROOT} (not mounted?)`);
    const realData = await fs.realpath(dataDir);
    for (const p of [shareDir, root]) {
      const why = realOverlap(await fs.realpath(p), realData);
      if (why) throw new CodedError('SHARE_UNSAFE', `${p} ${why}`);
    }
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
    async start(s) {
      sink = s;
      loop();
    },
    // The engine writes the announce file itself (a directory-route send), so the share needs nothing here.
    setAnnounce() {},
    setInterest(routes) { interest = [...routes]; },
    // The share stores everything, so every recipient counts as delivered.
    // Refused SHARE_UNAVAILABLE (retryable, nothing created) while the share's root does not exist: a share whose
    // mount is not up must not be recreated on the local disk, where the mount would later hide it.
    async send(bytes, { route, to }) {
      await checkWritable();
      const { dir, realRoot } = await ownDir(route);
      const name = `${String(now()).padStart(13, '0')}-${crypto.randomBytes(16).toString('hex')}.rec`;
      // Once more right before the write, to narrow the window a swapped link could use.
      if (!isInside(realRoot, await fs.realpath(dir))) throw new CodedError('SHARE_UNSAFE', `${dir} resolves outside the share`);
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

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;

// Creates `dir` (and parents) and forces it to 0700, so a dir an older run or a loose umask made is tightened too.
export async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(dir, PRIVATE_DIR_MODE);
}

// The tmp name a writer uses next to its target; readers of a shared dir must skip it.
export const TMP_PREFIX = '.tmp-';

// Writes `bytes` to `file` so a reader sees either nothing or the whole file: an exclusive tmp file in the same
// dir, fsync, then rename. `mode` is enforced with chmod (the create mode is narrowed by the umask).
export async function writeFileAtomic(file, bytes, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `${TMP_PREFIX}${crypto.randomBytes(16).toString('hex')}`);
  const handle = await fs.open(tmp, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// Reads and parses a JSON file; `fallback` when it does not exist. A file that exists but does not parse throws.
export async function readJson(file, fallback) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try { return JSON.parse(text); } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

export const writeJson = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

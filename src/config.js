import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// cc passes these to every plugin backend (cc docs/plugins/manifest.md → Child env). The data dir is required:
// the private key lives there. PROJECTS_ROOT is never read.
export function loadConfig(env = process.env) {
  const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
  if (!dataDir) throw new Error("CONDUCTOR_PLUGIN_DATA_DIR is not set: it names code-inbox's data directory");
  if (!path.isAbsolute(dataDir)) throw new Error(`CONDUCTOR_PLUGIN_DATA_DIR must be absolute, got ${dataDir}`);
  const port = env.PORT === undefined || env.PORT === '' ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a valid port: ${env.PORT}`);
  return {
    port,
    dataDir: path.resolve(dataDir),
    distDir: path.join(pluginDir, 'frontend', 'dist'),
  };
}

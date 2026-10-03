import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a local server named `name` listens: a unix socket in the temp directory, or a named pipe on
 * Windows. `remove` deletes a leftover socket file (pipes vanish with their server).
 */
/** @param {string} name @param {string} [platform] */
export function localEndpoint(name, platform = process.platform) {
  const isPipe = platform === 'win32';
  const path = isPipe ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  return {
    path,
    isPipe,
    remove() {
      if (!isPipe) rmSync(path, { force: true });
    },
  };
}

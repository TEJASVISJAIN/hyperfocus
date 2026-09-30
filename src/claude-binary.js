import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

// A JavaScript file is started with node (see launch.js), so it only needs to be readable.
const isExecutable = (path) => {
  try {
    accessSync(path, /\.(?:js|mjs|cjs)$/i.test(path) ? constants.R_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// HYPERFOCUS_CLAUDE_BIN lets tests (and unusual installs) point at a different executable.
// On Windows, `claude` may be claude.exe or npm's claude.cmd, so PATHEXT's extensions are tried. The
// extensionless `claude` npm also installs there is a bash script, which Windows can't start.
export function resolveClaudeBinary(env = process.env, options = {}) {
  return resolveBinary('claude', env.HYPERFOCUS_CLAUDE_BIN, env, options);
}

/** Finds `name` on PATH, or uses `override` (a path, or another name to look up). */
export function resolveBinary(name, override, env = process.env, { platform = process.platform, isFile = isExecutable } = {}) {
  const requested = override || name;
  const path = platform === 'win32' ? win32 : posix;
  const extensions = platform === 'win32' && !path.extname(requested) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidatesIn = (base) => extensions.map((extension) => base + extension);

  if (path.isAbsolute(requested) || isAbsolute(requested)) return candidatesIn(requested).find(isFile) ?? null;
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!directory) continue;
    const found = candidatesIn(path.join(directory, requested)).find(isFile);
    if (found) return found;
  }
  return null;
}

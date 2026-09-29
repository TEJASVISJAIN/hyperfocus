import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// FOCUS_CLAUDE_BIN lets tests (and unusual installs) point at a different executable.
export function resolveClaudeBinary(env = process.env) {
  const requested = env.FOCUS_CLAUDE_BIN || 'claude';
  if (isAbsolute(requested)) return isExecutable(requested) ? requested : null;

  for (const directory of (env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, requested);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

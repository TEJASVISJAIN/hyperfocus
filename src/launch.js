import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';

// npm's Windows shim ends by running node on the package's script: "%dp0%\node_modules\…\cli.js" %*
const SHIM_SCRIPT = /"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i;

/**
 * How to start `path` with `args` without a shell in between:
 * - a JavaScript file (the demo agent, test fixtures) runs with this node, so it needs no execute bit;
 * - on Windows, npm's `claude.cmd` shim runs as node plus the script it points at, because starting
 *   a .cmd means cmd.exe, whose quoting would mangle arguments such as the --settings JSON;
 * - anything else starts as it is.
 * @returns {{ command: string, args: string[] }}
 */
export function launchCommand(path, args, { platform = process.platform, node = process.execPath, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return { command: node, args: [path, ...args] };
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(path)) {
    const script = String(readFile(path)).match(SHIM_SCRIPT)?.[1];
    if (!script) throw new Error(`can't start ${path}: install Claude Code's native build (claude.exe), or set HYPERFOCUS_CLAUDE_BIN to it`);
    return { command: node, args: [win32.join(win32.dirname(path), script), ...args] };
  }
  return { command: path, args };
}

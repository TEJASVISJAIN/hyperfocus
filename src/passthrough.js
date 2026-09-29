import { spawn as spawnPlain } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import pty from 'node-pty';

/** @type {NodeJS.Signals[]} */
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'];

// Runs `claude` inside a pseudo-terminal we own, so hyperfocus can intercept its screen.
// `onOutput` receives everything claude draws; the caller decides what reaches the real terminal.
export function startClaudeInPty(claudePath, args, { env, onOutput, onExit }) {
  const { stdout } = process;
  const child = pty.spawn(claudePath, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd: process.cwd(),
    env,
  });
  child.onData(onOutput);
  child.onExit(onExit);
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }
  return child;
}

// Puts the real terminal in raw mode for the lifetime of hyperfocus and guarantees it is restored.
export function takeOverTerminal(onInput) {
  const { stdin } = process;
  const restore = () => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
  process.on('exit', restore);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onInput);
  return restore;
}

export function exitCodeFor({ exitCode, signal }) {
  return signal ? 128 + signal : exitCode;
}

// Piped or scripted use (e.g. `echo hi | hyperfocus -p`) has no terminal to take over,
// so hand stdio straight to claude.
export function runPlain(claudePath, args) {
  const child = spawnPlain(claudePath, args, { stdio: 'inherit' });
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (exitCode, signal) => {
    process.exit(signal ? 128 + osConstants.signals[signal] : exitCode);
  });
}

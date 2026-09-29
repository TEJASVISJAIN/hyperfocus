import { spawn as spawnPlain } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import pty from 'node-pty';

const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'];

// Runs `claude` inside a pseudo-terminal we own, so later issues can intercept its screen.
// With nothing else attached, the user must not be able to tell it apart from plain `claude`.
export function runInPty(claudePath, args) {
  const { stdin, stdout } = process;
  const child = pty.spawn(claudePath, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env,
  });

  const restoreTerminal = () => {
    if (stdin.isTTY) stdin.setRawMode(false);
  };
  process.on('exit', restoreTerminal);

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (chunk) => child.write(chunk.toString('utf8')));
  child.onData((data) => stdout.write(data));

  stdout.on('resize', () => child.resize(stdout.columns, stdout.rows));

  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }

  child.onExit(({ exitCode, signal }) => {
    restoreTerminal();
    stdin.pause();
    process.exit(signal ? 128 + signal : exitCode);
  });
}

// Piped or scripted use (e.g. `echo hi | focus -p`) has no terminal to take over,
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

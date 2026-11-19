import { spawnSync } from 'node:child_process';

// On Windows, node-pty's ConPTY worker and pipes can stay referenced after
// the terminal has exited. Let Node report the results and then exit.
const options = process.platform === 'win32' ? ['--test-force-exit'] : [];
const { error, status } = spawnSync(
  process.execPath,
  ['--test', ...options, ...process.argv.slice(2), 'test/*.test.js'],
  { stdio: 'inherit' },
);
if (error) throw error;
process.exitCode = status ?? 1;

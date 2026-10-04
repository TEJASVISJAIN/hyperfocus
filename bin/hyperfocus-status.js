#!/usr/bin/env node
// Claude Code runs this to draw its status line. It prints the user's own status line, if they have
// one, then hyperfocus's: whether questions are waiting and how to reach them. Never fails loudly:
// whatever goes wrong, hyperfocus's line still prints.
import { spawnSync } from 'node:child_process';
import { readStatus, statusLineText } from '../src/status-line.js';

const USER_LINE_TIMEOUT_MS = 2000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const lines = [];
  const userCommand = process.env.HYPERFOCUS_USER_STATUSLINE;
  if (userCommand) {
    const result = spawnSync(userCommand, { shell: true, input, encoding: 'utf8', timeout: USER_LINE_TIMEOUT_MS });
    if (result.status === 0 && result.stdout.trim()) lines.push(result.stdout.replace(/\n+$/, ''));
  }
  lines.push(statusLineText(readStatus(process.env.HYPERFOCUS_STATUS ?? '')));
  process.stdout.write(lines.join('\n') + '\n');
});

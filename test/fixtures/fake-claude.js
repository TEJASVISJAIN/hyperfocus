#!/usr/bin/env node
import { exec } from 'node:child_process';
// Stand-in for `claude`: reports what it sees so tests can check the wrapper passes things through.
const report = (event, data) => process.stdout.write(`@@${JSON.stringify({ event, ...data })}@@\r\n`);

const argv = process.argv.slice(2);
const settingsIndex = argv.indexOf('--settings');
const settings = settingsIndex === -1 ? null : JSON.parse(argv.splice(settingsIndex, 2)[1]);

report('start', {
  args: argv,
  hookEvents: settings ? Object.keys(settings.hooks) : [],
  hasFocusSocket: Boolean(process.env.HYPERFOCUS_SOCK),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  cols: process.stdout.columns,
  rows: process.stdout.rows,
});

process.stdout.on('resize', () => report('resize', { cols: process.stdout.columns, rows: process.stdout.rows }));

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString();
  let newline;
  while ((newline = buffered.search(/[\r\n]/)) !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    report('line', { line });
    const laterMatch = line.match(/^later (\d+) (.+)$/);
    if (laterMatch) setTimeout(() => report('later', { text: laterMatch[2] }), Number(laterMatch[1]));
    const hookMatch = line.match(/^hook (\d+) (\w+)$/);
    if (hookMatch) setTimeout(() => runHook(hookMatch[2]), Number(hookMatch[1]));
    const rawMatch = line.match(/^raw (\d+) (.+)$/);
    if (rawMatch) setTimeout(() => process.stdout.write(JSON.parse(rawMatch[2])), Number(rawMatch[1]));
    const floodMatch = line.match(/^flood (\d+)$/);
    if (floodMatch) setTimeout(() => flood(Number(floodMatch[1])), 50);
    const exitMatch = line.match(/^exit (\d+)$/);
    if (exitMatch) process.exit(Number(exitMatch[1]));
  }
});

// Runs the hook command hyperfocus registered for `eventName`, the way Claude Code would.
function runHook(eventName) {
  const command = settings?.hooks[eventName]?.[0]?.hooks[0]?.command;
  if (!command) return;
  const payloads = {
    UserPromptSubmit: { prompt: 'add retry to token refresh' },
    Stop: {},
    Notification: { message: 'Claude needs your permission to use Bash' },
  };
  const hook = exec(command);
  hook.stdin.end(JSON.stringify({ hook_event_name: eventName, session_id: 'fake-session', ...payloads[eventName] }));
}

// Writes about `kilobytes` KB of redraw-like output, then a marker the tests can look for.
function flood(kilobytes) {
  const line = 'spinner frame '.padEnd(99, '.') + '\n';
  for (let written = 0; written < kilobytes * 1024; written += line.length) process.stdout.write('\x1b[2K\r' + line);
  process.stdout.write('FLOOD END\r\n');
}

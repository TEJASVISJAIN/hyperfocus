#!/usr/bin/env node
// Stand-in for `claude`: reports what it sees so tests can check the wrapper passes things through.
const report = (event, data) => process.stdout.write(`@@${JSON.stringify({ event, ...data })}@@\r\n`);

const argv = process.argv.slice(2);
const settingsIndex = argv.indexOf('--settings');
const settings = settingsIndex === -1 ? null : JSON.parse(argv.splice(settingsIndex, 2)[1]);

report('start', {
  args: argv,
  hookEvents: settings ? Object.keys(settings.hooks) : [],
  hasFocusSocket: Boolean(process.env.CLAUDE_FOCUS_SOCK),
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
    const exitMatch = line.match(/^exit (\d+)$/);
    if (exitMatch) process.exit(Number(exitMatch[1]));
  }
});

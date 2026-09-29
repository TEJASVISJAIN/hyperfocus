#!/usr/bin/env node
// Stand-in for `claude`: reports what it sees so tests can check the wrapper passes things through.
const report = (event, data) => process.stdout.write(`@@${JSON.stringify({ event, ...data })}@@\r\n`);

report('start', {
  args: process.argv.slice(2),
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
    const exitMatch = line.match(/^exit (\d+)$/);
    if (exitMatch) process.exit(Number(exitMatch[1]));
  }
});

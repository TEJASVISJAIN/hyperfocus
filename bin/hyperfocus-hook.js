#!/usr/bin/env node
// Claude Code runs this for every hook hyperfocus registers. It forwards the payload to the
// hyperfocus process and gets out of the way: always exit 0, never print (stdout is fed back to Claude).
import { connect } from 'node:net';

const GIVE_UP_AFTER_MS = 500;
const socketPath = process.env.HYPERFOCUS_SOCK;

if (!socketPath || process.env.HYPERFOCUS_CHILD === '1') process.exit(0);

setTimeout(() => process.exit(0), GIVE_UP_AFTER_MS).unref();

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (payload += chunk));
process.stdin.on('end', () => {
  const socket = connect(socketPath);
  socket.on('error', () => process.exit(0));
  socket.end(payload.replace(/\n/g, ' ') + '\n', () => process.exit(0));
});

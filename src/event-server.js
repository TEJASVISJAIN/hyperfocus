import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugLog } from './debug-log.js';
import { toFocusEvent } from './hook-events.js';

let serverCount = 0;

// Listens on a unix socket (a named pipe on Windows) for payloads from bin/hyperfocus-hook.js and
// emits them as FocusEvents.
export async function startEventServer({ platform = process.platform, toEvent = toFocusEvent } = {}) {
  const name = `hyperfocus-${process.pid}-${serverCount++}`;
  const isPipe = platform === 'win32';
  const socketPath = isPipe ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const removeSocket = () => {
    if (!isPipe) rmSync(socketPath, { force: true });
  };
  removeSocket();

  const events = new EventEmitter();
  const server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (buffered += chunk));
    socket.on('end', () => {
      for (const line of buffered.split('\n')) handleLine(line, events, toEvent);
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(undefined));
  });

  return {
    socketPath,
    events,
    close() {
      server.close();
      removeSocket();
    },
  };
}

function handleLine(line, events, toEvent) {
  if (!line.trim()) return;
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    debugLog('unparseable hook payload', line.slice(0, 200));
    return;
  }
  try {
    const event = toEvent(payload);
    debugLog('hook', payload?.hook_event_name, payload?.tool_name ?? '', event ? event.type : '(ignored)');
    if (event) events.emit('event', event);
  } catch (error) {
    // A bug handling one event must never take down the user's Claude session.
    debugLog('error handling hook event', error.stack);
  }
}

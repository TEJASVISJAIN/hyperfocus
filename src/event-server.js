import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugLog } from './debug-log.js';
import { toFocusEvent } from './hook-events.js';

let serverCount = 0;

// Listens on a unix socket for payloads from bin/focus-hook.js and emits them as FocusEvents.
export async function startEventServer() {
  const socketPath = join(tmpdir(), `focus-${process.pid}-${serverCount++}.sock`);
  rmSync(socketPath, { force: true });

  const events = new EventEmitter();
  const server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (buffered += chunk));
    socket.on('end', () => {
      for (const line of buffered.split('\n')) handleLine(line, events);
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
      rmSync(socketPath, { force: true });
    },
  };
}

function handleLine(line, events) {
  if (!line.trim()) return;
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    debugLog('unparseable hook payload', line.slice(0, 200));
    return;
  }
  const event = toFocusEvent(payload);
  debugLog('hook', payload.hook_event_name, payload.tool_name ?? '', event ? event.type : '(ignored)');
  if (event) events.emit('event', event);
}

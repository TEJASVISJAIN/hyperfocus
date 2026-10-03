// Follows the hyperfocus session for this window over its bridge (see src/bridge.js in hyperfocus).
// Kept free of the vscode module so it can be tested with plain node.
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { listSessions, pickSession, protocolProblem } = require('./panel-state');

/**
 * status: 'none' (no session for this window), 'connecting', 'live', or 'mismatch' (a session the
 * panel can't speak to; `problem` says why). Emits 'change' with a snapshot whenever any of it moves.
 */
class LiveConnection extends EventEmitter {
  constructor({ sessionsDir, folders, pollMs = 1000, backoffMs = [500, 1000, 2000, 5000], connect = net.connect }) {
    super();
    Object.assign(this, { sessionsDir, folders, pollMs, backoffMs, connectTo: connect });
    this.status = 'none';
    this.session = null;
    this.hello = null;
    this.state = null;
    this.problem = null;
    this.socket = null;
    this.failures = 0;
    this.retryAt = 0;
    this.refused = null; // endpoint of a session whose protocol we don't speak
    this.timer = null;
    this.watching = false; // whether the panel is on screen; the session leaves the quiz to it then
  }

  /** Tells the session whether the panel is on screen, now and after every reconnect. */
  setWatching(visible) {
    this.watching = Boolean(visible);
    if (this.status === 'live' && this.socket) this.socket.write(JSON.stringify({ type: 'watching', visible: this.watching }) + '\n');
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
  }

  snapshot() {
    return { status: this.status, session: this.session, hello: this.hello, state: this.state, problem: this.problem };
  }

  /** Sends an action to the session; false when there is no live session to send it to. */
  send(action) {
    if (this.status !== 'live' || !this.socket) return false;
    this.socket.write(JSON.stringify(action) + '\n');
    return true;
  }

  dispose() {
    clearInterval(this.timer);
    this.disposed = true;
    this.socket?.destroy();
    this.removeAllListeners();
  }

  set(changes) {
    Object.assign(this, changes);
    this.emit('change', this.snapshot());
  }

  scan() {
    if (this.disposed || this.socket) return;
    const session = pickSession(listSessions(this.sessionsDir), this.folders());
    if (!session) {
      this.refused = null;
      if (this.status !== 'none') this.set({ status: 'none', session: null, hello: null, state: null, problem: null });
      return;
    }
    if (session.endpoint === this.refused) return;
    const problem = protocolProblem(session.protocol);
    if (problem) {
      this.refused = session.endpoint;
      return this.set({ status: 'mismatch', session, hello: null, state: null, problem });
    }
    if (Date.now() < this.retryAt) return;
    this.connect(session);
  }

  connect(session) {
    const socket = this.connectTo(session.endpoint);
    this.socket = socket;
    this.set({ status: 'connecting', session, hello: null, state: null, problem: null });
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        this.receive(message, socket, session);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.disposed) return;
      if (this.status === 'mismatch') return;
      if (this.status !== 'live') this.retryAt = Date.now() + this.backoffMs[Math.min(this.failures++, this.backoffMs.length - 1)];
      this.set({ status: 'none', session: null, hello: null, state: null, problem: null });
      this.scan();
    });
  }

  receive(message, socket, session) {
    if (message.type === 'hello') {
      const problem = protocolProblem(message.protocol);
      if (problem) {
        this.refused = session.endpoint;
        this.set({ status: 'mismatch', hello: message, problem });
        return socket.destroy();
      }
      this.failures = 0;
      this.retryAt = 0;
      this.set({ status: 'live', hello: message });
      return this.setWatching(this.watching);
    }
    if (message.type === 'state' && this.status === 'live') {
      const { type, ...state } = message;
      this.set({ state });
    }
    if (message.type === 'stale') this.emit('stale', message.id);
  }
}

module.exports = { LiveConnection };

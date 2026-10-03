// What the live panel shows, worked out from hyperfocus's session files and bridge messages.
// Kept free of the vscode module so it can be tested with plain node.
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative, isAbsolute, posix, win32 } = require('node:path');

/** The bridge protocol this extension speaks (hyperfocus's src/bridge.js BRIDGE_PROTOCOL). */
const PROTOCOL = 1;
const MIN_CLI = '0.7.0';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', staged: 'Your staged change' };
const agentName = (id) => AGENT_NAMES[id] ?? 'The agent';
const KIND_LABELS = { why: '', bug: 'spot the bug', output: 'what does it do', predict: 'predict' };

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Running hyperfocus sessions, from their files. Files of finished processes are skipped. */
function listSessions(dir, { isAlive: alive = isAlive } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const session = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return Number.isInteger(session?.pid) && typeof session.endpoint === 'string' && alive(session.pid) ? [session] : [];
    } catch {
      return [];
    }
  });
}

const isWithin = (folder, path) => {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The session this window should follow: one started in a workspace folder, or under one, the
 * closest to its folder first, then the newest. With no match, the only session there is, if any.
 */
function pickSession(sessions, folders) {
  const distance = (session) => Math.min(...folders.filter((folder) => isWithin(folder, session.cwd)).map((folder) => relative(folder, session.cwd).length));
  const matching = sessions
    .map((session) => ({ session, distance: distance(session) }))
    .filter(({ distance }) => Number.isFinite(distance))
    .sort((a, b) => a.distance - b.distance || String(b.session.startedAt).localeCompare(String(a.session.startedAt)));
  if (matching.length) return matching[0].session;
  // A staged review belongs to the window that started it, never to one open on another folder.
  return sessions.length === 1 && sessions[0].agent !== 'staged' ? sessions[0] : null;
}

/** Why this extension can't follow a session speaking `protocol`, or null when it can. */
function protocolProblem(protocol) {
  if (protocol === PROTOCOL) return null;
  if (Number.isInteger(protocol) && protocol > PROTOCOL) return 'This hyperfocus is newer than the panel. Update the hyperfocus extension to follow it live.';
  return `Update hyperfocus to ${MIN_CLI} or later to follow it here live: npm i -g @ddalus/hyperfocus`;
}

const isFinished = (state) => Boolean(state?.agent && (state.agent.finished || state.agent.activity === 'done'));

/**
 * What the user can do right now, by the same rules as the keys in the terminal: while the "agent
 * finished" choice is up, only answering, skipping, keep going and back.
 */
function controlsFor(state) {
  const { question, feedback } = state;
  const finished = Boolean(state.agent?.finished);
  const pending = (state.thread ?? []).some((item) => item.answer === null);
  return {
    answer: Boolean(question && !feedback),
    skip: Boolean(question && !feedback),
    rate: Boolean(question && !finished),
    next: Boolean(feedback && !finished),
    save: Boolean(feedback && !feedback.saved && !finished),
    followUp: Boolean(feedback && !pending && !finished),
    keepGoing: finished && Boolean(question),
    back: finished,
    exit: !finished, // Esc in the terminal: back to the agent, whatever is up
  };
}

/** Bridge state → what the live card shows. `agent` is the session's agent id. */
function liveModel(state, { agent: agentId = 'claude' } = {}) {
  const { agent, question, feedback } = state;
  const name = agentName(agentId);
  const staged = agentId === 'staged';
  const status = staged
    ? { text: question ? 'Reviewing your staged change' : 'Writing questions about your staged change…', tone: question ? 'waiting' : 'busy' }
    : isFinished(state)
      ? { text: `${name} finished`, tone: 'finished' }
      : agent.busy
        ? { text: `${name} is ${agent.activity}`, tone: 'busy' }
        : { text: `${name} is ${agent.activity || 'idle'}`, tone: 'waiting' };
  const mark = (index) => {
    if (!feedback || feedback.answer === null || feedback.answer === undefined) return feedback?.chosen === index ? 'chosen' : '';
    if (index === feedback.answer) return 'answer';
    return index === feedback.chosen ? 'chosen' : '';
  };
  const kind = KIND_LABELS[question?.kind] ?? '';
  return {
    status,
    summary: state.run?.summary ?? '',
    question: question
      ? {
          id: question.id,
          kind: question.kind ?? 'why',
          heading: `Question ${question.number}${kind ? ' · ' + kind : ''}`,
          q: question.q,
          code: question.code ?? '',
          file: question.file ?? question.anchor?.file ?? '',
          options: question.options.map((text, index) => ({ key: String(index + 1), text, mark: mark(index) })),
        }
      : null,
    feedback: feedback
      ? feedback.correct === null
        ? { verdict: 'Locked in: settled by the next edit', tone: 'muted', why: feedback.why ?? '', saved: Boolean(feedback.saved) }
        : { verdict: feedback.correct ? 'Right' : 'Not quite', tone: feedback.correct ? 'good' : 'bad', why: feedback.why ?? '', saved: Boolean(feedback.saved) }
      : null,
    thread: state.thread ?? [],
    queued: state.queued ? `${state.queued} more question${state.queued === 1 ? '' : 's'} waiting` : '',
    score: state.score?.answered ? `${state.score.correct} of ${state.score.answered} right this run` : '',
    quiet: Boolean(state.quiet),
    staged,
    // A staged review has no agent to finish: it can be ended any time.
    controls: staged ? { ...controlsFor(state), back: true, keepGoing: false, exit: false } : controlsFor(state),
  };
}

/** True when this state is the moment the agent finished: worth a notification. */
function finishedNow(previous, next, { staged = false } = {}) {
  if (staged || !previous || !next || next.quiet) return false;
  return !isFinished(previous) && isFinished(next);
}

/**
 * Where an anchor's lines are in `text` now (0-based, inclusive), by the rule hyperfocus uses to
 * tell whether a change is still in the code: at least half of its lines must still be there.
 */
function anchorRange(anchor, text) {
  const anchors = anchor?.anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  const lines = String(text).split('\n').map((line) => line.trim());
  const found = anchors.map((wanted) => lines.indexOf(wanted)).filter((index) => index >= 0);
  if (found.length * 2 < anchors.length) return null;
  const start = Math.min(...found);
  const end = Math.max(...found);
  // Lines that turn up far apart are matches of common text, not one change: keep the first.
  return end - start > 80 ? { start, end: start } : { start, end };
}

const RESULT_ICONS = { true: '✅ right', false: '❌ wrong' };

/**
 * Gutter marks for one open file: questions answered about it in this project, the latest answer
 * per question, at the lines they were about. Skips, predictions and bad questions get none.
 */
function gutterMarks(entries, { cwd, file, text }) {
  const bad = new Set(entries.filter((entry) => entry.rating === 'bad').map((entry) => entry.question));
  const latest = new Map();
  for (const entry of entries) {
    if (entry.cwd !== cwd || entry.anchor?.file !== file || typeof entry.correct !== 'boolean' || bad.has(entry.question)) continue;
    const seen = latest.get(entry.question);
    if (!seen || String(entry.ts) >= String(seen.ts)) latest.set(entry.question, entry);
  }
  const marks = [];
  for (const entry of latest.values()) {
    const range = anchorRange(entry.anchor, text);
    if (!range) continue;
    const yours = entry.options?.[entry.chosen];
    const right = entry.options?.[entry.answer];
    const hover = [`**hyperfocus** · ${RESULT_ICONS[entry.correct]} · ${String(entry.ts).slice(0, 10)}`, '', entry.question, '', `You: ${yours ?? '–'}`, entry.correct ? '' : `Answer: ${right ?? '–'}`, entry.why ? `\n${entry.why}` : '']
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');
    marks.push({ line: range.start, end: range.end, correct: entry.correct, question: entry.question, hover });
  }
  return marks.sort((a, b) => a.line - b.line);
}

const isFileOnDisk = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A program on PATH, as hyperfocus finds agents (PATHEXT on Windows), or null. */
function findOnPath(name, { env = process.env, platform = process.platform, isFile = isFileOnDisk } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const extensions = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()) : [''];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The terminal command that starts hyperfocus: `hyperfocus` when it is installed, else npx, then the
 * agent (Claude needs none). A command the user configured themselves is used as it is.
 */
function startCommand({ configured, defaultCommand, hyperfocusOnPath, agent = 'claude', extra = '' }) {
  if (configured && configured.trim() !== defaultCommand) return [configured.trim(), extra].filter(Boolean).join(' ');
  const base = hyperfocusOnPath ? 'hyperfocus' : defaultCommand;
  return [base, agent === 'claude' ? '' : agent, extra].filter(Boolean).join(' ');
}

/** The status bar item: whether a session is running, what's waiting, the streak. */
function statusBarText(state) {
  if (!state) return '$(circle-outline) hyperfocus';
  const waiting = (state.question && !state.feedback ? 1 : 0) + (state.queued ?? 0);
  const parts = ['$(circle-filled) hyperfocus'];
  if (waiting) parts.push(`${waiting} waiting`);
  if (state.score?.streak) parts.push(`streak ${state.score.streak}`);
  return parts.join(' · ');
}

/**
 * The absolute path of `file` when it is inside `cwd`, else null. Question files come from the
 * model, so "open the code" must never reach outside the project (a key in ~/.ssh, say).
 */
function resolveInside(cwd, file) {
  if (!cwd || typeof file !== 'string' || !file) return null;
  const path = isAbsolute(file) ? file : join(cwd, file);
  return isWithin(cwd, path) ? path : null;
}

module.exports = {
  resolveInside,
  PROTOCOL,
  MIN_CLI,
  agentName,
  listSessions,
  pickSession,
  protocolProblem,
  controlsFor,
  liveModel,
  statusBarText,
  finishedNow,
  anchorRange,
  gutterMarks,
  findOnPath,
  startCommand,
};

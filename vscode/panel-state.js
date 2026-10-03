// What the live panel shows, worked out from hyperfocus's session files and bridge messages.
// Kept free of the vscode module so it can be tested with plain node.
const { readdirSync, readFileSync } = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');

/** The bridge protocol this extension speaks (hyperfocus's src/bridge.js BRIDGE_PROTOCOL). */
const PROTOCOL = 1;
const MIN_CLI = '0.7.0';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
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
  return sessions.length === 1 ? sessions[0] : null;
}

/** Why this extension can't follow a session speaking `protocol`, or null when it can. */
function protocolProblem(protocol) {
  if (protocol === PROTOCOL) return null;
  if (Number.isInteger(protocol) && protocol > PROTOCOL) return 'This hyperfocus is newer than the panel. Update the hyperfocus extension to follow it live.';
  return `Update hyperfocus to ${MIN_CLI} or later to follow it here live: npm i -g @ddalus/hyperfocus`;
}

/** Bridge state → what the live card shows. */
function liveModel(state, { agentName: name = 'Claude' } = {}) {
  const { agent, question, feedback } = state;
  const status = agent.finished || agent.activity === 'done'
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
          heading: `Question ${question.number}${kind ? ' · ' + kind : ''}`,
          q: question.q,
          code: question.code ?? '',
          file: question.file ?? question.anchor?.file ?? '',
          options: question.options.map((text, index) => ({ key: String(index + 1), text, mark: mark(index) })),
        }
      : null,
    feedback: feedback
      ? feedback.correct === null
        ? { verdict: 'Locked in: settled by the next edit', tone: 'muted', why: feedback.why ?? '' }
        : { verdict: feedback.correct ? 'Right' : 'Not quite', tone: feedback.correct ? 'good' : 'bad', why: feedback.why ?? '' }
      : null,
    thread: state.thread ?? [],
    queued: state.queued ? `${state.queued} more question${state.queued === 1 ? '' : 's'} waiting` : '',
    score: state.score?.answered ? `${state.score.correct} of ${state.score.answered} right this run` : '',
    quiet: Boolean(state.quiet),
  };
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

module.exports = { PROTOCOL, MIN_CLI, agentName, listSessions, pickSession, protocolProblem, liveModel, statusBarText };

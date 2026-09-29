import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { debugLog } from './debug-log.js';
import { SYSTEM_PROMPT, buildQuizPrompt, parseQuizReply } from './quiz-prompt.js';

const NEW_EDITS_BEFORE_REFRESH = 3;

// A lean one-shot Claude: no tools, no MCP, no hooks, no saved session, and our own system prompt.
// Cutting the default context this way makes each call roughly 70x cheaper. The user's settings
// files still load, because that is where auth such as apiKeyHelper lives.
const QUIZ_MODEL_ARGS = [
  '-p',
  '--model', 'haiku',
  '--output-format', 'json',
  '--tools', '',
  '--no-session-persistence',
  '--setting-sources', 'user,project,local',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--strict-mcp-config',
  '--system-prompt', SYSTEM_PROMPT,
];

/**
 * Turns the current run into question batches by asking a small model, and decides when it
 * is worth asking again. Emits 'batch' with { summary, questions }.
 */
export function createQuizEngine({ claudePath, env = process.env }) {
  const engine = new EventEmitter();
  /** @type {NodeJS.ProcessEnv} */
  // Haiku thinks for ~3k tokens by default here, which turned a 6s batch into 30s.
  const childEnv = { ...env, HYPERFOCUS_CHILD: '1', MAX_THINKING_TOKENS: '0' };
  delete childEnv.HYPERFOCUS_SOCK;

  let inFlight = null;
  let runStartedAt = null;
  let editsAtLastBatch = 0;
  let activityAtLastBatch = -1;
  let lastBatchWasEmpty = false;
  let askedQuestions = [];

  function shouldGenerate(run, queuedQuestions) {
    if (inFlight || !run || run.finished) return false;
    const activity = activityOf(run);
    if (!run.prompt && activity === 0) return false;
    // Questions written before anything changed are about the plan; the first real diff deserves fresh ones.
    if (editsAtLastBatch === 0 && run.edits.length > 0) return true;
    if (queuedQuestions > 0) return run.edits.length - editsAtLastBatch >= NEW_EDITS_BEFORE_REFRESH;
    return !(activity === activityAtLastBatch && lastBatchWasEmpty);
  }

  async function generate(run) {
    const call = { child: null, cancelled: false };
    inFlight = call;
    editsAtLastBatch = run.edits.length;
    activityAtLastBatch = activityOf(run);
    const prompt = buildQuizPrompt(run, askedQuestions);

    let batch = null;
    for (let attempt = 1; attempt <= 2 && !call.cancelled; attempt++) {
      const reply = await askModel(prompt, call);
      if (!reply || reply.isError) break;
      batch = parseQuizReply(reply.text);
      if (batch) break;
      debugLog('quiz reply was not valid JSON, attempt', attempt);
    }

    if (inFlight === call) inFlight = null;
    if (call.cancelled || runStartedAt !== run.startedAt) return;
    lastBatchWasEmpty = !batch || batch.questions.length === 0;
    if (!batch) return;
    askedQuestions.push(...batch.questions.map((question) => question.q));
    engine.emit('batch', batch);
  }

  function askModel(prompt, call) {
    return new Promise((resolve) => {
      const child = spawn(claudePath, QUIZ_MODEL_ARGS, { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
      call.child = child;
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('error', (error) => {
        debugLog('quiz model failed to start', error.message);
        resolve(null);
      });
      child.on('close', () => {
        if (call.cancelled) return resolve(null);
        try {
          const { result, is_error: isError } = JSON.parse(stdout);
          if (isError) debugLog('quiz model error', String(result).slice(0, 200));
          resolve({ text: String(result ?? ''), isError: Boolean(isError) });
        } catch {
          debugLog('quiz model output unreadable', stdout.slice(0, 200));
          resolve(null);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  function update(run, { queuedQuestions }) {
    if (run && run.startedAt !== runStartedAt) {
      cancel(); // the previous run's questions are no longer wanted
      runStartedAt = run.startedAt;
      editsAtLastBatch = 0;
      activityAtLastBatch = -1;
      lastBatchWasEmpty = false;
      askedQuestions = [];
    }
    if (shouldGenerate(run, queuedQuestions)) void generate(run);
  }

  function cancel() {
    if (!inFlight) return;
    inFlight.cancelled = true;
    inFlight.child?.kill();
    inFlight = null;
  }

  return Object.assign(engine, { update, cancel });
}

const activityOf = (run) => run.reads.length + run.edits.length + run.commands.length;

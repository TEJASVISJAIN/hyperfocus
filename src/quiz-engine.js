import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { surroundingCode } from './code-context.js';
import { debugLog } from './debug-log.js';
import { anchorFor } from './code-anchors.js';
import { DEFAULT_CONFIG } from './config.js';
import { FOLLOW_UP_SYSTEM_PROMPT, SYSTEM_PROMPT, buildFollowUpPrompt, buildQuizPrompt, parseQuizReply, shuffleOptions } from './quiz-prompt.js';

const NEW_EDITS_BEFORE_REFRESH = 3;

// A lean one-shot Claude: no tools, no MCP, no hooks, no saved session, and our own system prompt.
// Cutting the default context this way makes each call roughly 70x cheaper. The user's settings
// files still load, because that is where auth such as apiKeyHelper lives.
const modelArgs = (systemPrompt, model) => [
  '-p',
  '--model', model,
  '--output-format', 'json',
  '--tools', '',
  '--no-session-persistence',
  '--setting-sources', 'user,project,local',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--strict-mcp-config',
  '--system-prompt', systemPrompt,
];

/**
 * Turns the current run into question batches by asking a small model, and decides when it
 * is worth asking again. Emits 'batch' with { summary, questions }.
 *
 * `accuracy()` reports how the developer has been doing, so the questions can get harder or easier.
 */
export function createQuizEngine({
  claudePath,
  env = process.env,
  model = DEFAULT_CONFIG.model,
  kinds = DEFAULT_CONFIG.kinds,
  questionsPerBatch = DEFAULT_CONFIG.questionsPerBatch,
  accuracy = () => undefined,
  random = Math.random,
  avoid = () => [],
  readContext = (run) => surroundingCode(run, { cwd: process.cwd() }),
}) {
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
  let keepGoing = false; // the user chose to carry on with the quiz after Claude finished

  function shouldGenerate(run, queuedQuestions) {
    if (inFlight || !run || (run.finished && !keepGoing)) return false;
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
    const prompt = buildQuizPrompt(run, askedQuestions, { kinds, count: questionsPerBatch, accuracy: accuracy(), context: readContext(run), avoid: avoid() });

    let batch = null;
    for (let attempt = 1; attempt <= 2 && !call.cancelled; attempt++) {
      const reply = await askModel(prompt, call, SYSTEM_PROMPT);
      if (!reply || reply.isError) break;
      batch = parseQuizReply(reply.text, { run, kinds });
      if (batch) break;
      debugLog('quiz reply was not valid JSON, attempt', attempt);
    }

    if (inFlight === call) inFlight = null;
    if (call.cancelled || runStartedAt !== run.startedAt) return;
    lastBatchWasEmpty = !batch || batch.questions.length === 0;
    if (!batch) return;
    askedQuestions.push(...batch.questions.map((question) => question.q));
    const questions = batch.questions.map((question) => {
      const anchor = anchorFor(question, run);
      return { ...shuffleOptions(question, random), ...(anchor ? { anchor } : {}) };
    });
    engine.emit('batch', { summary: batch.summary, questions });
  }

  function askModel(prompt, call, systemPrompt) {
    return new Promise((resolve) => {
      const child = spawn(claudePath, modelArgs(systemPrompt, model), { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
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

  function update(run, { queuedQuestions, keepGoing: userKeepsGoing = false }) {
    keepGoing = userKeepsGoing;
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

  // Answers the user's own follow-up. Runs beside question generation and never blocks it.
  async function askFollowUp(run, request) {
    const reply = await askModel(buildFollowUpPrompt(run, request), { child: null, cancelled: false }, FOLLOW_UP_SYSTEM_PROMPT);
    if (!reply || reply.isError || !reply.text.trim()) return null;
    return reply.text.trim();
  }

  return Object.assign(engine, { update, cancel, askFollowUp });
}

const activityOf = (run) => run.reads.length + run.edits.length + run.commands.length;

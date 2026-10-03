import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAgent } from './agents/claude.js';
import { anchorFor } from './code-anchors.js';
import { surroundingCode } from './code-context.js';
import { DEFAULT_CONFIG } from './config.js';
import { debugLog } from './debug-log.js';
import { launchCommand } from './launch.js';
import {
  FOLLOW_UP_SYSTEM_PROMPT,
  LESSON_ASK,
  LESSON_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildFollowUpPrompt,
  buildQuizPrompt,
  parseQuizReply,
  questionChecker,
  shuffleOptions,
  streamedQuestions,
} from './quiz-prompt.js';

const NEW_EDITS_BEFORE_REFRESH = 3;
// A warm writer nobody asked for in this long is closed: it has sent nothing, so it cost nothing.
const WARM_IDLE_MS = 5 * 60_000;

// The child writes questions, so hyperfocus's own hooks must not follow it.
function writerEnv(writer, env) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...writer.env(env), HYPERFOCUS_CHILD: '1' };
  delete childEnv.HYPERFOCUS_SOCK;
  return childEnv;
}

// Question writers run in an empty folder: run in the project, Claude Code would load its CLAUDE.md
// and the agent's memory for it (about 1,300 tokens), and questions came out about those notes.
// The project reaches the writer only through the brief and the run's own (redacted) changes.
// Its Claude settings files come along, though: they can hold how the user logs in (apiKeyHelper,
// Bedrock or Vertex env), and they carry no notes for the model.
const PROJECT_SETTINGS = ['settings.json', 'settings.local.json'];
let emptyFolder = null;
export function writerFolder(project = process.cwd()) {
  if (emptyFolder) return emptyFolder;
  emptyFolder = mkdtempSync(join(tmpdir(), 'hf-writer-'));
  const folder = emptyFolder;
  copyProjectSettings(project, folder);
  process.once('exit', () => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** Copies the project's Claude settings files (only those) into the writer's folder. */
export function copyProjectSettings(project, folder) {
  for (const name of PROJECT_SETTINGS) {
    try {
      mkdirSync(join(folder, '.claude'), { recursive: true });
      copyFileSync(join(project, '.claude', name), join(folder, '.claude', name));
    } catch {
      // No such file is the usual case.
    }
  }
}

/**
 * One question-writer call: a process (or, for `writer.request`, an HTTP call), its reply as text,
 * and the text written so far through `onText` while it streams.
 * `process` is a writer process already started and waiting for its prompt (see the warm writer).
 * @returns {{ done: Promise<{ text: string, isError: boolean } | null>, problem: () => string, cancel: () => void }}
 */
function callWriter({ writer, writerPath, model, env, cwd, systemPrompt, prompt, onText = /** @type {(text: string) => void} */ (() => {}), process: started = null }) {
  if (writer.request) {
    const controller = new AbortController();
    const done = writer
      .request({ systemPrompt, prompt, model, env, signal: controller.signal, onText })
      .catch((error) => {
        if (!controller.signal.aborted) debugLog('question writer request failed', error.message);
        return null;
      });
    return { done, problem: () => '', cancel: () => controller.abort() };
  }
  const child = started ?? startWriter({ writer, writerPath, model, env, cwd, systemPrompt });
  let cancelled = false;
  let problem = ''; // why there was no reply, for --doctor: the first line of stderr, or the spawn error
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    if (problem.length < 500) problem += chunk;
  });
  const done = new Promise((resolve) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (writer.streamText) onText(writer.streamText(stdout));
    });
    child.on('error', (error) => {
      debugLog('question writer failed to start', error.message);
      problem = error.message;
      resolve(null);
    });
    child.on('close', () => {
      if (cancelled) return resolve(null);
      const reply = writer.parse(stdout);
      if (!reply) debugLog('question writer output unreadable', stdout.slice(0, 200));
      else if (reply.isError) debugLog('question writer error', reply.text.slice(0, 200));
      resolve(reply);
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(writer.input ? writer.input(systemPrompt, prompt) : prompt);
  return {
    done,
    problem: () => problem.trim().split('\n')[0].slice(0, 160),
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}

function startWriter({ writer, writerPath, model, env, cwd, systemPrompt }) {
  const launch = launchCommand(writerPath, writer.args(systemPrompt, model));
  return spawn(launch.command, launch.args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * One call to the question writer outside the quiz (the project brief), the same clean way.
 * @param {{ path: string, adapter: import('./agents/claude.js').QuestionWriter, model: string | null }} writer
 * @param {{ systemPrompt: string, prompt: string, env?: NodeJS.ProcessEnv }} request
 * @returns {Promise<string | null>} the reply, or null when there was none
 */
export async function askWriterOnce(writer, { systemPrompt, prompt, env = process.env }) {
  const reply = await callWriter({ writer: writer.adapter, writerPath: writer.path, model: writer.model, env: writerEnv(writer.adapter, env), cwd: writerFolder(), systemPrompt, prompt }).done;
  return reply && !reply.isError && reply.text.trim() ? reply.text.trim() : null;
}

/**
 * One tiny call made exactly the way questions are written, for `hyperfocus --doctor`.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function probeQuestionWriter({ claudePath, writer = claudeAgent.writer, model = DEFAULT_CONFIG.model, env = process.env, timeoutMs = 60_000 }) {
  const startedAt = Date.now();
  const call = callWriter({ writer, writerPath: claudePath, model, env: writerEnv(writer, env), cwd: writerFolder(), systemPrompt: 'Reply with the single word: ok', prompt: 'ok?' });
  const timer = setTimeout(call.cancel, timeoutMs);
  const reply = await call.done;
  clearTimeout(timer);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (!reply) return { ok: false, detail: Date.now() - startedAt >= timeoutMs ? `no reply in ${timeoutMs / 1000}s` : call.problem() || 'no reply' };
  if (reply.isError) return { ok: false, detail: reply.text.slice(0, 160) };
  return { ok: true, detail: `${model ?? 'the default model'} answered in ${seconds}s` };
}

/**
 * Turns the current run into questions by asking a small model, and decides when it is worth
 * asking again. Emits 'batch' with { summary, questions, reply, final } — while a reply streams,
 * once per question as soon as it is written, then once with `final: true` and the summary (which
 * may be '' and carry no questions). `reply` numbers the reply. A cancelled reply has no final batch.
 *
 * `accuracy()` reports how the developer has been doing, so the questions can get harder or easier.
 * `brief()` is the project brief, or null while it isn't ready (see project-brief.js).
 */
export function createQuizEngine({
  claudePath,
  writer = claudeAgent.writer, // how the question writer is called and read
  env = process.env,
  model = DEFAULT_CONFIG.model,
  kinds = DEFAULT_CONFIG.kinds,
  questionsPerBatch = DEFAULT_CONFIG.questionsPerBatch,
  accuracy = () => undefined,
  random = Math.random,
  avoid = () => [],
  brief = () => null,
  readContext = (run) => surroundingCode(run, { cwd: process.cwd() }),
  workDir = undefined, // where writer processes run; an empty folder unless a test says otherwise
  warmIdleMs = WARM_IDLE_MS,
}) {
  const engine = new EventEmitter();
  const childEnv = writerEnv(writer, env);
  const cwd = workDir ?? writerFolder();
  const settings = { writer, writerPath: claudePath, model, env: childEnv, cwd };

  let inFlight = null;
  let runStartedAt = null;
  let editsAtLastBatch = 0;
  let activityAtLastBatch = -1;
  let lastBatchWasEmpty = false;
  let replies = 0; // numbers each reply, so its batches can be told apart
  let askedQuestions = [];
  let keepGoing = false; // the user chose to carry on with the quiz after Claude finished
  let warm = null; // { child, timer }: the next question call, started and waiting for its prompt
  let closed = false;

  function shouldGenerate(run, queuedQuestions) {
    if (inFlight || !run || (run.finished && !keepGoing)) return false;
    const activity = activityOf(run);
    if (!run.prompt && activity === 0) return false;
    // Questions written before anything changed are about the plan; the first real diff deserves fresh ones.
    if (editsAtLastBatch === 0 && run.edits.length > 0) return true;
    if (queuedQuestions > 0) return run.edits.length - editsAtLastBatch >= NEW_EDITS_BEFORE_REFRESH;
    return !(activity === activityAtLastBatch && lastBatchWasEmpty);
  }

  // The warm process, if one is waiting and still alive; it is used once.
  function takeWarm() {
    const taken = warm;
    warm = null;
    if (!taken) return null;
    clearTimeout(taken.timer);
    const { child } = taken;
    if (child.exitCode !== null || child.killed) return null;
    holdOpen(child, true);
    return child;
  }

  function startWarm() {
    if (!writer.warm || writer.request || warm || closed) return;
    const child = startWriter({ ...settings, systemPrompt: SYSTEM_PROMPT });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    // Waiting, it must not keep hyperfocus running; once used, it does again.
    holdOpen(child, false);
    const timer = setTimeout(dropWarm, warmIdleMs);
    timer.unref?.();
    warm = { child, timer };
  }

  // Closing stdin unused makes the writer exit without calling the model; kill makes sure.
  function dropWarm() {
    const child = takeWarm();
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  async function generate(run) {
    const call = { cancel: () => {}, cancelled: false };
    inFlight = call;
    editsAtLastBatch = run.edits.length;
    activityAtLastBatch = activityOf(run);
    const prompt = buildQuizPrompt(run, askedQuestions, { kinds, count: questionsPerBatch, accuracy: accuracy(), context: readContext(run), avoid: avoid(), brief: brief() });
    const check = questionChecker({ run, kinds });
    const isCurrent = () => !call.cancelled && runStartedAt === run.startedAt;

    let emitted = 0; // questions already read from this reply while it streamed, valid or not
    let shown = 0;
    const reply = ++replies;
    const emit = (raws, summary, final = false) => {
      const questions = raws
        .map(check)
        .filter(Boolean)
        .map((question) => prepare(question, run))
        .filter(Boolean);
      askedQuestions.push(...questions.map((question) => question.q));
      if (questions.length || summary || final) engine.emit('batch', { summary, questions, reply, final });
      return questions.length;
    };
    const onText = (text) => {
      if (!isCurrent()) return;
      const written = streamedQuestions(text);
      // The last one found may be followed by more of the reply; every earlier one is final.
      if (written.length > emitted) {
        const fresh = written.slice(emitted);
        emitted = written.length;
        shown += emit(fresh, '');
      }
    };

    let finalRaws = null;
    let summary = '';
    for (let attempt = 1; attempt <= 2 && !call.cancelled; attempt++) {
      const pending = callWriter({ ...settings, systemPrompt: SYSTEM_PROMPT, prompt, onText, process: takeWarm() });
      call.cancel = pending.cancel;
      const reply = await pending.done;
      if (!reply || reply.isError) break;
      const parsed = parseQuizReply(reply.text, { run, kinds });
      if (parsed) {
        summary = parsed.summary;
        finalRaws = streamedQuestions(reply.text);
        break;
      }
      if (emitted > 0) break; // what streamed stands; the rest of the reply was unreadable
      debugLog('quiz reply was not valid JSON, attempt', attempt);
    }

    if (inFlight === call) inFlight = null;
    if (!isCurrent()) return;
    // Whatever the stream didn't already show (all of it, for writers that don't stream), then the summary.
    const shownAtEnd = emit(finalRaws ? finalRaws.slice(emitted) : [], summary, true);
    lastBatchWasEmpty = shown + shownAtEnd === 0;
    // The next call's start-up is paid now, while the user reads these.
    if (!run.finished || keepGoing) startWarm();
  }

  // A checked question, placed: its options shuffled, and where it comes from. One with no source
  // (no file it is about and no prompt to name) is dropped.
  function prepare(question, run) {
    const anchor = anchorFor(question, run);
    const placed = { ...shuffleOptions(question, random), ...(anchor ? { anchor } : {}) };
    if (anchor || question.file) return placed;
    return run.prompt ? { ...placed, plan: run.prompt } : null;
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

  // Stops the call in flight. The warm process stays: the next run can use it.
  function cancel() {
    if (!inFlight) return;
    inFlight.cancelled = true;
    inFlight.cancel();
    inFlight = null;
  }

  /** The run is over and nobody wants more: nothing keeps running, warm or not. */
  function idle() {
    cancel();
    dropWarm();
  }

  function close() {
    closed = true;
    idle();
  }

  // Answers the user's own follow-up, or gives the lesson after a miss (`ask` is LESSON_ASK).
  // Runs beside question generation and never blocks it.
  async function askFollowUp(run, request) {
    const lesson = request.ask === LESSON_ASK;
    const anchored = request.question.anchor ? surroundingCode({ edits: [{ path: request.question.anchor.file, diff: '', anchors: request.question.anchor.anchors }] }, { cwd: process.cwd() }) : [];
    const prompt = buildFollowUpPrompt(run, { ...request, context: anchored, brief: brief() });
    const reply = await callWriter({ ...settings, systemPrompt: lesson ? LESSON_SYSTEM_PROMPT : FOLLOW_UP_SYSTEM_PROMPT, prompt }).done;
    if (!reply || reply.isError || !reply.text.trim()) return null;
    return reply.text.trim();
  }

  // isWarm: a process is started and waiting for the next call.
  return Object.assign(engine, { update, cancel, idle, close, askFollowUp, isWarm: () => Boolean(warm) });
}

function holdOpen(child, hold) {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
    const socket = /** @type {any} */ (handle);
    if (hold) socket?.ref?.();
    else socket?.unref?.();
  }
}

const activityOf = (run) => run.reads.length + run.edits.length + run.commands.length;

import { createActivityLog, relativeToProject } from './activity-log.js';
import { claudeAgent } from './agents/claude.js';
import { DEFAULT_CONFIG } from './config.js';
import { createFocusView } from './focus-view.js';
import { createQuizEngine } from './quiz-engine.js';
import { redactSecrets } from './redact.js';
import { colorAllowed } from './styles.js';

// Connects agent events to the activity log, the quiz engine and the focus view.
// `redraw` is called whenever what the focus view shows may have changed; `onBack` when the user
// asks to go back to Claude from the "Claude finished" prompt, `onExit` when they leave the focus view
// with Esc (or Enter while no question is up). `projectAccuracy` is how the user
// did in this project before, which sets how hard the first questions are. `brief` is the project
// brief (or null while it isn't ready); `dueRepeats` the missed questions due to be asked again,
// one of which joins each batch.
export function createFocusSession({
  claudePath,
  redraw,
  onAnswer = undefined,
  onBack = undefined,
  onExit = undefined,
  onQuiet = undefined,
  onSave = undefined,
  config = DEFAULT_CONFIG,
  agent = claudeAgent,
  writer = { path: claudePath, adapter: agent.writer, model: config.model }, // who writes the questions
  projectAccuracy = { answered: 0, correct: 0 },
  badQuestions = () => [],
  brief = () => null,
  dueRepeats = () => [],
  onQuestions = () => {}, // new questions are ready to answer
  onReplyDone = () => {}, // the question writer finished a reply (whether or not it had questions)
}) {
  const log = createActivityLog();
  let missedThisRun = []; // wrong answers in the current run, for the "worth a look" checklist
  const engine = createQuizEngine({
    claudePath: writer.path,
    writer: writer.adapter,
    model: writer.model,
    kinds: config.kinds,
    questionsPerBatch: config.questionsPerBatch,
    accuracy: () => ({
      answered: projectAccuracy.answered + view.score.answered,
      correct: projectAccuracy.correct + view.score.correct,
    }),
    avoid: badQuestions,
    brief,
  });
  const repeated = new Set(); // questions already asked again this session
  let newInReply = { reply: 0, count: 0 }; // new questions so far in the reply being read
  let keepGoing = false; // chose to carry on with the quiz after Claude finished
  const view = createFocusView({
    agentName: agent.name,
    live: config.live,
    color: colorAllowed(),
    animations: config.animations,
    onAnswer: (entry) => {
      if (entry.correct === false) missedThisRun.push(entry);
      if (entry.rating === 'bad') missedThisRun = missedThisRun.filter((missed) => missed.question !== entry.question);
      onAnswer?.(entry, log.run);
      askForMoreIfNeeded();
    },
    onFollowUp: async (request) => {
      const answer = await engine.askFollowUp(log.run, request);
      if (answer) view.setFollowUpAnswer(answer, request.question);
      else view.setFollowUpFailed(request.question);
      redraw();
    },
    onKeepGoing: () => {
      keepGoing = true;
      askForMoreIfNeeded();
    },
    onBack: () => onBack?.(),
    onExit: () => onExit?.(),
    onQuiet: onQuiet && (() => onQuiet()),
    onSave: onSave && ((entry) => onSave(entry, log.run)),
  });

  function askForMoreIfNeeded() {
    engine.update(log.run, { queuedQuestions: view.queuedQuestions, keepGoing });
  }

  function runEnded() {
    engine.idle();
    view.expirePredictions();
  }

  engine.on('batch', (batch) => {
    const { run } = log;
    // Time to first question, for --stats: the moment one exists, whatever screen shows it.
    if (run && !run.firstQuestionAt && batch.questions.length) run.firstQuestionAt = Date.now();
    if (batch.summary) view.setSummary(batch.summary);
    view.addQuestions(batch.questions);
    if (newInReply.reply !== batch.reply) newInReply = { reply: batch.reply, count: 0 };
    newInReply.count += batch.questions.length;
    // At the end of a reply, one missed question due again joins its new ones.
    if (batch.final) {
      const hadNew = newInReply.count > 0;
      const again = hadNew && safely(dueRepeats).find((question) => !repeated.has(question.q));
      if (again) {
        repeated.add(again.q);
        view.addQuestions([again]);
      }
    }
    if (batch.questions.length) onQuestions();
    if (batch.final) onReplyDone();
    redraw();
  });

  return {
    view,
    get run() {
      return log.run;
    },
    get missedThisRun() {
      return missedThisRun;
    },

    agentEvent(event) {
      log.record(event);
      if (event.type === 'busy') {
        keepGoing = false;
        missedThisRun = [];
        view.newRun(log.run.startedAt);
      }
      if (event.type === 'edit') view.resolvePredictions(log.run.edits.at(-1).path);
      view.setFeed(log.run?.timeline ?? []);
      view.setProgress(log.progress);
      const label = activityLabel(event);
      if (label) view.setActivity(label, Date.now());
      if (event.type === 'done') runEnded();
      else askForMoreIfNeeded();
      redraw();
    },

    /** Records a whole run at once (a staged change), then asks for questions about all of it. */
    replay(events) {
      for (const event of events) log.record(event);
      view.setFeed(log.run?.timeline ?? []);
      askForMoreIfNeeded();
      redraw();
    },

    // The user stopped Claude: treat the run as over, since Claude Code sends no Stop hook for it.
    userInterrupted() {
      if (!log.run || log.run.finished) return;
      log.record({ type: 'done', sessionId: '' });
      runEnded();
    },

    handleKey(key) {
      view.handleKey(key);
      redraw();
    },

    /** The focus view's state plus the run it is about, for the VS Code panel (see bridge.js). */
    snapshot() {
      const state = view.snapshot();
      const { run } = log;
      const files = run ? [...new Set(run.edits.map((edit) => relativeToProject(edit.path)))] : [];
      return { ...state, run: { ...state.run, startedAt: run?.startedAt ?? null, prompt: run?.prompt ?? null, files } };
    },

    /** An action from another surface, done as the matching key would do it. */
    act(action) {
      const outcome = view.act(action);
      if (outcome === 'ok') redraw();
      return outcome;
    },
  };
}

function safely(read) {
  try {
    return read() ?? [];
  } catch {
    return [];
  }
}

function activityLabel(event) {
  switch (event.type) {
    case 'busy':
      return 'thinking';
    case 'read':
      return `reading ${relativeToProject(event.target)}`;
    case 'edit':
      return `editing ${relativeToProject(event.path)}`;
    case 'command':
      return `running ${redactSecrets(event.command).split('\n')[0]}`;
    case 'subagent':
      return `subagent: ${event.description}`;
    case 'needs-input':
      return 'waiting for you';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

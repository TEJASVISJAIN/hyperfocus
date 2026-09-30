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
// did in this project before, which sets how hard the first questions are.
export function createFocusSession({
  claudePath,
  redraw,
  onAnswer = undefined,
  onBack = undefined,
  onExit = undefined,
  onQuiet = undefined,
  config = DEFAULT_CONFIG,
  agent = claudeAgent,
  writer = { path: claudePath, adapter: agent.writer, model: config.model }, // who writes the questions
  projectAccuracy = { answered: 0, correct: 0 },
  badQuestions = () => [],
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
  });
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
  });

  function askForMoreIfNeeded() {
    engine.update(log.run, { queuedQuestions: view.queuedQuestions, keepGoing });
  }

  function runEnded() {
    engine.cancel();
    view.expirePredictions();
  }

  engine.on('batch', (batch) => {
    if (batch.summary) view.setSummary(batch.summary);
    view.addQuestions(batch.questions);
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
  };
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

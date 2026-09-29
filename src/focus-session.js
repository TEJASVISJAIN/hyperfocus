import { createActivityLog, relativeToProject } from './activity-log.js';
import { createFocusView } from './focus-view.js';
import { createQuizEngine } from './quiz-engine.js';

// Connects agent events to the activity log, the quiz engine and the focus view.
// `redraw` is called whenever what the focus view shows may have changed; `onBack` when the user
// asks to go back to Claude from the "Claude finished" prompt.
export function createFocusSession({ claudePath, redraw, onAnswer = undefined, onBack = undefined }) {
  const log = createActivityLog();
  const engine = createQuizEngine({ claudePath });
  let keepGoing = false; // chose to carry on with the quiz after Claude finished
  const view = createFocusView({
    onAnswer: (entry) => {
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
  });

  function askForMoreIfNeeded() {
    engine.update(log.run, { queuedQuestions: view.queuedQuestions, keepGoing });
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

    agentEvent(event) {
      log.record(event);
      if (event.type === 'busy') {
        keepGoing = false;
        view.newRun(log.run.startedAt);
      }
      const label = activityLabel(event);
      if (label) view.setActivity(label, Date.now());
      if (event.type === 'done') engine.cancel();
      else askForMoreIfNeeded();
      redraw();
    },

    // The user stopped Claude: treat the run as over, since Claude Code sends no Stop hook for it.
    userInterrupted() {
      if (!log.run || log.run.finished) return;
      log.record({ type: 'done', sessionId: '' });
      engine.cancel();
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
      return `running ${event.command.split('\n')[0]}`;
    case 'needs-input':
      return 'waiting for you';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

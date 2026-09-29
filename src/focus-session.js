import { createActivityLog, relativeToProject } from './activity-log.js';
import { createFocusView } from './focus-view.js';
import { createQuizEngine } from './quiz-engine.js';

// Connects agent events to the activity log, the quiz engine and the focus view.
// `redraw` is called whenever what the focus view shows may have changed.
export function createFocusSession({ claudePath, redraw, onAnswer = undefined }) {
  const log = createActivityLog();
  const engine = createQuizEngine({ claudePath });
  const view = createFocusView({
    onAnswer: (entry) => {
      onAnswer?.(entry, log.run);
      askForMoreIfNeeded();
    },
  });

  function askForMoreIfNeeded() {
    engine.update(log.run, { queuedQuestions: view.queuedQuestions });
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
      if (event.type === 'busy') view.newRun(log.run.startedAt);
      const label = activityLabel(event);
      if (label) view.setActivity(label, Date.now());
      if (event.type === 'done') engine.cancel();
      else askForMoreIfNeeded();
      redraw();
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

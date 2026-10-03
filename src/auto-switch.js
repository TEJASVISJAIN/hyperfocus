// Not 'subagent-done': Claude Code's prompt-suggestion agent finishes after Stop, when nothing is running.
// However little has changed, a run this long is a wait worth filling: questions can be about the
// code the agent is reading.
const LONG_RUN_MS = 30_000;
const AGENT_STEPS = new Set(['read', 'edit', 'command', 'subagent']);

/**
 * Decides when hyperfocus takes over the screen and when it hands it back.
 *
 * - The agent must be busy for `delayMs` first, so quick replies never interrupt.
 * - With `switchOn: 'edit'`, there must also be something to quiz on: an edit, or a plan of two or
 *   more steps. A plan of three or more halves the wait; in a project whose runs are usually short
 *   (`shortRuns`), it takes a second edit. A question already written counts too: the quiz opens
 *   once there is one to answer, not on a timer. After 30 seconds busy, it opens regardless.
 * - Never switch away while the user is typing.
 * - The moment the agent finishes or needs the user, give the screen back, whoever opened the focus view.
 * - If the user goes back to Claude by hand, respect it until their next prompt.
 */
export function createAutoSwitch({
  delayMs,
  typingGraceMs,
  auto = true,
  switchOn = 'edit',
  shortRuns = false,
  currentView,
  openFocus,
  returnToClaude,
}) {
  let agentBusy = false;
  let busySince = 0;
  let edits = 0;
  let planSteps = 0;
  let questionReady = false;
  let userChoseClaude = false;
  let lastTypedAt = -Infinity;
  let timer = null;

  function schedule(waitMs) {
    clearTimeout(timer);
    timer = setTimeout(openWhenReady, waitMs);
  }

  const somethingToQuizOn = () => switchOn === 'busy' || Date.now() - busySince >= LONG_RUN_MS || questionReady || edits >= (shortRuns ? 2 : 1) || planSteps >= 2;
  const waitMs = () => (switchOn === 'edit' && planSteps >= 3 ? delayMs / 2 : delayMs);

  function openWhenReady() {
    clearTimeout(timer);
    timer = null;
    if (!agentBusy || userChoseClaude || currentView() === 'focus') return;
    const tooSoonBy = busySince + waitMs() - Date.now();
    if (tooSoonBy > 0) return schedule(tooSoonBy);
    // The next edit or plan step checks again; failing those, a long run opens anyway.
    if (!somethingToQuizOn()) return schedule(busySince + LONG_RUN_MS - Date.now());
    const stillTypingFor = lastTypedAt + typingGraceMs - Date.now();
    if (stillTypingFor > 0) return schedule(stillTypingFor);
    openFocus();
  }

  return {
    agentEvent(event) {
      if (event.type === 'busy') {
        agentBusy = true;
        busySince = Date.now();
        edits = 0;
        planSteps = 0;
        questionReady = false;
        userChoseClaude = false;
        if (auto) schedule(delayMs);
        return;
      }
      if (event.type === 'edit') edits++;
      if (event.type === 'task-create') planSteps++;
      if (event.type === 'todos') planSteps = event.todos.length;
      if (event.type === 'task-create' || event.type === 'todos') {
        if (agentBusy && auto && !userChoseClaude) openWhenReady(); // a bigger plan can shorten the wait
        return;
      }
      if (AGENT_STEPS.has(event.type)) {
        // Claude carries on after a permission prompt without a new prompt event.
        if (agentBusy) {
          if (event.type === 'edit' && auto && !userChoseClaude) openWhenReady();
          return;
        }
        agentBusy = true;
        busySince = Date.now();
        if (auto && !userChoseClaude) schedule(delayMs);
        return;
      }
      if (event.type !== 'done' && event.type !== 'needs-input') return;

      const wasBusy = agentBusy;
      agentBusy = false;
      clearTimeout(timer);
      timer = null;
      if (wasBusy && currentView() === 'focus') returnToClaude(event.type);
    },

    // A question is written and waiting: that is something to quiz on.
    questionsReady() {
      questionReady = true;
      if (agentBusy && auto && !userChoseClaude) openWhenReady();
    },

    userTyped() {
      lastTypedAt = Date.now();
    },

    // Claude Code runs no Stop hook when the user interrupts, so the key press is our only signal.
    userInterrupted() {
      agentBusy = false;
      clearTimeout(timer);
      timer = null;
    },

    // "Not this session": the quiz only opens by hand from now on.
    goQuiet() {
      auto = false;
      clearTimeout(timer);
      timer = null;
    },

    manualToggle(toView) {
      if (toView !== 'claude') return;
      userChoseClaude = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

// Esc and Ctrl-C, plain or in the kitty / modifyOtherKeys encodings Claude Code turns on.
const INTERRUPT_KEY = /^(\x1b|\x03|\x1b\[27u|\x1b\[99;5u|\x1b\[27;5;99~)$/;

export const isInterruptKey = (key) => INTERRUPT_KEY.test(key);

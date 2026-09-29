/**
 * Decides when focus takes over the screen and when it hands it back.
 *
 * - The agent must be busy for `delayMs` first, so quick replies never interrupt.
 * - Never switch away while the user is typing.
 * - The moment the agent finishes or needs the user, give the screen back — whoever opened focus.
 * - If the user goes back to Claude by hand, respect it until their next prompt.
 */
export function createAutoSwitch({ delayMs, typingGraceMs, auto = true, currentView, openFocus, returnToClaude }) {
  let agentBusy = false;
  let userChoseClaude = false;
  let lastTypedAt = -Infinity;
  let timer = null;

  function schedule(waitMs) {
    clearTimeout(timer);
    timer = setTimeout(openWhenReady, waitMs);
  }

  function openWhenReady() {
    timer = null;
    if (!agentBusy || userChoseClaude || currentView() === 'focus') return;
    const stillTypingFor = lastTypedAt + typingGraceMs - Date.now();
    if (stillTypingFor > 0) return schedule(stillTypingFor);
    openFocus();
  }

  return {
    agentEvent(event) {
      if (event.type === 'busy') {
        agentBusy = true;
        userChoseClaude = false;
        if (auto) schedule(delayMs);
        return;
      }
      if (event.type !== 'done' && event.type !== 'needs-input') return;

      const wasBusy = agentBusy;
      agentBusy = false;
      clearTimeout(timer);
      timer = null;
      if (wasBusy && currentView() === 'focus') returnToClaude(event.type);
    },

    userTyped() {
      lastTypedAt = Date.now();
    },

    manualToggle(toView) {
      if (toView !== 'claude') return;
      userChoseClaude = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

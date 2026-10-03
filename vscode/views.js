// The panel's HTML. Kept free of the vscode module so it can be tested with plain node.

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const percent = (correct, answered) => (answered ? Math.round((100 * correct) / answered) + '%' : '–');
const letter = (index) => String.fromCharCode(65 + index);

function questionCard(entry, open = false) {
  const result = entry.chosen === null || entry.chosen === undefined ? ['skipped', 'muted'] : entry.correct === true ? ['right', 'good'] : entry.correct === false ? ['wrong', 'bad'] : ['waiting', 'muted'];
  const options = (entry.options ?? []).map((option, index) => {
    const cls = [index === entry.answer ? 'answer' : '', index === entry.chosen && index !== entry.answer ? 'chosen' : ''].join(' ');
    return `<li class="${cls}"><b>${letter(index)}</b> ${escape(option)}</li>`;
  }).join('');
  const thread = (entry.thread ?? []).map(({ ask, answer }) => `<div class="thread"><b>You asked:</b> ${escape(ask)}<br>${escape(answer)}</div>`).join('');
  return `<details class="q" ${open ? 'open' : ''}>
    <summary><span class="pill ${result[1]}">${result[0]}</span> ${escape(entry.question)}</summary>
    <div class="meta">${escape(entry.kind ?? '')}${entry.file ? ' · ' + escape(entry.file) : ''}${entry.ts ? ' · ' + escape(String(entry.ts).slice(0, 10)) : ''}</div>
    ${entry.code ? `<pre>${escape(entry.code)}</pre>` : ''}
    <ul>${options}</ul>
    ${entry.why ? `<p class="why">${escape(entry.why)}</p>` : ''}
    ${thread}
  </details>`;
}

/** Stats, weak spots, saved and missed questions for one project or all of them. */
function dashboardHtml(data, { scope, project, running = false }) {
  const weak = data.weakSpots.length
    ? data.weakSpots.map((t) => `<div class="bar"><span>${escape(t.tag)}</span><s><i style="width:${Math.round((100 * t.correct) / t.answered)}%"></i></s><em>${t.correct}/${t.answered}</em></div>`).join('')
    : '<p class="muted">Answer a few more questions and your weak spots show up here.</p>';
  const saved = data.saved.length
    ? data.saved.map((entry, index) => questionCard(entry, index === 0)).join('')
    : '<p class="muted">Press <kbd>w</kbd> after answering a question in hyperfocus to save it here.</p>';
  const missed = data.missed.length ? data.missed.map((entry) => questionCard(entry)).join('') : '<p class="muted">Nothing missed lately.</p>';
  return `${running ? '' : '<button data-msg="start">Start hyperfocus in a terminal</button>'}
  <div class="scope">
    <button class="${scope === 'project' ? '' : 'secondary'}" data-scope="project">This project</button>
    <button class="${scope === 'all' ? '' : 'secondary'}" data-scope="all">All projects</button>
  </div>
  <h2>${escape(project)}</h2>
  <div class="stats">
    <div class="stat"><b>${data.answered}</b><span>answered</span></div>
    <div class="stat"><b>${percent(data.last30.correct, data.last30.answered)}</b><span>right, 30 days</span></div>
    <div class="stat"><b>${data.streak}</b><span>day streak</span></div>
  </div>
  <h2>Weak spots</h2>${weak}
  <h2>Saved questions (${data.saved.length})</h2>${saved}
  <button class="secondary" data-msg="notebook">Open the notebook</button>
  <h2>Recently missed</h2>${missed}`;
}

/** The whole panel. Its three parts are later replaced in place by 'live', 'pinned' and 'dashboard' messages. */
function render(data, { scope, project, nonce, live = '', pinned = null, running = false }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 4px 12px 16px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 18px 0 8px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .stat { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 8px; text-align: center; }
  .stat b { display: block; font-size: 18px; color: var(--vscode-textLink-foreground); }
  .stat span { font-size: 11px; opacity: .7; }
  button { width: 100%; margin-top: 10px; padding: 6px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .scope { display: flex; gap: 4px; margin-top: 8px; }
  .scope button { margin: 0; padding: 3px; font-size: 11px; }
  .bar { display: grid; grid-template-columns: 90px 1fr 36px; align-items: center; gap: 6px; margin: 4px 0; font-size: 12px; }
  .bar s { display: block; height: 6px; border-radius: 3px; background: var(--vscode-widget-border, #8884); }
  .bar i { display: block; height: 6px; border-radius: 3px; background: var(--vscode-textLink-foreground); }
  .bar em { font-style: normal; opacity: .7; text-align: right; }
  .q { border-left: 2px solid var(--vscode-widget-border, #8884); padding: 4px 0 4px 8px; margin: 6px 0; }
  .q summary { cursor: pointer; line-height: 1.4; }
  .meta { font-size: 11px; opacity: .6; margin: 4px 0; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  ul { padding-left: 0; list-style: none; margin: 6px 0; }
  li { padding: 2px 4px; border-radius: 3px; }
  li.answer { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3a3) 22%, transparent); }
  li.chosen { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #c33) 22%, transparent); }
  .why { opacity: .85; }
  .thread { font-size: 12px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 6px; margin: 6px 0; }
  .pill { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-right: 4px; }
  .good { background: var(--vscode-testing-iconPassed, #3a3); color: #fff; }
  .bad { background: var(--vscode-testing-iconFailed, #c33); color: #fff; }
  .muted { opacity: .6; }
  .pill.muted { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 1; }
${LIVE_STYLES}</style></head><body>
  <div id="live">${live}</div>
  <div id="pinned">${pinnedHtml(pinned)}</div>
  <div id="dashboard">${dashboardHtml(data, { scope, project, running })}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // The live card is replaced in place, so the rest of the panel keeps its scroll and open sections,
  // and a half-typed follow-up survives the update.
  const live = document.getElementById('live');
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'pinned' || event.data?.type === 'dashboard') {
      // Keep the <details> the user opened open across the update.
      const part = document.getElementById(event.data.type);
      const open = [...part.querySelectorAll('details')].map((details) => details.open);
      part.innerHTML = event.data.html;
      if (event.data.type === 'dashboard') part.querySelectorAll('details').forEach((details, index) => (details.open = open[index] ?? details.open));
      return;
    }
    if (event.data?.type !== 'live') return;
    const input = live.querySelector('.follow-up input');
    const draft = input ? { value: input.value, focused: document.activeElement === input, at: input.selectionStart } : null;
    live.innerHTML = event.data.html;
    const next = live.querySelector('.follow-up input');
    if (draft && next) {
      next.value = draft.value;
      if (draft.focused) {
        next.focus();
        next.setSelectionRange(draft.at, draft.at);
      }
    }
  });
  const cardId = () => Number(live.querySelector('.live-card')?.dataset.id) || undefined;
  const send = (action) => vscode.postMessage({ type: 'act', action: { id: cardId(), ...action } });
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act], [data-open], [data-unpin], [data-msg], [data-scope]');
    if (!target || target.tagName === 'FORM') return;
    event.preventDefault();
    if (target.dataset.msg) return vscode.postMessage({ type: target.dataset.msg });
    if (target.dataset.scope) return vscode.postMessage({ type: 'scope', scope: target.dataset.scope });
    if (target.dataset.open) return vscode.postMessage({ type: 'open', which: target.dataset.open });
    if (target.hasAttribute('data-unpin')) return vscode.postMessage({ type: 'unpin' });
    const type = target.dataset.act;
    if (type === 'answer') return send({ type, chosen: Number(target.dataset.chosen) });
    if (type === 'keepGoing' || type === 'back' || type === 'exit') return vscode.postMessage({ type: 'act', action: { type } });
    send({ type, ...(type === 'rate' ? { rating: 'bad' } : {}) });
  });
  document.body.addEventListener('submit', (event) => {
    event.preventDefault();
    const ask = event.target.querySelector('input')?.value.trim();
    if (ask) send({ type: 'followUp', ask });
  });
  // The terminal's keys work here too while the panel has focus: 1-9 answer, Enter next, s skip, w save.
  document.addEventListener('keydown', (event) => {
    // A focused button or field handles its own keys (Enter on "Save" must save, not skip ahead).
    if (event.target.closest?.('input, textarea, button, a') || event.metaKey || event.ctrlKey || event.altKey) return;
    const has = (selector) => live.querySelector(selector);
    if (/^[1-9]$/.test(event.key) && has('[data-act="answer"][data-chosen="' + (Number(event.key) - 1) + '"]')) send({ type: 'answer', chosen: Number(event.key) - 1 });
    else if (event.key === 'Enter' && has('[data-act="next"]')) send({ type: 'next' });
    else if (event.key === 's' && has('[data-act="skip"]')) send({ type: 'skip' });
    else if (event.key === 'w' && has('[data-act="save"]')) send({ type: 'save' });
    else if (event.key === 'f' && has('.follow-up input')) { event.preventDefault(); has('.follow-up input').focus(); }
    else return;
    event.preventDefault();
  });
</script></body></html>`;
}


const TONES = { busy: 'busy', waiting: 'waiting', finished: 'finished' };

/** The live card: what the agent is doing and the question hyperfocus is asking right now. */
function liveHtml(model) {
  const c = model.controls ?? {};
  const status = `<div class="live-status ${TONES[model.status.tone] ?? ''}"><span class="dot"></span>${escape(model.status.text)}${model.quiet ? ' <span class="muted">· quiet</span>' : ''}</div>`;
  const q = model.question;
  const act = (type, label, cls = 'secondary') => `<button class="${cls}" data-act="${type}">${escape(label)}</button>`;
  const option = (o) =>
    c.answer
      ? `<li><button class="option" data-act="answer" data-chosen="${Number(o.key) - 1}"><kbd>${o.key}</kbd> ${escape(o.text)}</button></li>`
      : `<li class="${o.mark}"><kbd>${o.key}</kbd> ${escape(o.text)}</li>`;
  const followUp = c.followUp
    ? `<form class="follow-up" data-act="followUp"><input name="ask" placeholder="Ask a follow-up…" autocomplete="off" maxlength="500"><button class="secondary" type="submit">Ask</button></form>`
    : '';
  const exit = c.exit ? `<p class="exit"><a href="#" data-act="exit">Back to the agent</a></p>` : '';
  const finishedBar = c.back
    ? `<div class="row">${act('back', model.staged ? 'End review' : 'Back to the agent', '')}${c.keepGoing ? act('keepGoing', 'Keep going') : ''}</div>`
    : '';
  const card = q
    ? `<div class="live-card" data-id="${q.id}">
      <div class="meta">${escape(q.heading)}${q.file ? ` · <a href="#" data-open="question" title="Open in the editor">${escape(q.file)}</a>` : ''}</div>
      <p class="live-q">${escape(q.q)}</p>
      ${q.code ? `<pre data-open="question" title="Open in the editor">${escape(q.code)}</pre>` : ''}
      <ol class="live-options">${q.options.map(option).join('')}</ol>
      ${model.feedback ? `<p class="verdict verdict-${model.feedback.tone}">${escape(model.feedback.verdict)}</p>${model.feedback.why ? `<p class="why">${escape(model.feedback.why)}</p>` : ''}` : ''}
      ${model.thread.map(({ ask, answer }) => `<div class="thread"><b>You asked:</b> ${escape(ask)}<br>${answer === null ? '<span class="muted">Thinking…</span>' : escape(answer)}</div>`).join('')}
      ${followUp}
      ${finishedBar}
      <div class="row">${[c.next ? act('next', 'Next', '') : '', c.skip ? act('skip', 'Skip') : '', c.save ? act('save', 'Save to notebook') : model.feedback?.saved ? '<span class="muted saved">✓ saved</span>' : '', c.rate ? act('rate', 'Bad question', 'secondary quiet') : ''].join('')}</div>
    </div>`
    : `<p class="muted">${model.status.tone === 'busy' ? 'Thinking of a question about this change…' : 'No question up right now.'}</p>${finishedBar}`;
  const footer = [model.queued, model.score].filter(Boolean).map(escape).join(' · ');
  const summary = model.summary ? `<details class="live-summary"><summary>What's happening</summary><p>${escape(model.summary)}</p></details>` : '';
  return `<section class="live"><h2>Live</h2>${status}${card}${footer ? `<p class="meta">${footer}</p>` : ''}${summary}${exit}</section>`;
}

/** A saved question picked in the notebook tree, shown open above the rest. */
function pinnedHtml(entry) {
  if (!entry) return '';
  return `<section class="pinned"><h2>From your notebook <a href="#" data-unpin title="Close">✕</a></h2>${questionCard(entry, true)}${entry.anchor || entry.file ? '<button class="secondary" data-open="pinned">Open the code</button>' : ''}</section>`;
}

/** The live part of the panel for a connection snapshot: nothing when no session is running. */
function liveSection(snapshot, model) {
  if (snapshot.status === 'mismatch') return `<section class="live"><h2>Live</h2><p class="warn">${escape(snapshot.problem)}</p></section>`;
  if (snapshot.status === 'connecting' || (snapshot.status === 'live' && !snapshot.state)) return '<section class="live"><h2>Live</h2><p class="muted">Connecting to hyperfocus…</p></section>';
  if (snapshot.status === 'live') return liveHtml(model);
  return '';
}

const LIVE_STYLES = `
  .live { margin-bottom: 8px; }
  .live-status { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 8px; }
  .live-status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .live-status.busy .dot { background: var(--vscode-testing-iconPassed, #3a3); animation: pulse 1.4s ease-in-out infinite; }
  .live-status.waiting .dot { background: var(--vscode-editorWarning-foreground, #c90); }
  .live-status.finished .dot { background: var(--vscode-textLink-foreground); }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .live-status.busy .dot { animation: none; } }
  .live-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 8px 10px; }
  .live-q { font-weight: 600; margin: 4px 0 6px; line-height: 1.4; }
  .live-options { list-style: none; padding: 0; margin: 6px 0; }
  .live-options li { padding: 4px 6px; border-radius: 4px; margin: 2px 0; }
  .live-options kbd { font-family: var(--vscode-editor-font-family); opacity: .7; margin-right: 4px; }
  .live-options li.answer { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3a3) 22%, transparent); }
  .live-options li.chosen { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #c33) 22%, transparent); }
  .verdict { font-weight: 600; margin: 6px 0 2px; }
  .verdict-good { color: var(--vscode-testing-iconPassed, #3a3); }
  .verdict-bad { color: var(--vscode-testing-iconFailed, #c33); }
  .exit { font-size: 12px; margin: 8px 0 0; }
  .warn { color: var(--vscode-editorWarning-foreground, #c90); }
  .live-summary summary { cursor: pointer; font-size: 12px; opacity: .8; }
  button.option { width: 100%; margin: 0; text-align: left; padding: 5px 6px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, #8884); }
  button.option:hover, button.option:focus-visible { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .row button { width: auto; flex: 1 1 auto; margin: 0; padding: 4px 8px; }
  .row button.quiet { flex: 0 0 auto; opacity: .8; }
  .saved { font-size: 12px; }
  .follow-up { display: flex; gap: 6px; margin-top: 8px; }
  .follow-up input { flex: 1; min-width: 0; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
  .follow-up button { width: auto; margin: 0; padding: 4px 10px; }
  [data-open] { cursor: pointer; }
  a { color: var(--vscode-textLink-foreground); }
  .pinned h2 a { float: right; text-decoration: none; }
`;

module.exports = { escape, render, dashboardHtml, liveHtml, liveSection, pinnedHtml };

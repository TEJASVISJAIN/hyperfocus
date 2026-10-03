// The panel's HTML. Kept free of the vscode module so it can be tested with plain node.
//
// Three states, one at a time:
// - idle: what hyperfocus is, and one button to start it;
// - working: what the agent is doing and the question to answer, nothing else competing;
// - your history (stats, saved, missed) under either, only once there is some.

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const percent = (correct, answered) => (answered ? Math.round((100 * correct) / answered) + '%' : '–');
const KIND_NAMES = { why: 'Why this way', bug: 'Spot the bug', output: 'What does it do', predict: 'Predict' };

/** A past question, folded: the question, then the options, your answer, why and the code. */
function questionCard(entry, { index = null } = {}) {
  const result = entry.chosen === null || entry.chosen === undefined ? ['skipped', 'muted'] : entry.correct === true ? ['right', 'good'] : entry.correct === false ? ['wrong', 'bad'] : ['waiting', 'muted'];
  const options = (entry.options ?? [])
    .map((option, i) => {
      const cls = [i === entry.answer ? 'answer' : '', i === entry.chosen && i !== entry.answer ? 'chosen' : ''].join(' ');
      return `<li class="${cls}">${escape(option)}</li>`;
    })
    .join('');
  const thread = (entry.thread ?? []).map(({ ask, answer }) => `<div class="thread"><b>You asked:</b> ${escape(ask)}<br>${escape(answer)}</div>`).join('');
  const openCode = index !== null && (entry.anchor || entry.file) ? `<a href="#" data-open-saved="${index}">Open the code</a>` : '';
  return `<details class="q">
    <summary><span class="pill ${result[1]}">${result[0]}</span> ${escape(entry.question)}</summary>
    ${entry.code ? `<pre>${escape(entry.code)}</pre>` : ''}
    <ul>${options}</ul>
    ${entry.why ? `<p class="why">${escape(entry.why)}</p>` : ''}
    ${thread}
    <div class="meta">${[entry.file ? escape(entry.file) : '', entry.ts ? escape(String(entry.ts).slice(0, 10)) : '', openCode].filter(Boolean).join(' · ')}</div>
  </details>`;
}

/** The idle state: what this is and how to start. Shown only while no session runs here. */
function introHtml({ startLabel }) {
  return `<section class="intro">
    <h1>Understand the code your agent writes.</h1>
    <p>Start your coding agent through hyperfocus. While it works, a short question about the change it's making shows up here. Answer in a few seconds, then carry on.</p>
    <button data-msg="start">${escape(startLabel)}</button>
    <p class="muted small">Or run <code>hyperfocus</code> in any terminal in this folder. The panel picks it up.</p>
  </section>`;
}

/** Your history, only the parts that have something in them. */
function historyHtml(data) {
  if (!data.answered && !data.saved.length) return '';
  const parts = [];
  if (data.answered) {
    const streak = data.streak ? ` · ${data.streak}-day streak` : '';
    parts.push(`<p class="stats-line"><b>${data.answered}</b> answered · <b>${percent(data.last30.correct, data.last30.answered)}</b> right in the last 30 days${streak}</p>`);
  }
  if (data.weakSpots.length) {
    parts.push(
      '<h3>Worth another look</h3>' +
        data.weakSpots.map((t) => `<div class="bar"><span>${escape(t.tag)}</span><s><i style="width:${Math.round((100 * t.correct) / t.answered)}%"></i></s><em>${t.correct}/${t.answered}</em></div>`).join(''),
    );
  }
  if (data.saved.length) {
    parts.push(`<h3>Saved (${data.saved.length}) <a href="#" data-msg="notebook" class="aside">Open as Markdown</a></h3>` + data.saved.map((entry, index) => questionCard(entry, { index })).join(''));
  }
  if (data.missed.length) parts.push('<h3>Missed lately</h3>' + data.missed.map((entry) => questionCard(entry)).join(''));
  return `<section class="history"><h2>Your progress in ${escape(data.project ?? 'this project')}</h2>${parts.join('')}</section>`;
}

/** Everything below the live card: the intro when nothing runs, then your history. */
function dashboardHtml(data, { running = false, startLabel = 'Start hyperfocus' } = {}) {
  return (running ? '' : introHtml({ startLabel })) + historyHtml(data);
}

const TONES = { busy: 'busy', waiting: 'waiting', finished: 'finished' };

/** The working state: what the agent is doing and the one question to answer. */
function liveHtml(model) {
  const c = model.controls ?? {};
  const q = model.question;
  const status = `<div class="live-status ${TONES[model.status.tone] ?? ''}"><span class="dot"></span><span>${escape(model.status.text)}</span>${model.quiet ? '<span class="muted"> · quiet</span>' : ''}</div>`;
  const button = (type, label, cls = '') => `<button class="${cls}" data-act="${type}">${escape(label)}</button>`;
  const link = (type, label) => `<a href="#" data-act="${type}">${escape(label)}</a>`;

  let body;
  if (!q) {
    body = `<p class="waiting-note">${
      model.status.tone === 'busy' ? 'A question about this change is on its way…' : model.status.tone === 'finished' ? "That's all for this change." : 'No question right now.'
    }</p>`;
  } else {
    const option = (o) =>
      c.answer
        ? `<li><button class="option" data-act="answer" data-chosen="${Number(o.key) - 1}"><kbd>${o.key}</kbd><span>${escape(o.text)}</span></button></li>`
        : `<li class="option done ${o.mark}"><kbd>${o.key}</kbd><span>${escape(o.text)}</span></li>`;
    const feedback = model.feedback
      ? `<div class="feedback ${model.feedback.tone}"><b>${escape(model.feedback.verdict)}</b>${model.feedback.why ? `<p>${escape(model.feedback.why)}</p>` : ''}</div>`
      : '';
    const thread = model.thread
      .map(({ ask, answer }) => `<div class="thread"><b>You asked:</b> ${escape(ask)}<br>${answer === null ? '<span class="muted">Thinking…</span>' : escape(answer)}</div>`)
      .join('');
    const followUp = c.followUp
      ? `<form class="follow-up" data-act="followUp" hidden><input name="ask" placeholder="What would you like to know?" autocomplete="off" maxlength="500"><button type="submit">Ask</button></form>`
      : '';
    let actions = '';
    if (c.back && !model.staged) {
      // The agent finished with this question still up.
      actions = `<div class="banner">${escape(model.status.text)}.</div><div class="row">${button('keepGoing', 'Keep answering')}${button('back', 'Done', 'secondary')}</div>`;
    } else if (model.feedback) {
      actions = `<div class="row">${c.next ? button('next', model.queued ? 'Next question' : 'Done') : ''}${c.save ? button('save', 'Save', 'secondary') : model.feedback.saved ? '<span class="muted saved">Saved ✓</span>' : ''}</div>
        <p class="links">${c.followUp ? '<a href="#" data-toggle="follow-up">Ask a follow-up</a>' : ''}${c.followUp && c.rate ? ' · ' : ''}${c.rate ? link('rate', 'Not a good question') : ''}</p>`;
    } else {
      actions = `<p class="links">${c.skip ? link('skip', 'Skip') : ''}${c.skip && c.rate ? ' · ' : ''}${c.rate ? link('rate', 'Not a good question') : ''}</p>`;
    }
    const kind = KIND_NAMES[q.kind] ?? '';
    body = `<div class="live-card" data-id="${q.id}">
      <div class="meta">${[kind, q.file ? `<a href="#" data-open="question" title="Open in the editor">${escape(q.file)}</a>` : ''].filter(Boolean).join(' · ')}</div>
      <p class="live-q">${escape(q.q)}</p>
      ${q.code ? `<pre data-open="question" title="Click to open in the editor">${escape(q.code)}</pre>` : ''}
      <ol class="live-options">${q.options.map(option).join('')}</ol>
      ${feedback}${thread}${followUp}${actions}
    </div>`;
  }
  const footer = [model.queued && !model.feedback ? model.queued : '', model.score].filter(Boolean).map(escape).join(' · ');
  const staged = model.staged ? `<p class="links">${link('back', 'End review')}</p>` : '';
  const summary = model.summary ? `<details class="about"><summary>About this change</summary><p>${escape(model.summary)}</p></details>` : '';
  return `<section class="live">${status}${body}${footer ? `<p class="meta">${footer}</p>` : ''}${staged}${summary}</section>`;
}

/** The live part of the panel for a connection snapshot: nothing when no session is running. */
function liveSection(snapshot, model) {
  if (snapshot.status === 'mismatch') return `<section class="live"><p class="warn">${escape(snapshot.problem)}</p></section>`;
  if (snapshot.status === 'connecting' || (snapshot.status === 'live' && !snapshot.state)) return '<section class="live"><p class="muted">Connecting to hyperfocus…</p></section>';
  if (snapshot.status === 'live') return liveHtml(model);
  return '';
}

const STYLES = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 14px 20px; line-height: 1.45; }
  h1 { font-size: 15px; font-weight: 600; margin: 6px 0 8px; line-height: 1.3; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 22px 0 8px; font-weight: 600; }
  h3 { font-size: 12px; font-weight: 600; margin: 16px 0 6px; opacity: .9; }
  p { margin: 6px 0; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .aside { float: right; font-weight: normal; font-size: 11px; }
  .muted { opacity: .65; }
  .small { font-size: 11px; }
  code, kbd { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  button { padding: 6px 12px; border: 0; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .intro button { width: 100%; margin: 10px 0 4px; padding: 8px; }
  .stats-line { font-size: 12px; }
  .stats-line b { color: var(--vscode-textLink-foreground); }
  .bar { display: grid; grid-template-columns: 1fr 70px 30px; align-items: center; gap: 6px; margin: 4px 0; font-size: 12px; }
  .bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar s { display: block; height: 5px; border-radius: 3px; background: var(--vscode-widget-border, #8884); }
  .bar i { display: block; height: 5px; border-radius: 3px; background: var(--vscode-textLink-foreground); }
  .bar em { font-style: normal; opacity: .7; text-align: right; }
  .q { border-left: 2px solid var(--vscode-widget-border, #8884); padding: 3px 0 3px 8px; margin: 6px 0; }
  .q summary { cursor: pointer; font-size: 12px; }
  .q ul { padding-left: 0; list-style: none; margin: 6px 0; font-size: 12px; }
  .q li { padding: 2px 6px; border-radius: 3px; }
  .meta { font-size: 11px; opacity: .65; margin: 4px 0; }
  .meta a { opacity: 1; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 8px 0; }
  li.answer, .option.answer { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3a3) 22%, transparent); }
  li.chosen, .option.chosen { background: color-mix(in srgb, var(--vscode-testing-iconFailed, #c33) 22%, transparent); }
  .why { opacity: .85; font-size: 12px; }
  .thread { font-size: 12px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 8px; margin: 8px 0; }
  .pill { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-right: 4px; }
  .pill.good { background: var(--vscode-testing-iconPassed, #3a3); color: #fff; }
  .pill.bad { background: var(--vscode-testing-iconFailed, #c33); color: #fff; }
  .pill.muted { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 1; }
  .live-status { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 4px 0 10px; }
  .live-status .dot { flex: 0 0 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .live-status.busy .dot { background: var(--vscode-testing-iconPassed, #3a3); animation: pulse 1.4s ease-in-out infinite; }
  .live-status.waiting .dot { background: var(--vscode-editorWarning-foreground, #c90); }
  .live-status.finished .dot { background: var(--vscode-textLink-foreground); }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .live-status.busy .dot { animation: none; } }
  .waiting-note { opacity: .75; }
  .live-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 10px 12px 12px; }
  .live-q { font-weight: 600; margin: 4px 0 8px; font-size: 13px; }
  .live-options { list-style: none; padding: 0; margin: 8px 0; }
  .live-options li { margin: 4px 0; }
  .option { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; padding: 7px 8px; border-radius: 4px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-widget-border, #8884); box-sizing: border-box; }
  button.option:hover, button.option:focus-visible { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .option kbd { opacity: .55; flex: 0 0 auto; }
  .option.done { border-color: transparent; }
  .feedback { margin: 10px 0 4px; font-size: 12px; }
  .feedback.good b { color: var(--vscode-testing-iconPassed, #3a3); }
  .feedback.bad b { color: var(--vscode-testing-iconFailed, #c33); }
  .feedback p { margin: 4px 0 0; opacity: .9; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .row button { flex: 1 1 auto; }
  .saved { font-size: 12px; flex: 1 1 auto; text-align: center; }
  .links { font-size: 11px; margin: 8px 0 0; opacity: .85; }
  .banner { margin-top: 10px; font-size: 12px; font-weight: 600; }
  .follow-up { display: flex; gap: 6px; margin-top: 8px; }
  .follow-up[hidden] { display: none; }
  .follow-up input { flex: 1; min-width: 0; padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
  [data-open] { cursor: pointer; }
  .about summary { cursor: pointer; font-size: 11px; opacity: .7; margin-top: 8px; }
  .about p { font-size: 12px; opacity: .85; }
  .warn { color: var(--vscode-editorWarning-foreground, #c90); }
`;

// The webview's script. Parts are replaced in place by message, so scroll position, open sections
// and a half-typed follow-up survive updates; the terminal's keys work while the panel has focus.
const SCRIPT = `
  const vscode = acquireVsCodeApi();
  const live = document.getElementById('live');
  let followUpFor = null; // the question whose follow-up box the user opened
  const cardId = () => Number(live.querySelector('.live-card')?.dataset.id) || undefined;
  const showFollowUp = (focus) => {
    const form = live.querySelector('.follow-up');
    if (!form) return;
    form.hidden = false;
    followUpFor = cardId();
    if (focus) form.querySelector('input').focus();
  };
  window.addEventListener('message', (event) => {
    const { type, html } = event.data || {};
    if (type === 'dashboard') {
      const part = document.getElementById('dashboard');
      const open = [...part.querySelectorAll('details')].map((d) => d.open);
      part.innerHTML = html;
      part.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? d.open));
      return;
    }
    if (type !== 'live') return;
    const input = live.querySelector('.follow-up input');
    const draft = input ? { value: input.value, focused: document.activeElement === input, at: input.selectionStart } : null;
    const about = live.querySelector('.about')?.open;
    live.innerHTML = html;
    if (about) live.querySelector('.about')?.setAttribute('open', '');
    if (followUpFor !== null && followUpFor === cardId()) showFollowUp(false);
    else followUpFor = null;
    const next = live.querySelector('.follow-up input');
    if (draft && next) {
      next.value = draft.value;
      if (draft.focused) { next.focus(); next.setSelectionRange(draft.at, draft.at); }
    }
  });
  const send = (action) => vscode.postMessage({ type: 'act', action: { id: cardId(), ...action } });
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act], [data-open], [data-open-saved], [data-msg], [data-toggle]');
    if (!target || target.tagName === 'FORM') return;
    event.preventDefault();
    if (target.dataset.toggle) return showFollowUp(true);
    if (target.dataset.msg) return vscode.postMessage({ type: target.dataset.msg });
    if (target.dataset.open) return vscode.postMessage({ type: 'open' });
    if (target.dataset.openSaved) return vscode.postMessage({ type: 'openSaved', index: Number(target.dataset.openSaved) });
    const type = target.dataset.act;
    if (type === 'answer') return send({ type, chosen: Number(target.dataset.chosen) });
    if (type === 'keepGoing' || type === 'back') return vscode.postMessage({ type: 'act', action: { type } });
    send({ type, ...(type === 'rate' ? { rating: 'bad' } : {}) });
  });
  document.body.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.target.querySelector('input');
    const ask = input?.value.trim();
    if (ask) { send({ type: 'followUp', ask }); input.value = ''; }
  });
  // 1-9 answer, Enter next, s skip, w save, f follow-up: the same keys as the terminal.
  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea, button, a') || event.metaKey || event.ctrlKey || event.altKey) return;
    const has = (selector) => live.querySelector(selector);
    if (/^[1-9]$/.test(event.key) && has('[data-act="answer"][data-chosen="' + (Number(event.key) - 1) + '"]')) send({ type: 'answer', chosen: Number(event.key) - 1 });
    else if (event.key === 'Enter' && has('[data-act="next"]')) send({ type: 'next' });
    else if (event.key === 's' && has('[data-act="skip"]')) send({ type: 'skip' });
    else if (event.key === 'w' && has('[data-act="save"]')) send({ type: 'save' });
    else if (event.key === 'f' && has('.follow-up')) showFollowUp(true);
    else return;
    event.preventDefault();
  });
`;

/** The whole panel. The live card and the dashboard are later replaced in place by message. */
function render(data, { nonce, live = '', running = false, startLabel = 'Start hyperfocus' }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLES}</style></head><body>
  <div id="live">${live}</div>
  <div id="dashboard">${dashboardHtml(data, { running, startLabel })}</div>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

module.exports = { escape, render, dashboardHtml, liveHtml, liveSection };

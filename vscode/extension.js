const vscode = require('vscode');
const { existsSync, mkdirSync, watch, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { dataDir, summarize } = require('./data');

/** The hyperfocus sidebar: stats, weak spots and saved questions, refreshed when hyperfocus writes. */
class Panel {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.scope = 'project';
  }

  home() {
    return dataDir(vscode.workspace.getConfiguration('hyperfocus').get('home'));
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'start') vscode.commands.executeCommand('hyperfocus.start');
      if (message.type === 'notebook') vscode.commands.executeCommand('hyperfocus.openNotebook');
      if (message.type === 'scope') {
        this.scope = message.scope;
        this.refresh();
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.refresh());
    this.refresh();
  }

  refresh() {
    if (!this.view) return;
    const cwd = this.scope === 'project' ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null : null;
    const data = summarize({ home: this.home(), cwd });
    this.view.webview.html = render(data, { scope: this.scope, project: cwd ? cwd.split(/[\\/]/).pop() : 'all projects', nonce: String(Date.now()) });
  }
}

function activate(context) {
  const panel = new Panel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hyperfocus.panel', panel),
    vscode.commands.registerCommand('hyperfocus.refresh', () => panel.refresh()),
    vscode.commands.registerCommand('hyperfocus.start', () => {
      const terminal = vscode.window.createTerminal({ name: 'hyperfocus', cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
      terminal.show();
      terminal.sendText(vscode.workspace.getConfiguration('hyperfocus').get('command') || 'npx @ddalus/hyperfocus');
    }),
    vscode.commands.registerCommand('hyperfocus.openNotebook', async () => {
      const path = join(panel.home(), 'saved.md');
      if (!existsSync(path)) {
        mkdirSync(panel.home(), { recursive: true });
        writeFileSync(path, '# hyperfocus notebook\n\nNothing saved yet. Press `w` after answering a question to keep it here.\n');
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path));
    }),
  );

  // hyperfocus appends to these files as you answer; the panel follows along.
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => panel.refresh(), 300);
  };
  try {
    mkdirSync(panel.home(), { recursive: true });
    const watcher = watch(panel.home(), (_, file) => (file === 'history.jsonl' || file === 'saved.jsonl') && later());
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // No live updates; the refresh button still works.
  }
}

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
    <div class="meta">${escape(entry.kind ?? '')}${entry.file ? ' · ' + escape(entry.file) : ''}${entry.ts ? ' · ' + escape(entry.ts.slice(0, 10)) : ''}</div>
    ${entry.code ? `<pre>${escape(entry.code)}</pre>` : ''}
    <ul>${options}</ul>
    ${entry.why ? `<p class="why">${escape(entry.why)}</p>` : ''}
    ${thread}
  </details>`;
}

function render(data, { scope, project, nonce }) {
  const weak = data.weakSpots.length
    ? data.weakSpots.map((t) => `<div class="bar"><span>${escape(t.tag)}</span><s><i style="width:${Math.round((100 * t.correct) / t.answered)}%"></i></s><em>${t.correct}/${t.answered}</em></div>`).join('')
    : '<p class="muted">Answer a few more questions and your weak spots show up here.</p>';
  const saved = data.saved.length
    ? data.saved.map((entry, index) => questionCard(entry, index === 0)).join('')
    : '<p class="muted">Press <kbd>w</kbd> after answering a question in hyperfocus to save it here.</p>';
  const missed = data.missed.length ? data.missed.map((entry) => questionCard(entry)).join('') : '<p class="muted">Nothing missed lately.</p>';
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
</style></head><body>
  <button id="start">Start hyperfocus in a terminal</button>
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
  <button class="secondary" id="notebook">Open the notebook</button>
  <h2>Recently missed</h2>${missed}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('start').onclick = () => vscode.postMessage({ type: 'start' });
  document.getElementById('notebook').onclick = () => vscode.postMessage({ type: 'notebook' });
  for (const b of document.querySelectorAll('[data-scope]')) b.onclick = () => vscode.postMessage({ type: 'scope', scope: b.dataset.scope });
</script></body></html>`;
}

function deactivate() {}

module.exports = { activate, deactivate, render };

const vscode = require('vscode');
const { existsSync, mkdirSync, watch, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { dataDir, summarize } = require('./data');
const { render, liveSection } = require('./views');
const { LiveConnection } = require('./live');
const { agentName, liveModel } = require('./panel-state');

/**
 * The hyperfocus sidebar: the live question while a session runs in this folder, then stats, weak
 * spots and saved questions, refreshed when hyperfocus writes.
 */
class Panel {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.scope = 'project';
    this.live = null;
    this.lastLive = '';
  }

  liveHtml() {
    if (!this.live) return '';
    const snapshot = this.live.snapshot();
    const model = snapshot.state ? liveModel(snapshot.state, { agentName: agentName(snapshot.session?.agent) }) : null;
    return liveSection(snapshot, model);
  }

  // Only the live card changes, so the rest of the panel keeps its scroll position.
  updateLive() {
    if (!this.view) return;
    const html = this.liveHtml();
    if (html === this.lastLive) return;
    this.lastLive = html;
    this.view.webview.postMessage({ type: 'live', html });
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
    this.lastLive = this.liveHtml();
    this.view.webview.html = render(data, { scope: this.scope, project: cwd ? cwd.split(/[\\/]/).pop() : 'all projects', nonce: String(Date.now()), live: this.lastLive });
  }
}

function activate(context) {
  const panel = new Panel(context);
  // Follows the hyperfocus session running in this window's folder, wherever its terminal is.
  const live = new LiveConnection({
    sessionsDir: join(panel.home(), 'sessions'),
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });
  panel.live = live;
  let wasRunning = false;
  live.on('change', (snapshot) => {
    // A session starting or ending changes the stats too, not just the live card.
    const running = snapshot.status !== 'none';
    if (running !== wasRunning) {
      wasRunning = running;
      panel.refresh();
    } else panel.updateLive();
  });
  live.start();
  context.subscriptions.push({ dispose: () => live.dispose() });
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

function deactivate() {}

module.exports = { activate, deactivate };

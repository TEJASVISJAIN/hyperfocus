const vscode = require('vscode');
const { execFile, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, watch, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const { dataDir, readJsonLines, summarize } = require('./data');
const { render, dashboardHtml, liveSection } = require('./views');
const { LiveConnection } = require('./live');
const { agentName, anchorRange, finishedNow, findOnPath, gutterMarks, liveModel, resolveInside, startCommand, statusBarText } = require('./panel-state');

const DEFAULT_COMMAND = 'npx @ddalus/hyperfocus';
const AGENTS = [
  { id: 'claude', label: 'Claude Code', binary: 'claude' },
  { id: 'codex', label: 'Codex CLI', binary: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', binary: 'gemini' },
];

const settings = () => vscode.workspace.getConfiguration('hyperfocus');
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

/**
 * The hyperfocus sidebar. Idle: what hyperfocus is and a start button. While a session runs here:
 * the question to answer. Under either, your history once there is some.
 */
class Panel {
  constructor({ home, live, openCode }) {
    Object.assign(this, { home, live, openCode });
    this.view = null;
    this.sent = { live: '', dashboard: '' };
  }

  liveHtml() {
    const snapshot = this.live.snapshot();
    const model = snapshot.state ? liveModel(snapshot.state, { agent: snapshot.session?.agent, lines: this.linesFor(snapshot) }) : null;
    return liveSection(snapshot, model);
  }

  // Where the current question's code is in its file now, worked out once per question.
  linesFor({ session, state }) {
    const question = state?.question;
    if (!question?.anchor || !session) return null;
    if (this.lines?.id === question.id && this.lines.pid === session.pid) return this.lines.range;
    let range = null;
    const path = resolveInside(session.cwd, question.anchor.file);
    try {
      if (path) range = anchorRange(question.anchor, readFileSync(path, 'utf8'));
    } catch {
      // The file is gone or unreadable: the card names the file without lines.
    }
    this.lines = { id: question.id, pid: session.pid, range };
    return range;
  }

  dashboard() {
    const cwd = workspaceRoot();
    const data = { ...summarize({ home: this.home(), cwd }), project: cwd ? cwd.split(/[\\/]/).pop() : 'all projects' };
    const agent = AGENTS.find((candidate) => candidate.id === pickAgent()) ?? AGENTS[0];
    return { data, options: { running: this.live.snapshot().status !== 'none', startLabel: `Start ${agent.label} with hyperfocus` } };
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    // While the panel is on screen the session asks its questions here, not in the terminal.
    this.live.setWatching(view.visible);
    view.onDidChangeVisibility(() => {
      this.live.setWatching(view.visible);
      if (view.visible) this.refresh();
    });
    view.onDidDispose(() => {
      this.live.setWatching(false);
      this.view = null;
    });
    this.refresh();
  }

  receive(message) {
    switch (message?.type) {
      case 'start':
        return vscode.commands.executeCommand('hyperfocus.start');
      case 'notebook':
        return vscode.commands.executeCommand('hyperfocus.openNotebook');
      case 'act':
        if (message.action && typeof message.action.type === 'string' && !this.live.send(message.action)) {
          vscode.window.showWarningMessage('hyperfocus is no longer running in this folder.');
        }
        return;
      case 'open': {
        const { session, state } = this.live.snapshot();
        const question = state?.question;
        if (question && session) return this.openCode({ cwd: session.cwd, anchor: question.anchor, file: question.file });
        return;
      }
      case 'openSaved': {
        const entry = this.dashboard().data.saved[message.index];
        if (entry) return this.openCode({ cwd: entry.cwd, anchor: entry.anchor, file: entry.file });
      }
    }
  }

  /** Re-renders the whole panel; used when it is first shown or comes back into view. */
  refresh() {
    if (!this.view) return;
    const { data, options } = this.dashboard();
    this.sent = { live: this.liveHtml(), dashboard: dashboardHtml(data, options) };
    this.view.webview.html = render(data, { ...options, nonce: randomBytes(16).toString('base64'), live: this.sent.live });
  }

  /** Replaces one part in place, so the other keeps its scroll, open sections and typed text. */
  update(part) {
    if (!this.view) return;
    let html;
    if (part === 'live') html = this.liveHtml();
    else {
      const { data, options } = this.dashboard();
      html = dashboardHtml(data, options);
    }
    if (html === this.sent[part]) return;
    this.sent[part] = html;
    this.view.webview.postMessage({ type: part, html });
  }
}

/** Opens the code a question is about and highlights it; says so when it is no longer there. */
function codeOpener() {
  const highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  let clear = null;
  const open = async ({ cwd, anchor, file }) => {
    const relativePath = anchor?.file ?? file;
    const path = resolveInside(cwd ?? workspaceRoot(), relativePath);
    if (!path) return;
    let document;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    } catch {
      return vscode.window.showInformationMessage(`hyperfocus: ${relativePath} is not there any more.`);
    }
    const range = anchorRange(anchor, document.getText());
    const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.One });
    if (!range) {
      if (anchor) vscode.window.showInformationMessage('hyperfocus: that change is no longer in the file.');
      return;
    }
    const lines = new vscode.Range(range.start, 0, range.end, document.lineAt(range.end).text.length);
    editor.selection = new vscode.Selection(lines.start, lines.start);
    editor.revealRange(lines, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(highlight, [lines]);
    clearTimeout(clear);
    clear = setTimeout(() => editor.setDecorations(highlight, []), 3000);
  };
  return { open, dispose: () => highlight.dispose() };
}

/** Green and red marks beside lines you were quizzed on, with the question on hover. */
function gutter(context, home) {
  const types = {
    true: vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('media/mark-right.svg'),
      gutterIconSize: '70%',
      overviewRulerColor: new vscode.ThemeColor('testing.iconPassed'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    false: vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('media/mark-wrong.svg'),
      gutterIconSize: '70%',
      overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  };
  let history = null;
  const paint = (editor) => {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const on = settings().get('gutterMarks') !== false;
    if (!on || !folder || editor.document.uri.scheme !== 'file') {
      editor.setDecorations(types.true, []);
      editor.setDecorations(types.false, []);
      return;
    }
    history ??= readJsonLines(join(home(), 'history.jsonl'));
    const file = relative(folder.uri.fsPath, editor.document.uri.fsPath).split('\\').join('/');
    const marks = gutterMarks(history, { cwd: folder.uri.fsPath, file, text: editor.document.getText() });
    for (const correct of [true, false]) {
      editor.setDecorations(
        types[correct],
        marks.filter((mark) => mark.correct === correct).map((mark) => ({ range: new vscode.Range(mark.line, 0, mark.line, 0), hoverMessage: new vscode.MarkdownString(mark.hover) })),
      );
    }
  };
  const paintAll = () => vscode.window.visibleTextEditors.forEach(paint);
  let timer = null;
  const later = (fn) => {
    clearTimeout(timer);
    timer = setTimeout(fn, 400);
  };
  context.subscriptions.push(
    types.true,
    types.false,
    vscode.window.onDidChangeVisibleTextEditors(paintAll),
    vscode.workspace.onDidChangeTextDocument((event) => later(() => vscode.window.visibleTextEditors.filter((editor) => editor.document === event.document).forEach(paint))),
    vscode.workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('hyperfocus.gutterMarks') && paintAll()),
  );
  paintAll();
  return {
    historyChanged() {
      history = null;
      paintAll();
    },
  };
}

/** The agent to run: the one set in settings, else the first installed of Claude, Codex, Gemini. */
function pickAgent() {
  const configured = settings().get('agent');
  if (configured) return configured;
  return AGENTS.find((agent) => findOnPath(agent.binary))?.id ?? null;
}

const hyperfocusCommand = (agent, extra = '') =>
  startCommand({ configured: settings().get('command'), defaultCommand: DEFAULT_COMMAND, hyperfocusOnPath: Boolean(findOnPath('hyperfocus')), agent, extra });

function activate(context) {
  const home = () => dataDir(settings().get('home'));
  const opener = codeOpener();
  // Follows the hyperfocus session running in this window's folder, wherever its terminal is.
  const live = new LiveConnection({
    sessionsDir: join(home(), 'sessions'),
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });
  const panel = new Panel({ home, live, openCode: opener.open });
  const marks = gutter(context, home);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'hyperfocus.statusClick';
  status.text = statusBarText(null);
  status.tooltip = 'hyperfocus: start a session';
  status.show();

  let previous = null;
  let wasRunning = false;
  live.on('change', (snapshot) => {
    const running = snapshot.status !== 'none';
    const staged = snapshot.session?.agent === 'staged';
    status.text = statusBarText(snapshot.state);
    status.tooltip = running ? `hyperfocus: ${staged ? 'reviewing your staged change' : agentName(snapshot.session?.agent) + ' session'} — open the panel` : 'hyperfocus: start a session';
    if (running) vscode.commands.executeCommand('setContext', 'hyperfocus.sessionSeen', true);
    if (settings().get('notifications') !== false && finishedNow(previous, snapshot.state, { staged })) {
      vscode.window.showInformationMessage(`${agentName(snapshot.session?.agent)} finished.`, 'Review').then((choice) => choice && focusPanel());
    }
    previous = snapshot.state;
    panel.update('live');
    // A session starting or ending shows or hides the start button.
    if (running !== wasRunning) {
      wasRunning = running;
      panel.update('dashboard');
    }
  });
  live.start();

  const focusPanel = () => vscode.commands.executeCommand('hyperfocus.panel.focus');
  let staged = null; // the --staged review this window started

  const setContexts = () => {
    vscode.commands.executeCommand('setContext', 'hyperfocus.cliFound', Boolean(findOnPath('hyperfocus') || findOnPath('npx')));
    vscode.commands.executeCommand('setContext', 'hyperfocus.answered', summarize({ home: home(), cwd: null }).answered > 0);
  };
  setContexts();

  context.subscriptions.push(
    { dispose: () => live.dispose() },
    opener,
    status,
    vscode.window.registerWebviewViewProvider('hyperfocus.panel', panel),
    vscode.commands.registerCommand('hyperfocus.refresh', () => {
      panel.refresh();
      marks.historyChanged();
    }),
    vscode.commands.registerCommand('hyperfocus.start', async () => {
      const agent = pickAgent();
      if (!agent) {
        const choice = await vscode.window.showWarningMessage('hyperfocus runs alongside a coding agent, and none is installed: Claude Code, Codex CLI or Gemini CLI.', 'Get Claude Code');
        if (choice) vscode.env.openExternal(vscode.Uri.parse('https://claude.com/claude-code'));
        return;
      }
      const terminal = vscode.window.createTerminal({ name: 'hyperfocus', cwd: workspaceRoot() ?? undefined });
      terminal.show();
      terminal.sendText(hyperfocusCommand(agent));
      await focusPanel();
    }),
    vscode.commands.registerCommand('hyperfocus.statusClick', () => (live.snapshot().status === 'none' ? vscode.commands.executeCommand('hyperfocus.start') : focusPanel())),
    vscode.commands.registerCommand('hyperfocus.openNotebook', async () => {
      const path = join(home(), 'saved.md');
      if (!existsSync(path)) {
        mkdirSync(home(), { recursive: true });
        writeFileSync(path, '# hyperfocus notebook\n\nNothing saved yet. Press `w` after answering a question to keep it here.\n');
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path));
    }),
    vscode.commands.registerCommand('hyperfocus.reviewStaged', async () => {
      const cwd = workspaceRoot();
      if (!cwd) return vscode.window.showInformationMessage('hyperfocus: open a folder first.');
      if (staged) return focusPanel();
      // `git diff --cached --quiet` exits 0 when nothing is staged.
      const nothingStaged = await new Promise((resolve) => execFile('git', ['diff', '--cached', '--quiet'], { cwd }, (error) => resolve(!error)));
      if (nothingStaged) return vscode.window.showInformationMessage('hyperfocus: nothing is staged. Stage a change, then review it before committing.');
      const agent = pickAgent() ?? 'claude';
      let output = '';
      const child = spawn(hyperfocusCommand(agent, '--staged'), { cwd, shell: true, env: process.env });
      staged = child;
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', () => {});
      child.on('exit', (code) => {
        if (staged === child) staged = null;
        const last = output.trim().split('\n').at(-1) ?? '';
        if (code && !child.killed) vscode.window.showWarningMessage(`hyperfocus: ${last || 'the review could not start.'}`);
        else if (last.startsWith('Reviewed')) vscode.window.setStatusBarMessage(`hyperfocus: ${last}`, 6000);
      });
      await focusPanel();
    }),
    { dispose: () => staged?.kill() },
  );

  // hyperfocus appends to these files as you answer; the panel and the gutter follow along.
  let timer = null;
  const changed = new Set();
  const later = (file) => {
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (changed.has('history.jsonl')) {
        marks.historyChanged();
        setContexts();
      }
      panel.update('dashboard');
      changed.clear();
    }, 300);
  };
  try {
    mkdirSync(home(), { recursive: true });
    const watcher = watch(home(), (_, file) => (file === 'history.jsonl' || file === 'saved.jsonl') && later(file));
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // No live updates; the refresh button still works.
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

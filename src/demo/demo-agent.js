#!/usr/bin/env node
// Stands in for `claude` in `hyperfocus --demo`: a scripted run through the real hyperfocus.
//
// - Interactively, it draws a small agent screen, and when the user presses Enter it replays one
//   change on a timeline: it fires the hook commands hyperfocus registered (from --settings), the
//   way Claude Code would, and really writes the files it "edits" into the demo project folder.
// - With -p, it is the question writer: it reads the prompt and replies with canned questions in
//   the JSON shape `claude -p --output-format json` uses.
//
// HYPERFOCUS_DEMO_SPEED speeds the timeline up (the tests use 10).
import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const speed = Number(process.env.HYPERFOCUS_DEMO_SPEED) || 1;
const at = (ms) => ms / speed;

const PROMPT = 'add retry with backoff to token refresh';

const RETRY_TS = `export async function withRetry(fn, { attempts = 3, backoffMs = 200 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
`;
const AUTH_BEFORE = '  const token = await fetchToken(refreshToken);';
const AUTH_AFTER = '  const token = await withRetry(() => fetchToken(refreshToken));';
const AUTH_TS = `import { fetchToken } from './http.js';
import { withRetry } from './retry.js';

export async function refresh(refreshToken) {
${AUTH_BEFORE}
  return { token, refreshedAt: Date.now() };
}
`;
const JITTER_BEFORE = '      await sleep(backoffMs * 2 ** (attempt - 1));';
const JITTER_AFTER = '      await sleep(backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random()));';

const QUESTIONS = [
  {
    kind: 'why',
    q: 'Why does withRetry rethrow the error on the last attempt instead of returning null?',
    options: [
      'So callers still see the real failure and can handle it',
      'Returning null would end the for loop early',
      'Rethrowing makes the backoff shorter',
      'A catch block has to throw something',
    ],
    answer: 0,
    why: 'Swallowing the error would turn "the token server is down" into a confusing null further along.',
    file: 'src/retry.ts',
    tags: ['error-handling'],
  },
  {
    kind: 'bug',
    q: 'A thousand clients hit a failing token server at the same moment. What does this backoff miss?',
    code: '      await sleep(backoffMs * 2 ** (attempt - 1));',
    options: ['Jitter: every client retries in lockstep', 'A maximum number of attempts', 'Awaiting the sleep', 'Catching the error'],
    answer: 0,
    why: 'Without randomness, all clients wait exactly as long and retry together, hitting the server in waves.',
    file: 'src/retry.ts',
    tags: ['concurrency', 'edge-cases'],
  },
  {
    kind: 'predict',
    q: 'Which file will the agent edit next?',
    options: ['src/auth.ts', 'src/http.ts', 'README.md'],
    why: '',
  },
  {
    kind: 'output',
    q: 'With attempts = 3 and backoffMs = 200, how long does withRetry wait in total before it gives up?',
    code: '      if (attempt >= attempts) throw error;\n      await sleep(backoffMs * 2 ** (attempt - 1));',
    options: ['200ms', '600ms: 200, then 400', '1,400ms: 200, 400, then 800', 'It retries forever'],
    answer: 1,
    why: 'It sleeps after the first and second failures only; the third failure is rethrown straight away.',
    file: 'src/retry.ts',
    tags: ['edge-cases'],
  },
  {
    kind: 'why',
    q: 'Why wrap fetchToken in withRetry at the call site instead of inside fetchToken?',
    options: [
      'Other callers of fetchToken keep failing fast',
      'fetchToken cannot be async',
      'It makes the tests run faster',
      'withRetry only accepts arrow functions',
    ],
    answer: 0,
    why: 'Retrying is a choice of this caller; code that needs a quick answer can still call fetchToken directly.',
    file: 'src/auth.ts',
    tags: ['api-design'],
  },
];

if (args.includes('-p')) writeQuestions();
else if (args.includes('--version')) process.stdout.write('demo agent (stands in for Claude Code)\n');
else startAgent();

function writeQuestions() {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (prompt += chunk));
  process.stdin.on('end', () => {
    const system = args[args.indexOf('--system-prompt') + 1] ?? '';
    let result;
    if (/follow-up/.test(system)) {
      result =
        'withRetry gives up after the last attempt and rethrows, so refresh() in src/auth.ts still sees the real error. ' +
        'The wait doubles each time (200ms, then 400ms), which spreads one client out, but not many clients: that is what jitter adds.';
    } else {
      const fresh = QUESTIONS.filter((question) => !prompt.includes(question.q));
      const fits = fresh.filter((question) => !question.file || prompt.includes(`### ${question.file}`) || prompt.includes(`/${question.file}`));
      const summary = prompt.includes('withRetry(() => fetchToken')
        ? 'refresh() now calls fetchToken through withRetry: up to 3 attempts with exponential backoff.'
        : 'Adding withRetry(fn): up to 3 attempts, doubling the wait each time, then rethrowing the last error.';
      result = JSON.stringify({ summary, questions: fits.slice(0, 3) });
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result }));
    }, at(1500));
  });
}

function startAgent() {
  const settingsJson = args[args.indexOf('--settings') + 1];
  const hooks = settingsJson ? JSON.parse(settingsJson).hooks : {};
  const cwd = process.cwd();
  const log = [];
  let typed = '';
  let state = 'ready'; // 'ready' | 'running' | 'done'

  const { stdout } = process;
  const width = () => Math.min(stdout.columns || 80, 100);

  function draw() {
    const rule = '─'.repeat(width());
    const rows = stdout.rows || 24;
    const header = [
      '\x1b[1m✻ hyperfocus demo agent\x1b[0m \x1b[2m· stands in for Claude Code · nothing leaves this machine\x1b[0m',
      '',
    ];
    const hint =
      state === 'ready'
        ? `\x1b[2mPress Enter to ask: "${PROMPT}"\x1b[0m`
        : state === 'running'
          ? '\x1b[2mWorking… hyperfocus switches to a quiz in a few seconds. Ctrl-] toggles.\x1b[0m'
          : '\x1b[2mDone. Ctrl-C to leave the demo.\x1b[0m';
    const room = Math.max(1, rows - header.length - 4);
    const body = log.slice(-room);
    const input = state === 'ready' ? `> ${typed || '\x1b[2m' + PROMPT + '\x1b[0m'}` : '> ';
    const screen = [...header, ...body, ...Array(Math.max(0, room - body.length)).fill(''), rule, input, rule, hint];
    stdout.write('\x1b[H\x1b[2J' + screen.join('\r\n'));
  }

  function say(line) {
    log.push(line);
    draw();
  }

  function hook(event, payload) {
    const command = hooks[event]?.[0]?.hooks?.[0]?.command;
    if (!command) return;
    const child = exec(command, () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'demo-session', cwd, ...payload }));
  }

  const file = (path) => join(cwd, path);
  function write(path, content) {
    mkdirSync(dirname(file(path)), { recursive: true });
    writeFileSync(file(path), content);
  }

  const tool = (name, input, response = {}) => hook('PostToolUse', { tool_name: name, tool_input: input, tool_response: response });
  const task = (id, status) => tool('TaskUpdate', { taskId: id, status });

  function run() {
    state = 'running';
    /** @type {[number, () => void][]} */
    const steps = [
      [0, () => {
        say(`\x1b[1m> ${PROMPT}\x1b[0m`);
        say('');
        hook('UserPromptSubmit', { prompt: PROMPT });
      }],
      [800, () => {
        say('⏺ Read(src/auth.ts)');
        hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file('src/auth.ts') } });
      }],
      [1600, () => {
        say('⏺ Read(src/http.ts)');
        hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file('src/http.ts') } });
      }],
      [2500, () => {
        say('⏺ Plan: 1. Add a withRetry helper  2. Use it in refresh()  3. Add jitter');
        const subjects = [['Add a withRetry helper', 'Adding withRetry'], ['Use it in refresh()', 'Wiring retry into refresh'], ['Add jitter to the backoff', 'Adding jitter']];
        subjects.forEach(([subject, activeForm], index) => tool('TaskCreate', { subject, description: subject, activeForm }, { task: { id: String(index + 1), subject } }));
      }],
      [3500, () => task('1', 'in_progress')],
      [5000, () => {
        write('src/retry.ts', RETRY_TS);
        say('⏺ Write(src/retry.ts)  \x1b[32m+12\x1b[0m');
        tool('Write', { file_path: file('src/retry.ts'), content: RETRY_TS });
      }],
      [9000, () => {
        task('1', 'completed');
        task('2', 'in_progress');
      }],
      [16_000, () => {
        write('src/auth.ts', AUTH_TS.replace(AUTH_BEFORE, AUTH_AFTER));
        say('⏺ Update(src/auth.ts)  \x1b[32m+1\x1b[0m \x1b[31m-1\x1b[0m');
        tool('Edit', { file_path: file('src/auth.ts'), old_string: AUTH_BEFORE, new_string: AUTH_AFTER });
      }],
      [20_000, () => {
        task('2', 'completed');
        task('3', 'in_progress');
        say('⏺ Bash(npm test)');
        tool('Bash', { command: 'npm test' });
        say('  ⎿ 12 tests passed');
      }],
      [30_000, () => {
        write('src/retry.ts', RETRY_TS.replace(JITTER_BEFORE, JITTER_AFTER));
        say('⏺ Update(src/retry.ts)  \x1b[32m+1\x1b[0m \x1b[31m-1\x1b[0m');
        tool('Edit', { file_path: file('src/retry.ts'), old_string: JITTER_BEFORE, new_string: JITTER_AFTER });
      }],
      [36_000, () => task('3', 'completed')],
      [38_000, () => {
        say('');
        say('⏺ Done. refresh() now retries fetchToken up to 3 times, with exponential backoff and jitter.');
        state = 'done';
        draw();
        hook('Stop', {});
      }],
    ];
    for (const [ms, step] of steps) setTimeout(step, at(ms));
  }

  write('src/auth.ts', AUTH_TS);
  write('src/http.ts', 'export async function fetchToken(refreshToken) {\n  const response = await fetch("/token", { method: "POST", body: refreshToken });\n  return (await response.json()).token;\n}\n');

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const key = String(chunk);
    if (key === '\x03') process.exit(0);
    if (state !== 'ready') return;
    if (key === '\r' || key === '\n') return run();
    if (key === '\x7f') typed = typed.slice(0, -1);
    else if (key >= ' ' && !key.startsWith('\x1b')) typed += key;
    draw();
  });
  stdout.on('resize', draw);
  draw();
}

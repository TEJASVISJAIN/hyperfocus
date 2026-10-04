# hyperfocus

[![npm](https://img.shields.io/npm/v/@ddalus/hyperfocus?color=0a7c8c)](https://www.npmjs.com/package/@ddalus/hyperfocus)
[![VS Code](https://img.shields.io/visual-studio-marketplace/v/ddalus.hyperfocus?label=VS%20Code&color=0a7c8c)](https://marketplace.visualstudio.com/items?itemName=ddalus.hyperfocus)
[![CI](https://github.com/TEJASVISJAIN/hyperfocus/actions/workflows/ci.yml/badge.svg)](https://github.com/TEJASVISJAIN/hyperfocus/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-0a7c8c)](LICENSE)

**Your agent writes the code. hyperfocus makes sure you still understand it.**

`hyperfocus` runs your coding agent (Claude Code, or Codex and Gemini CLI, experimental) in your
terminal. While it works, the terminal switches to a short quiz about **the change it is making right
now**: why it's done this way, what could break, which edge cases matter. As soon as the agent
finishes or needs you, the terminal switches back, with a recap of what you missed.

New in 1.0: the first question arrives seconds after your prompt, questions know your project,
missed ones come back on a schedule until they stick, and they can be written by a local model
through Ollama. [Website](https://tejasvisjain.github.io/hyperfocus-web/) ·
[VS Code extension](#vs-code) · [Changelog](CHANGELOG.md)

![hyperfocus --demo: while an agent adds retries to token refresh, the quiz asks about the code it just wrote, then hands back with a recap](https://tejasvisjain.github.io/hyperfocus-web/hyperfocus-demo.gif)

Try it without touching a real project: `hyperfocus --demo` replays a scripted change through the real
quiz. It doesn't need Claude and keeps nothing afterwards.

## Install

You need **Node.js 22 or newer** and **[Claude Code](https://claude.com/claude-code), installed and
logged in**. If you already use `claude`, you're set.

```sh
npm install -g @ddalus/hyperfocus
hyperfocus                  # use it exactly like `claude`
```

There is no separate account, sign-up or API key. hyperfocus runs your own `claude`, both for your
session and for the small model calls that write the questions, so it uses whatever login Claude Code
already has: a Claude subscription, an API key, `apiKeyHelper`, or Bedrock/Vertex. The question calls
count toward your own usage, at about $0.004 per batch.

While hyperfocus is running, Claude Code's status line (under its input box) says so:
`◐ hyperfocus · Ctrl-] for the quiz`, or `2 questions ready · Ctrl-] to answer` once questions are
waiting. Your own status line, if you have one, stays above it.

Every argument is passed through to `claude`: `hyperfocus --continue`, `hyperfocus --model sonnet`,
and so on. When input or output is piped (`echo hi | hyperfocus -p`), hyperfocus steps aside and runs
`claude` directly.

### Where it runs

| | Status |
| --- | --- |
| macOS, Linux | supported, tested in CI on every change |
| Claude Code | supported |
| VS Code | supported ([extension](#vs-code)) |
| Cursor, Windsurf and other Open VSX editors | experimental: the same extension, from Open VSX |
| Windows | experimental: see below |
| Codex CLI, Gemini CLI | experimental: see [Other agents](#other-agents-experimental) |
| Local question writer (Ollama) | supported, see [Keep code on your machine](#keep-code-on-your-machine) |

Experimental means it is built and tested against stand-ins, not yet on real installs by enough people.
Reports are welcome either way.

**Linux:** installing compiles one native dependency (`node-pty`), so you need `python3`, `make` and a
C++ compiler (`sudo apt install build-essential python3` on Debian/Ubuntu). macOS needs nothing extra.


**Windows (experimental):** hyperfocus installs and runs in Windows Terminal with PowerShell. It
finds `claude.exe` or npm's `claude.cmd`, and talks to its hooks over a named pipe. Use the keyboard:
mouse clicks and desktop notifications may not work (the bell does). If the screen looks wrong after
switching back to Claude, please open an issue with your terminal and Claude Code versions. It hasn't
been tested on a real Windows machine yet, only in CI.

## Other agents (experimental)

```sh
hyperfocus codex            # OpenAI Codex CLI; every other argument goes to codex
hyperfocus gemini           # Google Gemini CLI
```

The quiz, recap, notes, review and stats work the same way, and the screen names the agent you're
using. If `claude` is installed, it still writes the questions, because they come out best that way.
Otherwise the agent writes them with its own non-interactive mode (`codex exec`, `gemini -p`), so you
don't need Claude Code. Set `"agent": "codex"` in the config to make a bare `hyperfocus` start Codex.

Your agent's own settings files never change:

- **Codex** reads hooks only from files, so hyperfocus starts it with `CODEX_HOME` pointing at
  `~/.hyperfocus/codex-home`. That folder mirrors your `~/.codex` with symlinks (auth, config and
  sessions stay where they are) and adds a `hooks.json` holding your hooks plus hyperfocus's. Codex asks
  you once to trust the new hook. Files Codex creates there are moved back into `~/.codex` afterwards.
- **Gemini** gets its system settings from `GEMINI_CLI_SYSTEM_SETTINGS_PATH`: a copy of your system
  settings, if you have any, with hyperfocus's hooks added.

These adapters follow the Codex and Gemini hook docs and are tested against stand-ins built from them,
not against the real CLIs yet. Please open an issue if a quiz never appears.
`HYPERFOCUS_CODEX_BIN` and `HYPERFOCUS_GEMINI_BIN` point at non-standard installs.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| `Ctrl-]` | anywhere | switch between Claude and the focus view |
| `Esc` | focus view | back to Claude (while typing a follow-up, it cancels the follow-up instead) |
| `Enter` | while it's thinking of a question | back to Claude |
| `↑`/`↓` (or `j`/`k`) and `Enter` | focus view | choose an option and answer |
| `1`–`4` or click | focus view | answer straight away |
| `s` | focus view | skip the question |
| `w` | after answering | save the question, your answer and the explanation to your notebook |
| `b` | focus view | a bad question: skip it unscored, never review it, and steer future questions away from it |
| `z` `z` | focus view | quiet for the rest of this session: no more automatic quizzes (`Ctrl-]` still opens one) |
| `l` | focus view | show or hide the live view: what Claude is doing right now |
| `f` | after an answer | ask your own follow-up question; Enter to send, Esc to cancel |
| `e` | after a wrong answer | explain the idea behind the question, with your own code as the example |
| `Enter` / `c` | when Claude finishes mid-question | go back to Claude / keep going with the quiz |
| any key | after an answer or on the recap | continue |

Keys you press in the focus view never reach Claude.

## Questions

- **Why:** why the change is done this way, what could break, edge cases, tradeoffs.
- **Spot the bug:** a few real lines from the diff, and what they get wrong or miss.
- **What does it do:** a few real lines from the diff, and what they return for a given input.
- **Predict:** "Which file will Claude edit next?" You lock in a guess, carry on with the quiz, and
  Claude's next edit settles it.

Questions are short: one idea, two lines at most, options of a few words. Each says where it comes
from: a file and lines, or, before the agent has edited anything, the plan for your prompt ("To add
retry to token refresh, …"). Code shown with a question is checked against the diff, so it is always
code Claude really wrote. The options are shuffled, so the right answer's position gives nothing away.
Questions get harder when you keep getting them right and easier when you don't.

- **Missed one?** Press **`e`** for a short lesson on the idea behind it, using your own code as the
  example. Follow-ups (`f`) stay on the question's topic.
- **Spaced repeats.** A question you got wrong comes back a day later, then after three days and a
  week if you get it right, mixed in with new questions (at most one per batch) and only while its code
  is still there. A miss starts it over.

**On time.** The first question can come within seconds of your prompt, before the agent has edited
anything:

- When hyperfocus starts in a project, it writes a short **project brief** in the background (from the
  README, CLAUDE.md or AGENTS.md, build manifests, the folder tree, recent commit subjects and the
  files you have changed) and keeps it until the repository moves on. Every question call includes it.
- Question calls run in an **empty folder**, so they don't load your project's CLAUDE.md or the agent's
  memory: questions are about your code, not the agent's notes.
- The reply is **streamed**: the first question shows while the rest are still being written.
- The next question call is **started early** and waits for its prompt, so the CLI's start-up time is
  paid in the background. If it isn't needed, it is closed without ever calling the model.

The focus view also shows **Claude's plan** (from its task list) as one line under the status bar.
Press **`l`** for the **live view**: a feed of what the agent is reading, editing and running, and a peek
at the last lines of Claude's own screen. It is hidden by default so the question has the screen to
itself; set `"live": true` in the config to always start with it open.

## After a run

- **Worth a look before you merge.** The "while you were away" card lists the questions you got wrong,
  as long as the code they are about is still there.
- **`hyperfocus --notes`** prints the latest session in this project as markdown, ready for a PR
  description: each prompt, what Claude did, the files it changed, and a `- [ ]` checklist of the
  questions you missed whose code is still there.
- **`hyperfocus --review`** asks again the questions you missed in this project. `--review --md` prints
  them as that checklist instead.
- **`hyperfocus --install-hook`** adds a git `pre-push` hook that lists those questions before you push.
  It never blocks a push, and `--uninstall-hook` removes exactly what it added.
- **`hyperfocus --stats`** shows how you are doing: accuracy over all time and the last 30 days, per
  question kind, in this project, the concepts you miss most (every question is tagged, for example
  `concurrency` or `error-handling`), and your streak of days in a row. It also shows **time to first
  question**: the median wait after a prompt, and how many runs had a question before the agent
  finished. It is measured on your machine and never sent anywhere.

All three leave out changes that are no longer in the code. If you had Claude build X, then changed your
mind and had it build Y instead, the questions and notes about X don't come back. Each question and each
run remembers the distinctive lines its change added; if those lines are gone from the file, the change
was reverted or rewritten, so hyperfocus leaves it out.

## When it switches

- **To the focus view:** once the agent has been busy for 8 seconds and there is something to ask about:
  a question already written, its first edit, or a plan of two or more steps. A plan of three or more steps halves the wait. In a
  project whose runs are usually short, it waits for a second edit. After 30 seconds it opens anyway,
  edit or not, with questions about the code the agent is reading. It never switches while you are
  typing. So a quick answer, or a run that only reads code, never interrupts you. The first time, an
  intro card explains the keys (`hyperfocus --intro` shows it again).
- **Back to Claude:** the moment Claude finishes, asks for input (a permission prompt, a question) or
  you interrupt it with Esc. You get a terminal bell and, on macOS, a notification.
  - **In the middle of a question?** It stays on screen with a prompt: `Enter` goes back to Claude, `c`
    (or just answering) keeps going. If you keep going, hyperfocus keeps writing questions about the
    finished change until you go back with `Ctrl-]`.
  - Otherwise, if you were in the focus view for 15 seconds or more, or answered anything, a "while you
    were away" card shows first.
- If you switch back to Claude yourself (`Ctrl-]` or `Esc`), hyperfocus stays out of the way until your
  next prompt.
- **While the VS Code panel is on screen,** the terminal stays on the agent and questions go to the
  panel the moment they exist.

## Options

| Flag / variable | Default | |
| --- | --- | --- |
| `--quiet` (or `--no-auto`) | off | never open the focus view by itself this session; `Ctrl-]` still works |
| `--quiet --here` | | the same, always, in this project (saved in the config file) |
| `--demo` | | a scripted run through the real quiz; no Claude needed, nothing kept |
| `--doctor` | | check Node, Claude Code and its login, the terminal, the config, and one real question call |
| `--intro` | | print the intro card again |
| `--stats` | | print how you are doing, then exit |
| `--saved` | | print the questions you saved in this project (`--all` for every project), then exit |
| `--notes` | | print notes on the latest session in this project, then exit |
| `--review` | | ask again the missed questions whose code is still here (`--md`: print them as a checklist) |
| `--writer ollama` | config | write questions with a local model through Ollama for this run (see below) |
| `--staged` | | questions about your staged change (`git diff --cached`), answered in the VS Code panel; no agent needed |
| `--install-hook` / `--uninstall-hook` | | add or remove the `pre-push` hook that lists them before a push |
| `HYPERFOCUS_DELAY_MS` | `8000` | how long the agent must be busy before the focus view opens (beats the config file) |
| `HYPERFOCUS_DEBUG=1` | off | log hook events and errors to `~/.hyperfocus/debug.log` |
| `HYPERFOCUS_CLAUDE_BIN` | `claude` on `PATH` | the Claude Code executable to run |
| `HYPERFOCUS_HOME` | `~/.hyperfocus` | where history, the run log, the config and the debug log live |

### Config file

`~/.hyperfocus/config.json`; every key is optional:

```json
{
  "delayMs": 8000,
  "model": "haiku",
  "questionsPerBatch": 3,
  "kinds": ["why", "bug", "output", "predict"],
  "notifications": true,
  "mouse": true,
  "live": false,
  "switchOn": "edit",
  "quiet": false,
  "animations": true,
  "writer": "auto",
  "ollamaModel": "qwen2.5-coder:7b",
  "projects": {
    "/Users/you/code/scratch": { "quiet": true }
  }
}
```

- `switchOn`: `"edit"` waits for something to ask about, as described above. `"busy"` switches once the
  agent has been busy for `delayMs`, like hyperfocus 0.2.
- `animations: false` stops the spinner. Colours follow [`NO_COLOR`](https://no-color.org) and `TERM=dumb`.
- `projects` overrides any setting for one project folder.

A bad value is reported when hyperfocus starts, and that setting keeps its default.

The config file, the data files in `~/.hyperfocus` and the VS Code bridge are stable within 1.x:
settings and fields are only ever added. They are described in
[`docs/FORMATS.md`](docs/FORMATS.md).

### Keep code on your machine

```sh
ollama pull qwen2.5-coder:7b
hyperfocus --writer ollama          # or "writer": "ollama" in the config
```

With the Ollama writer, questions, follow-ups, lessons and the project brief are written by a model on
your machine (`OLLAMA_HOST` if it runs elsewhere; `ollamaModel` picks the model). Your agent is
unchanged: it still talks to its own provider. `hyperfocus --doctor` checks that Ollama is running and
the model is pulled. Local models write plainer questions than Haiku, and on a laptop they are slower.


## VS Code

The [hyperfocus extension](https://marketplace.visualstudio.com/items?itemName=ddalus.hyperfocus) puts the quiz in the editor:

```sh
code --install-extension ddalus.hyperfocus
```

- **Answer in the sidebar.** While hyperfocus runs in the window's folder (in VS Code's terminal or
  any other), the panel shows what the agent is doing and the current question. Click an option or
  press `1`–`9`; ask a follow-up, save it, or rate it bad, just like the keys in the terminal. Both
  stay in step.
- **Jump to the code.** Click the question's file to open it at the lines the question is about.
- **Gutter marks.** Lines you were quizzed on get a green or red dot; hover for the question.
- **Your progress** (accuracy, saved and missed questions) folds away while a question is up.
- **Review staged changes.** A button in the Source Control view quizzes you on your own staged diff
  before you commit (`hyperfocus --staged`), with no agent running.
- **Status bar and a notification** when the agent finishes.

The extension follows a session through `~/.hyperfocus/sessions/` and a local socket only your user
can open; it never calls a model itself. The live view needs hyperfocus 0.7.0 or later; lessons,
repeats and plan sources need 1.0.0.

In Cursor, Windsurf and other editors that use Open VSX, install `ddalus.hyperfocus` from there
(experimental).

## How it works

- **Hooks, without touching your settings.** hyperfocus starts Claude with
  `claude --settings '{"hooks": …}'`. Claude Code merges these hooks with your own, so nothing on disk
  changes. The hooks (`UserPromptSubmit`, `PreToolUse` for reads and subagents, `PostToolUse` for edits,
  commands and Claude's task list, `Stop`, `SubagentStop`, `Notification`) forward each event to
  hyperfocus over a unix socket. The hook script never
  prints and always exits 0, so it can't affect Claude.
- **One terminal.** Claude runs in a pseudo-terminal that hyperfocus owns. The focus view is drawn on the
  alternate screen. Claude's output is held back while the quiz is up and replayed exactly when you
  return, so Claude's screen comes back intact.
- **Questions.** A one-shot `claude -p --model haiku` call reads the project brief, your prompt, the
  files Claude looked at, the diffs it wrote and the code around them, and streams back multiple-choice
  questions and a summary. That call runs in an empty folder and has no tools, no MCP, none of your
  hooks and no thinking, which keeps it to a few seconds and about $0.004. It is first made at your
  prompt, again on the first change, after every 3 new edits, or when you run out of questions. The
  brief costs one more small call per repository each time HEAD moves.
- **Follow-ups.** After an answer, press `f` and ask anything about it ("why not a circuit breaker?").
  The same lean Haiku call answers in a few sentences, using the diff, the question and your earlier
  follow-ups as context. It runs beside question generation and never blocks it.
- **History.** Every answer is appended to `~/.hyperfocus/history.jsonl`, and every finished run to
  `~/.hyperfocus/runs.jsonl`, for `--stats`, `--review` and `--notes`.

Diagrams, sequences, state machines and design decisions are in `docs/ARCHITECTURE.md` in the source.

## Privacy

The quiz model sees what the main agent already sees: your prompt, file paths, the diffs Claude wrote
(up to about 20KB per run), up to 100 lines of the code around its latest edits, and the project brief.
The brief is written from your README, CLAUDE.md or AGENTS.md, build manifests, a folder tree and recent
commit subjects, each size-capped. It goes through your own Claude Code login, the same as Claude
itself. Nothing is sent anywhere else, and with `--writer ollama` nothing leaves your machine for
questions at all.

Before anything is stored, shown or sent, well-known token formats (Anthropic, OpenAI, GitHub, AWS,
Slack, npm, JWTs, private keys) and secret-looking assignments (`DB_PASSWORD=…`, `"apiKey": "…"`) are
replaced with `[redacted]`. Files that exist to hold secrets (`.env*`, `*.pem`, `*.key`, SSH keys,
`.npmrc`, `.netrc`) are named but their contents are never read.

## Development

```sh
npm install
npm test           # node:test suite, includes PTY-driven end-to-end tests with a fake claude
npm run typecheck  # tsc over the JS sources
```

## License

MIT. See the `LICENSE` file included in the package.

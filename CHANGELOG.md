# Changelog

## Unreleased

- **Panel bridge:** a running session can now be followed and driven by the VS Code panel. Each
  session writes `~/.hyperfocus/sessions/<pid>.json` and listens on a local socket (a named pipe on
  Windows) for the panel; answers, follow-ups, saves and ratings from the panel work exactly like the
  keys. The terminal is unchanged. The extension side comes in the next release.

## 0.6.0

- **Save a question:** press `w` after answering to keep the question, your answer, whether you were
  right, the explanation, the code it was about and any follow-up you asked. They pile up in a Markdown
  notebook at `~/.hyperfocus/saved.md`; `hyperfocus --saved` prints this project's (`--all` for every
  project).
- **VS Code extension** (in `vscode/`): a hyperfocus panel with your stats, weak spots and saved
  questions, updated live, and a button to start hyperfocus in a terminal.

## 0.5.1

- A long run that only reads code ("check the entire app") now opens the quiz after 30 seconds, with
  questions about the code the agent is exploring. 0.5.0 waited for the first edit, which could take
  minutes.

## 0.5.0

- **Other agents, experimental:** `hyperfocus codex …` wraps OpenAI Codex CLI and `hyperfocus gemini …`
  wraps Google Gemini CLI, with the same quiz, recap, notes, review and stats. Claude writes the
  questions when it is installed; otherwise the agent does, with `codex exec` or `gemini -p`. Your agent
  settings never change: Codex runs with a mirrored `CODEX_HOME`, and Gemini with a copy of its system
  settings. `"agent"` in the config chooses what a bare `hyperfocus` starts.
- The screen names the agent it is wrapping.
- Under the hood, everything agent-specific sits behind one adapter, with a contract test every agent
  must pass.

## 0.4.0

- **Windows, experimental:** npm no longer refuses to install on Windows. hyperfocus finds `claude.exe`
  or npm's `claude.cmd` through `PATHEXT`, starts the `.cmd` shim without cmd.exe (so arguments arrive
  intact), uses a named pipe for hook events, and stops the PTY without signals. Keyboard only for now;
  desktop notifications stay macOS-only. CI runs the suite on `windows-latest`.

## 0.3.0

- **The quiz waits until there is something to ask about:** Claude's first edit, or a plan of two or
  more steps, on top of the 8-second delay. A plan of three or more steps halves the wait; in projects
  whose runs are usually short, it waits for a second edit. `"switchOn": "busy"` restores 0.2 timing.
- An intro card the first time the quiz opens explains the keys; `hyperfocus --intro` shows it again.
- **Quiet mode:** `--quiet` for a session, `z` `z` in the quiz for the rest of this one, `--quiet --here`
  for a project, or `"quiet": true` everywhere. `Ctrl-]` still opens the quiz, and nothing else changes.
  Any setting can now be overridden per project under `"projects"` in the config.
- Questions see up to 100 lines of the code around Claude's latest edits (redacted like the diff), so
  they can ask why a change was made, not only what it says.
- `b` marks a bad question: skipped unscored, never reviewed, and used to steer later questions away.
- Every question is tagged with a concept (`concurrency`, `error-handling`, …). `--stats` now shows
  accuracy over the last 30 days, per kind, in this project, the concepts you miss most, and your streak.
- `--notes` ends with a `- [ ]` checklist of missed questions still in the code; `--review --md` prints it.
- `hyperfocus --install-hook` adds a git `pre-push` hook that lists them before a push. It never blocks.
- `hyperfocus --doctor` checks Node, Claude Code and its login, node-pty, the terminal, notifications,
  the config and the data folder, and makes one real question call.
- `hyperfocus --demo` replays a scripted change through the real quiz: no Claude needed, nothing kept.
- `NO_COLOR` and `TERM=dumb` turn colours off; `"animations": false` stops the spinner.

## 0.2.0

- **More kinds of questions:** spot the bug and what-does-it-do questions show real lines from the diff
  (checked against it), and prediction questions ("which file will Claude edit next?") are settled by
  Claude's next edit.
- Answer options are shuffled, and questions get harder or easier with your recent accuracy.
- The question screen is a card: the question, any code excerpt and the options in a rounded box, a
  dot per answer this run on its title bar, and one row of key hints underneath. Choose with ↑/↓ (or
  j/k) and Enter, a number, or a click. The recap is a matching card.
- Claude's plan from its task list shows under the status bar, plus a spinner and streaks.
- `l` opens the live view: a feed of reads, edits, commands and subagents, and a peek at the last lines
  of Claude's own screen. Hidden by default; `"live": true` in the config starts with it open.
- **Nothing about discarded changes comes back.** Each question and run remembers the lines its change
  added; if they are gone from the file, it is left out of everything below.
- `Esc` goes back to Claude from the focus view, and so does `Enter` while it is still thinking of a
  question: no need to remember `Ctrl-]` when your work is already done.
- The "while you were away" card lists missed questions worth a look before you merge.
- `hyperfocus --notes` prints the latest session as markdown for a PR description.
- `hyperfocus --review` asks again the missed questions whose code is still there.
- `~/.hyperfocus/config.json` for the delay, model, batch size, question kinds, notifications, mouse,
  and the live view; `HYPERFOCUS_HOME` moves the data folder.
- Secrets in diffs and commands are redacted, and files that hold secrets are never read.

## 0.1.1

- The npm page no longer links to the source repository, which is private for now.

## 0.1.0

First release.

- `hyperfocus` runs the real Claude Code in a terminal it owns and passes every argument through.
- Hooks are injected with `claude --settings`, merged with your own; nothing on disk changes.
- After the agent has been busy for 8 seconds, the screen switches to a quiz about the change Claude is
  making: a running summary plus multiple-choice questions from your prompt, the files read and the diffs
  written, generated with Haiku through your own Claude login.
- The screen switches back when Claude finishes, asks for input or is interrupted, with a bell, a macOS
  notification and a "while you were away" recap.
- `Ctrl-]` switches by hand; `--no-auto` turns auto-switching off.
- Answers are saved to `~/.hyperfocus/history.jsonl`; `hyperfocus --stats` shows accuracy per project.
- When Claude finishes (or needs you) while a question is on screen, the question stays and a prompt
  offers `Enter` to go back to Claude or `c` to keep going; answering also keeps going. Keeping going
  keeps new questions coming about the finished change.
- After answering, press `f` to ask your own follow-up question; Haiku answers using the change, the
  question and earlier follow-ups as context.
- Kitty-encoded Esc and Enter are understood in the focus view.

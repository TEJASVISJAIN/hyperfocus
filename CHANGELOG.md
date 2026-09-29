# Changelog

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

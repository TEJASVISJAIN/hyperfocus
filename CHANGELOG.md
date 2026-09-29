# Changelog

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

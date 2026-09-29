# Changelog

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

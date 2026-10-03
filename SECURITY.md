# Security

hyperfocus sees your prompts, your agent's diffs and the code around them, and runs a local socket
that the VS Code extension talks to. If you find a way for any of that to leak, to be read by another
user on the machine, or to send something it shouldn't, please report it privately.

**Report it here:** [Security → Report a vulnerability](https://github.com/TEJASVISJAIN/hyperfocus/security/advisories/new).
Please don't open a public issue.

Include what you found, how to reproduce it, and the versions of hyperfocus, your agent and your OS.
You'll get a reply within a few days. Fixes go into the latest 1.x release.

## What hyperfocus does with your code

- Question calls go to the writer you chose: your own Claude Code login, your agent's own print mode,
  or a local model through Ollama. hyperfocus runs no server of its own and collects no telemetry.
- Secrets it recognises in diffs, commands and prompts are replaced with `[redacted]` before anything
  is stored, shown or sent. `.env` files, keys and other sensitive files are never read.
- History, saved questions and run logs stay in `~/.hyperfocus/` on your machine.
- The panel bridge is a Unix socket in a directory only your user can enter, or a named pipe on Windows.

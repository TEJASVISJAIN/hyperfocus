# hyperfocus

Stay in hyperfocus while your coding agent works, instead of reaching for your phone.

`hyperfocus` runs the real Claude Code. When the agent has been busy for a few seconds, the terminal
switches to a short quiz about **the change Claude is making right now**: why it's done this way,
what could break, which edge cases matter. As soon as Claude finishes or needs you, the terminal
switches back, with a recap of what you missed.

```
 ◑ hyperfocus · editing src/retry.ts · 0:14           Ctrl-] back to Claude
────────────────────────────────────────────────────────────────────────────
  Plan 2/4 ▰▰▱▱ Adding backoff to the retry helper

What's happening
  The agent is wrapping refreshToken() in a withRetry helper with 3
  attempts and a 200ms backoff.

Question 3 · spot the bug · score 2/2 · streak 2
  What does this retry loop miss?

    + for (let i = 0; i < attempts; i++) {
    +   await sleep(200);

  1) Jitter: every client retries in lockstep
  2) A maximum number of attempts
  3) Awaiting the sleep

  press 1-3 to answer · s to skip · l live view
```

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
count toward your own usage, at about $0.003 per batch.

Every argument is passed through to `claude`: `hyperfocus --continue`, `hyperfocus --model sonnet`,
and so on. When input or output is piped (`echo hi | hyperfocus -p`), hyperfocus steps aside and runs
`claude` directly.

**Linux:** installing compiles one native dependency (`node-pty`), so you need `python3`, `make` and a
C++ compiler (`sudo apt install build-essential python3` on Debian/Ubuntu). macOS needs nothing extra.
Windows isn't supported yet.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| `Ctrl-]` | anywhere | switch between Claude and the focus view |
| `1`–`4` or click | focus view | answer the question |
| `s` | focus view | skip the question |
| `l` | focus view | show or hide the live view: what Claude is doing right now |
| `f` | after an answer | ask your own follow-up question; Enter to send, Esc to cancel |
| `Enter` / `c` | when Claude finishes mid-question | go back to Claude / keep going with the quiz |
| any key | after an answer or on the recap | continue |

Keys you press in the focus view never reach Claude.

## Questions

- **Why:** why the change is done this way, what could break, edge cases, tradeoffs.
- **Spot the bug:** a few real lines from the diff, and what they get wrong or miss.
- **What does it do:** a few real lines from the diff, and what they return for a given input.
- **Predict:** "Which file will Claude edit next?" You lock in a guess, carry on with the quiz, and
  Claude's next edit settles it.

Code shown with a question is checked against the diff, so it is always code Claude really wrote. The
options are shuffled, so the right answer's position gives nothing away. Questions get harder when you
keep getting them right and easier when you don't.

The focus view also shows **Claude's plan** (from its task list) as one line under the status bar.
Press **`l`** for the **live view**: a feed of what the agent is reading, editing and running, and a peek
at the last lines of Claude's own screen. It is hidden by default so the question has the screen to
itself; set `"live": true` in the config to always start with it open.

## After a run

- **Worth a look before you merge.** The "while you were away" card lists the questions you got wrong,
  as long as the code they are about is still there.
- **`hyperfocus --notes`** prints the latest session in this project as markdown, ready for a PR
  description: each prompt, what Claude did, and the files it changed.
- **`hyperfocus --review`** asks again the questions you missed in this project.

All three leave out changes that are no longer in the code. If you had Claude build X, then changed your
mind and had it build Y instead, the questions and notes about X don't come back. Each question and each
run remembers the distinctive lines its change added; if those lines are gone from the file, the change
was reverted or rewritten, so hyperfocus leaves it out.

## When it switches

- **To the focus view:** after the agent has been busy for 8 seconds, and you haven't typed for 2 seconds.
  Quick replies never interrupt you.
- **Back to Claude:** the moment Claude finishes, asks for input (a permission prompt, a question) or
  you interrupt it with Esc. You get a terminal bell and, on macOS, a notification.
  - **In the middle of a question?** It stays on screen with a prompt: `Enter` goes back to Claude, `c`
    (or just answering) keeps going. If you keep going, hyperfocus keeps writing questions about the
    finished change until you go back with `Ctrl-]`.
  - Otherwise, if you were in the focus view for 15 seconds or more, or answered anything, a "while you
    were away" card shows first.
- If you switch back to Claude yourself, hyperfocus stays out of the way until your next prompt.

## Options

| Flag / variable | Default | |
| --- | --- | --- |
| `--no-auto` | off | never open the focus view by itself; `Ctrl-]` still works |
| `--stats` | | print quiz answers and accuracy per project, then exit |
| `--notes` | | print notes on the latest session in this project, then exit |
| `--review` | | ask again the missed questions whose code is still here |
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
  "live": false
}
```

A bad value is reported when hyperfocus starts, and that setting keeps its default.

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
- **Questions.** A one-shot `claude -p --model haiku` call reads your prompt, the files Claude looked at
  and the diffs it wrote, and returns a summary plus multiple-choice questions. That call has no tools,
  no MCP, none of your hooks and no thinking, which keeps it to about 6 seconds and $0.003. It asks again
  on the first change, after every 3 new edits, or when you run out of questions.
- **Follow-ups.** After an answer, press `f` and ask anything about it ("why not a circuit breaker?").
  The same lean Haiku call answers in a few sentences, using the diff, the question and your earlier
  follow-ups as context. It runs beside question generation and never blocks it.
- **History.** Every answer is appended to `~/.hyperfocus/history.jsonl`, and every finished run to
  `~/.hyperfocus/runs.jsonl`, for `--stats`, `--review` and `--notes`.

Diagrams, sequences, state machines and design decisions are in `docs/ARCHITECTURE.md` in the source.

## Privacy

The quiz model sees what the main agent already sees: your prompt, file paths, and the diffs Claude
wrote (up to about 20KB per run). It goes through your own Claude Code login, the same as Claude itself.
Nothing is sent anywhere else.

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

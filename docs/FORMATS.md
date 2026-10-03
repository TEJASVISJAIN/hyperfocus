# Formats hyperfocus keeps stable

Since 1.0.0, three things outside the code are a public contract under semver:

1. **the panel bridge**, the local protocol the VS Code extension (or anything else) uses to follow a session;
2. **the config file**, `~/.hyperfocus/config.json`;
3. **the data files** in `~/.hyperfocus/`: history, saved questions, runs, session files and cached briefs.

**Within 1.x, these only grow.** New messages, fields and settings may be added; none is removed, renamed, or given a new meaning. Every reader, including hyperfocus itself, ignores fields and message types it doesn't know. A change that can't be made that way waits for 2.0.0 and bumps the version number below.

`HYPERFOCUS_HOME` moves the whole data folder (default `~/.hyperfocus`).

## The panel bridge (protocol 1)

Each running session writes `sessions/<pid>.json` and listens on a local endpoint: a Unix socket inside a fresh directory only the user can enter (`hf-XXXX/bridge.sock` in the temp folder), or a named pipe on Windows. A client finds sessions by reading the session files, skipping any whose `pid` is not running, and connects to `endpoint`.

Messages are JSON objects, one per line (`\n`), both ways. A client that sends a line longer than 64 KB is dropped.

### Server → client

| Message | When |
|---|---|
| `{ "type": "hello", "protocol": 1, "pid", "cwd", "agent" }` | once, on connect |
| `{ "type": "state", ...snapshot, "quiet": boolean }` | on connect, then whenever what it says changes |
| `{ "type": "stale", "id" }` | the action named a question that is no longer up |

A client that receives a `protocol` it doesn't know must not guess: it tells the user which hyperfocus it needs.

The snapshot:

```jsonc
{
  "agent": { "activity": "editing src/retry.ts", "since": 1759480000000, "busy": true, "finished": false },
  "run": { "summary": "…", "startedAt": 1759480000000, "prompt": "add retry to token refresh", "files": ["src/retry.ts"] },
  "question": {                      // null when none is up
    "id": 7,                         // names the question in actions
    "number": 3,                     // its number in this session, for display
    "kind": "why",                   // "why" | "bug" | "output" | "predict"
    "q": "…", "options": ["…", "…"],
    "code": "…",                     // optional: lines it is about, copied from the change
    "file": "src/retry.ts",          // optional
    "anchor": { "file": "src/retry.ts", "anchors": ["…"] }, // optional: lines that locate it in the file
    "plan": "add retry to token refresh", // optional: asked before any edit, about the plan for this prompt
    "repeat": true,                  // optional: a missed question asked again on schedule
    "tags": ["concurrency"]          // optional
  },
  "queued": 2,                       // questions waiting after this one
  "feedback": {                      // null until the question is answered
    "chosen": 0, "correct": false,   // correct is null for predictions
    "answer": 1, "why": "…",         // null for predictions
    "saved": false,
    "lesson": true                   // a lesson on the idea can be asked now
  },
  "thread": [{ "ask": "…", "answer": "…" }], // follow-ups; answer null while pending
  "followUpFailed": false,
  "score": { "answered": 3, "correct": 2, "streak": 1 },
  "result": { "text": "…", "good": true },   // how the latest prediction turned out, or null
  "quiet": false
}
```

The answer and the explanation are never in a snapshot before the user has answered. All text goes through secret redaction.

### Client → server

| Message | Does what the terminal key does |
|---|---|
| `{ "type": "answer", "id", "chosen" }` | `1`–`9` |
| `{ "type": "skip", "id" }` | `s` |
| `{ "type": "next", "id" }` | any key after an answer |
| `{ "type": "save", "id" }` | `w` |
| `{ "type": "rate", "id", "rating": "bad" }` | `b` |
| `{ "type": "followUp", "id", "ask" }` | `f`; `ask` is cut to 500 characters |
| `{ "type": "lesson", "id" }` | `e`, after a wrong answer |
| `{ "type": "keepGoing" }` | `c`, when the agent finished mid-question |
| `{ "type": "back" }` | Enter, when the agent finished mid-question |
| `{ "type": "exit" }` | Esc: back to the agent |
| `{ "type": "quiet" }` | `z z`: no more automatic quizzes this session |
| `{ "type": "watching", "visible": boolean }` | the panel is on screen; while any is, the terminal leaves the quiz to it |

`id` is optional; when given and it doesn't name the question on screen, the action is refused with `stale`. An action that makes no sense at the moment is ignored.

## The config file

`~/.hyperfocus/config.json` (or `HYPERFOCUS_CONFIG`), a JSON object. Every key is optional. A bad value is reported and its default used; hyperfocus never refuses to start over config.

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | the format of this file |
| `delayMs` | `8000` | how long the agent must be busy before the terminal quiz opens |
| `model` | `"haiku"` | the Claude model that writes questions |
| `questionsPerBatch` | `3` | 1–5 |
| `kinds` | all | any of `"why"`, `"bug"`, `"output"`, `"predict"` |
| `notifications` | `true` | desktop notification when the agent needs you |
| `mouse` | `true` | click options in the terminal |
| `live` | `false` | start with the live panel open in the terminal |
| `switchOn` | `"edit"` | `"edit"`: wait for something to quiz on; `"busy"`: switch after `delayMs` |
| `quiet` | `false` | never open the quiz by itself |
| `animations` | `true` | |
| `agent` | `"claude"` | what a bare `hyperfocus` wraps: `"claude"`, `"codex"`, `"gemini"` |
| `writer` | `"auto"` | who writes questions: `"auto"` (Claude if installed, else the agent) or `"ollama"` |
| `ollamaModel` | `"qwen2.5-coder:7b"` | the Ollama model, with `writer: "ollama"` |
| `projects` | `{}` | `{ "<absolute folder>": { …any of the above } }`, overriding them in that folder |

## Data files

All JSON lines files are append-only, one JSON object per line. Readers skip lines they can't parse. Entries written since 1.0.0 carry `"v": 1`; older entries have no `v` and are read the same way.

### `history.jsonl`: every answered or skipped question

`v`, `ts` (ISO time), `cwd`, `sessionId`, `source` (`"live"`, `"review"`, `"staged"`, `"repeat"`), `kind`, `question`, `options`, `answer` (index, or null for predictions), `why`, `chosen` (index or null), `correct` (boolean or null), `skipped`, `files` (changed in the run); optional `code`, `codeMarks`, `anchor`, `tags`, `rating` (`"bad"`).

Spaced repeats are worked out from this file: a miss is due again after 1 day; each right answer moves it to 3, then 7 days; a right answer at 7 days retires it; a miss starts over.

### `saved.jsonl`: questions saved with `w`

`v`, `ts`, `cwd`, `kind`, `question`, `options`, `answer`, `why`, `chosen`, `correct`, `files`; optional `file`, `code`, `anchor`, `plan`, `tags`, `thread`. `saved.md` beside it is rebuilt from it after each save and is for reading, not parsing.

### `runs.jsonl`: every finished run

`v`, `ts`, `cwd`, `sessionId`, `prompt`, `summary`, `files` (`[{ "path", "anchors" }]`); optional `durationMs`, and `firstQuestionMs`: how long after the prompt the run's first question existed (absent when none came before the run ended).

### `sessions/<pid>.json`: one per running session

`protocol`, `pid`, `cwd`, `agent` (`"claude"`, `"codex"`, `"gemini"`, `"staged"`), `endpoint`, `startedAt`. Removed when the session ends; a file whose `pid` isn't running is stale and may be deleted by any reader.

### `briefs/<hash>.json`: cached project briefs

`v`, `root` (repository root, or the folder outside git), `head` (commit, or null outside git), `builtAt`, `brief` (text). A cache: deleting it is always safe.

### `state.json`

`introSeenAt`: when the first-run intro was shown.

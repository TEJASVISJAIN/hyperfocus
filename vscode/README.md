# hyperfocus for VS Code

Your AI agent writes the code. hyperfocus makes sure you understand it.

While Claude Code, Codex CLI or Gemini CLI works, [hyperfocus](https://tejasvisjain.github.io/hyperfocus-web/)
asks you short multiple-choice questions about the change it's making: spot the bug, predict the
behaviour, why this approach. This extension puts those questions in your editor.

![The hyperfocus panel: a live question, the answer, a follow-up and a saved question](https://tejasvisjain.github.io/hyperfocus-web/vscode-live.gif)

## What you get

- **Answer in the sidebar.** While hyperfocus runs in this folder (in VS Code's terminal or any
  other), the **Live** card shows what the agent is doing and the question you're being asked. Click
  an option or press `1`–`9`. You get the answer and the reasoning straight away.
- **Follow up, save, rate.** Ask a follow-up question about the answer, save it to your notebook, or
  mark it a bad question so it never counts. The terminal stays in step with the panel.
- **Jump to the code.** Click the question's file to open it at the lines the question is about.
- **Gutter marks.** Lines you've been quizzed on get a green or red dot. Hover it for the question.
- **Review staged changes.** The 🎓 button in the Source Control view quizzes you on your own staged
  diff before you commit. No agent needed.
- **Notebook.** Saved questions in a tree, by project and topic. Click one to see it and its code.
- **Stats and weak spots:** questions answered, how often you're right over 30 days, your day streak,
  and the topics you miss most.
- **Status bar and a notification** when the agent finishes.

## Get started

1. Install a coding agent: [Claude Code](https://claude.com/claude-code), Codex CLI or Gemini CLI.
2. Click **Start hyperfocus** at the top of the hyperfocus panel. It runs your agent inside
   hyperfocus in a terminal (with `npx` if you haven't installed it: `npm i -g @ddalus/hyperfocus`).
3. Give the agent a task. Questions show up in the panel while it works.

The **Learn while your AI codes** walkthrough (Help → Welcome) goes through the same steps.

## Privacy and cost

The extension never calls a model and never sends anything anywhere. It reads the files hyperfocus
writes in `~/.hyperfocus` and follows a running session over a local socket that only your user can
open. The questions are written by hyperfocus using your agent's own login, about $0.004 per batch
of three on Claude Haiku. [What it costs](https://tejasvisjain.github.io/hyperfocus-web/#cost).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `hyperfocus.agent` | ask | which agent to wrap: `claude`, `codex` or `gemini` |
| `hyperfocus.command` | `npx @ddalus/hyperfocus` | left as it is, the extension uses `hyperfocus` when installed; anything else runs exactly as written |
| `hyperfocus.notifications` | on | notify when the agent finishes |
| `hyperfocus.gutterMarks` | on | the green and red marks beside lines you were quizzed on |
| `hyperfocus.home` | `~/.hyperfocus` | where hyperfocus keeps its data |

The live view needs hyperfocus 0.7.0 or later. With an older one the panel says so.

## Developing

`npm test` runs the tests with plain node. `live.test.js` connects to hyperfocus's real bridge from
`../src`, so the two can't drift apart unnoticed. The webview, commands and decorations aren't
tested automatically; before a release, check them by hand in VS Code with the new hyperfocus:

- [ ] Start hyperfocus from the panel (one agent, several, none; installed and not)
- [ ] The Live card follows the agent; answer by click and by `1`–`9`; the terminal agrees
- [ ] Follow-up, save, bad question, next, skip; back to the agent mid-question
- [ ] Agent finishes: notification, keep going, back
- [ ] Click the question's file: the right lines open, highlighted
- [ ] Gutter marks appear after answering, follow edits, hide with the setting
- [ ] Notebook tree updates on save; an entry opens its card and code
- [ ] Review staged changes: questions appear, End review stops it; nothing staged says so
- [ ] Status bar text and click, with and without a session
- [ ] An older hyperfocus (0.6) shows the update message

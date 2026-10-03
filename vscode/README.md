# hyperfocus for VS Code

A sidebar for [hyperfocus](https://tejasvisjain.github.io/hyperfocus-web/), the quiz that runs while
your coding agent works.

- **Live:** while hyperfocus runs in this folder (in VS Code's terminal or any other), the panel
  shows what the agent is doing and the question you're being asked, with the feedback once you
  answer. Needs hyperfocus 0.7.0 or later.
- **Stats:** questions answered, how often you're right over 30 days, and your day streak.
- **Weak spots:** the concepts you miss most.
- **Saved questions:** everything you pressed `w` on, with your answer, the right one, the code and
  your follow-ups. **Open the notebook** shows them all as Markdown.
- **Recently missed:** the last questions you got wrong.
- **Start hyperfocus in a terminal**, in this workspace.

It reads the files hyperfocus writes in `~/.hyperfocus` and follows a running session over a local
socket that only your user can open. Nothing leaves your machine.

Settings: `hyperfocus.command` (default `npx @ddalus/hyperfocus`; try `hyperfocus codex`) and
`hyperfocus.home`.

## Developing

`node test.js && node --test live.test.js` runs the tests. `live.test.js` connects to hyperfocus's
real bridge from `../src`, so the two can't drift apart unnoticed.

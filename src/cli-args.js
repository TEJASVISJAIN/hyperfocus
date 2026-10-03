// hyperfocus accepts every `claude` argument; these few are its own and are removed before claude sees them.
const OWN_FLAGS = new Set(['--no-auto', '--stats', '--notes', '--review', '--intro', '--quiet', '--here', '--md', '--brief', '--install-hook', '--uninstall-hook', '--doctor', '--demo', '--saved', '--staged']);

// `hyperfocus codex …` and `hyperfocus gemini …` wrap another agent; everything after is its own.
const AGENT_COMMANDS = new Set(['codex', 'gemini']);

export function parseFocusArgs(argv) {
  const agent = AGENT_COMMANDS.has(argv[0]) ? argv[0] : null;
  const rest = agent ? argv.slice(1) : argv;
  // `--writer ollama` or `--writer=ollama`: who writes the questions, for this run.
  let writer = null;
  const ownValues = new Set();
  rest.forEach((arg, index) => {
    if (arg === '--writer' && index + 1 < rest.length) {
      writer = rest[index + 1];
      ownValues.add(index).add(index + 1);
    } else if (arg.startsWith('--writer=')) {
      writer = arg.slice('--writer='.length);
      ownValues.add(index);
    }
  });
  return {
    agent,
    writer,
    claudeArgs: rest.filter((arg, index) => !OWN_FLAGS.has(arg) && !ownValues.has(index)),
    auto: !argv.includes('--no-auto'),
    stats: argv.includes('--stats'),
    notes: argv.includes('--notes'),
    review: argv.includes('--review'),
    intro: argv.includes('--intro'),
    quiet: argv.includes('--quiet'),
    here: argv.includes('--here'),
    md: argv.includes('--md'),
    brief: argv.includes('--brief'),
    doctor: argv.includes('--doctor'),
    demo: argv.includes('--demo'),
    saved: argv.includes('--saved'),
    staged: argv.includes('--staged'),
    installHook: argv.includes('--install-hook'),
    uninstallHook: argv.includes('--uninstall-hook'),
  };
}

// hyperfocus accepts every `claude` argument; these few are its own and are removed before claude sees them.
const OWN_FLAGS = new Set(['--no-auto', '--stats', '--notes', '--review', '--intro', '--quiet', '--here', '--md', '--brief', '--install-hook', '--uninstall-hook', '--doctor', '--demo', '--saved', '--staged']);

// `hyperfocus codex …` and `hyperfocus gemini …` wrap another agent; everything after is its own.
const AGENT_COMMANDS = new Set(['codex', 'gemini']);

export function parseFocusArgs(argv) {
  const agent = AGENT_COMMANDS.has(argv[0]) ? argv[0] : null;
  const rest = agent ? argv.slice(1) : argv;
  return {
    agent,
    claudeArgs: rest.filter((arg) => !OWN_FLAGS.has(arg)),
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

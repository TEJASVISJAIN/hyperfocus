// hyperfocus accepts every `claude` argument; these few are its own and are removed before claude sees them.
const OWN_FLAGS = new Set(['--no-auto', '--stats', '--notes', '--review']);

export function parseFocusArgs(argv) {
  return {
    claudeArgs: argv.filter((arg) => !OWN_FLAGS.has(arg)),
    auto: !argv.includes('--no-auto'),
    stats: argv.includes('--stats'),
    notes: argv.includes('--notes'),
    review: argv.includes('--review'),
  };
}

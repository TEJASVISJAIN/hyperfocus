// focus accepts every `claude` argument; these few are its own and are removed before claude sees them.
const FOCUS_FLAGS = new Set(['--no-auto', '--stats']);

export function parseFocusArgs(argv) {
  return {
    claudeArgs: argv.filter((arg) => !FOCUS_FLAGS.has(arg)),
    auto: !argv.includes('--no-auto'),
    stats: argv.includes('--stats'),
  };
}

const DEFAULT_DELAY_MS = 8000;

export function focusDelayMs(env = process.env) {
  const requested = Number(env.FOCUS_DELAY_MS);
  return Number.isFinite(requested) && requested >= 0 && env.FOCUS_DELAY_MS !== '' ? requested : DEFAULT_DELAY_MS;
}

import { homedir } from 'node:os';
import { join } from 'node:path';

// Where hyperfocus keeps its history, run log, config and debug log. HYPERFOCUS_HOME moves it,
// which the end-to-end tests use to stay out of the real one.
export const dataDir = (env = process.env) => env.HYPERFOCUS_HOME || join(homedir(), '.hyperfocus');

import { claudeAgent } from './claude.js';

/** The agents hyperfocus can wrap, by the name used on the command line (`hyperfocus codex`). */
export const AGENTS = { claude: claudeAgent };

export const agentNamed = (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : null);

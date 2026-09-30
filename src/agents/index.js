import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { geminiAgent } from './gemini.js';

/** The agents hyperfocus can wrap, by the name used on the command line (`hyperfocus codex`). */
export const AGENTS = { claude: claudeAgent, codex: codexAgent, gemini: geminiAgent };

export const agentNamed = (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : null);

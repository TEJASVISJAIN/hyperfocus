import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './data-dir.js';

export const QUESTION_KINDS = ['why', 'bug', 'output', 'predict'];

/**
 * @typedef {{
 *   delayMs: number, model: string, questionsPerBatch: number, kinds: string[],
 *   notifications: boolean, mouse: boolean, live: boolean
 * }} Config
 */

/** @type {Readonly<Config>} */
export const DEFAULT_CONFIG = Object.freeze({
  delayMs: 8000, // how long the agent must be busy before the focus view opens
  model: 'haiku', // the model that writes questions and answers follow-ups
  questionsPerBatch: 3,
  kinds: [...QUESTION_KINDS],
  notifications: true, // macOS notification when Claude needs you (the bell always rings)
  mouse: true, // click options in the focus view
  live: false, // start with the live panel open (feed of agent steps + peek at Claude); `l` toggles it
});

const isBoolean = (value) => typeof value === 'boolean';
const RULES = {
  delayMs: [(value) => Number.isFinite(value) && value >= 0, 'must be a number of milliseconds, 0 or more'],
  model: [(value) => typeof value === 'string' && value.trim() !== '', 'must be a model name such as "haiku" or "sonnet"'],
  questionsPerBatch: [(value) => Number.isInteger(value) && value >= 1 && value <= 5, 'must be a whole number from 1 to 5'],
  kinds: [(value) => Array.isArray(value), `must be a list of question kinds: ${QUESTION_KINDS.join(', ')}`],
  notifications: [isBoolean, 'must be true or false'],
  mouse: [isBoolean, 'must be true or false'],
  live: [isBoolean, 'must be true or false'],
};

export const defaultConfigPath = () => join(dataDir(), 'config.json');

/**
 * Reads ~/.hyperfocus/config.json. A bad setting never stops hyperfocus: it is reported in
 * `problems` and the default is used instead.
 */
export function loadConfig({ path = undefined, env = process.env } = {}) {
  const configPath = path ?? (env.HYPERFOCUS_CONFIG || defaultConfigPath());
  const problems = [];
  /** @type {Config} */
  const config = { ...DEFAULT_CONFIG, kinds: [...DEFAULT_CONFIG.kinds] };

  let raw = null;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    // No config file is the normal case.
  }
  if (raw !== null) {
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      problems.push(`${configPath} is not valid JSON, so it was ignored`);
    }
    if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
      problems.push(`${configPath} must hold a JSON object of settings, so it was ignored`);
    } else if (settings) {
      for (const [key, value] of Object.entries(settings)) {
        const rule = RULES[key];
        if (!rule) problems.push(`unknown setting "${key}"`);
        else if (!rule[0](value)) problems.push(`"${key}" ${rule[1]}`);
        else config[key] = value;
      }
    }
  }

  if (config.kinds.length === 0) problems.push('"kinds" is empty, so every kind is used');
  const unknownKinds = config.kinds.filter((kind) => !QUESTION_KINDS.includes(kind));
  if (unknownKinds.length) problems.push(`unknown question kinds ${unknownKinds.map((kind) => `"${kind}"`).join(', ')}`);
  config.kinds = config.kinds.filter((kind) => QUESTION_KINDS.includes(kind));
  if (config.kinds.length === 0) config.kinds = [...DEFAULT_CONFIG.kinds];

  const delayFromEnv = Number(env.HYPERFOCUS_DELAY_MS);
  if (env.HYPERFOCUS_DELAY_MS && Number.isFinite(delayFromEnv) && delayFromEnv >= 0) config.delayMs = delayFromEnv;

  return { config, problems };
}

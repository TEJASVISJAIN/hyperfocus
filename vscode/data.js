// Reads hyperfocus's own files. Kept free of the vscode module so it can be tested with plain node.
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const dataDir = (override = '', env = process.env) => override || env.HYPERFOCUS_HOME || join(homedir(), '.hyperfocus');

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === 'object' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

const DAY = 86_400_000;
const dayOf = (ts) => Math.floor(new Date(ts).getTime() / DAY);

/** What the panel shows, for one project (`cwd`) or every project (`cwd` null). */
function summarize({ home, cwd = null, now = Date.now() }) {
  const history = readJsonLines(join(home, 'history.jsonl')).filter((entry) => entry.cwd && typeof entry.question === 'string');
  const bad = new Set(history.filter((entry) => entry.rating === 'bad').map((entry) => entry.cwd + '\0' + entry.question));
  const good = history.filter((entry) => !bad.has(entry.cwd + '\0' + entry.question));
  const here = cwd ? good.filter((entry) => entry.cwd === cwd) : good;
  const answered = here.filter((entry) => typeof entry.correct === 'boolean');
  const right = answered.filter((entry) => entry.correct).length;

  const days = new Set(good.filter((entry) => typeof entry.correct === 'boolean').map((entry) => dayOf(entry.ts)));
  // Consecutive days with an answer, ending today (or yesterday, if today has none yet).
  let day = days.has(dayOf(now)) ? dayOf(now) : dayOf(now) - 1;
  let streak = 0;
  while (days.has(day--)) streak++;

  const byTag = new Map();
  for (const entry of answered) for (const tag of entry.tags ?? []) {
    const tally = byTag.get(tag) ?? { tag, answered: 0, correct: 0 };
    tally.answered++;
    if (entry.correct) tally.correct++;
    byTag.set(tag, tally);
  }
  const weakSpots = [...byTag.values()].filter((t) => t.answered >= 3 && t.correct < t.answered).sort((a, b) => a.correct / a.answered - b.correct / b.answered).slice(0, 4);

  const missed = answered.filter((entry) => entry.correct === false).slice(-5).reverse();
  const saved = readJsonLines(join(home, 'saved.jsonl')).filter((entry) => typeof entry.question === 'string' && (!cwd || entry.cwd === cwd)).reverse();
  const last30 = answered.filter((entry) => now - new Date(entry.ts).getTime() < 30 * DAY);
  return {
    answered: answered.length,
    correct: right,
    last30: { answered: last30.length, correct: last30.filter((entry) => entry.correct).length },
    streak,
    weakSpots,
    missed,
    saved,
  };
}

module.exports = { dataDir, readJsonLines, summarize };

/**
 * A question writer on the user's own machine, through Ollama's local HTTP API: for anyone whose
 * code must not leave it. It writes questions only; the agent being wrapped is unchanged.
 */

// Provisional default: small enough for a laptop, and good at reading code. Override with `ollamaModel`.
export const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';

/** Ollama's address: OLLAMA_HOST as Ollama itself reads it, else its default. */
export function ollamaHost(env = process.env) {
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/+$/, '');
}

/** @type {import('./claude.js').QuestionWriter} */
export const ollamaWriter = {
  args: () => [],
  env: (env) => env,
  parse: () => null,
  defaultModel: OLLAMA_DEFAULT_MODEL,
  // /api/chat streams one JSON object per line, each with the next piece of the reply.
  request: async ({ systemPrompt, prompt, model, env, signal, onText }) => {
    const response = await fetch(`${ollamaHost(env)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || OLLAMA_DEFAULT_MODEL,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.4 },
      }),
      signal,
    });
    if (!response.ok || !response.body) return { text: `Ollama answered ${response.status}: ${(await response.text()).slice(0, 200)}`, isError: true };
    let text = '';
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const part = JSON.parse(line);
        if (part.error) return { text: String(part.error), isError: true };
        text += part.message?.content ?? '';
      }
      onText(text);
    }
    return { text, isError: false };
  },
};

/**
 * For `--doctor`: is Ollama running, and is the model pulled?
 * @returns {Promise<{ status: 'ok' | 'fail', detail: string, hint?: string }>}
 */
export async function checkOllama({ model, env = process.env, timeoutMs = 3000 }) {
  const host = ollamaHost(env);
  let tags;
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    tags = await response.json();
  } catch {
    return { status: 'fail', detail: `not reachable at ${host}`, hint: 'start Ollama (ollama serve), or set OLLAMA_HOST to where it runs' };
  }
  const names = (Array.isArray(tags?.models) ? tags.models : []).map((entry) => String(entry?.name ?? entry?.model ?? ''));
  const wanted = model || OLLAMA_DEFAULT_MODEL;
  const pulled = names.some((name) => name === wanted || name === `${wanted}:latest`);
  return pulled ? { status: 'ok', detail: `${wanted} is ready at ${host}` } : { status: 'fail', detail: `${wanted} is not pulled`, hint: `ollama pull ${wanted}` };
}

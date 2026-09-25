// Tier 2: turning a finished turn into one spoken line.
//
// Provider chain, first one that's available wins:
//   1. ANTHROPIC_API_KEY  -> Claude API      (~1-2s, ~$0.001/msg, best quality)
//   2. local ollama       -> AGENTS_OLLAMA_MODEL (5-12s, free, offline)
//   3. neither            -> null, and the bubble just keeps its tier-1 line
//
// `claude -p` is deliberately not in the chain: measured at ~7.8s and ~$0.18
// per message, because it re-sends the whole Claude Code system prompt.

export const DEFAULT_QUESTION = 'what did you just do?';
const norm = (q) => String(q || '').trim().toLowerCase().replace(/[?.!\s]+$/, '');
/** Is this the stock question, i.e. can a precomputed answer serve it? */
export const isDefaultQuestion = (q) => !norm(q) || norm(q) === norm(DEFAULT_QUESTION);

const OLLAMA_URL = process.env.AGENTS_OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.AGENTS_OLLAMA_MODEL || 'hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M';
const ANTHROPIC_MODEL = process.env.AGENTS_ANTHROPIC_MODEL || 'claude-opus-5';

const SYSTEM = `you are a software engineer working inside a dungeon game. your teammate just walked up to your desk and asked you about the work you literally just finished. answer as yourself.

how you talk:
- all lowercase. never capitalise anything — not "i", not the start of a sentence, not file names, not key names.
- like an engineer messaging a teammate they know well. contractions always. slang is good: "yeah", "nah", "basically", "kinda", "just", "ended up", "turns out", "so", "should be good", "was being dumb", "grabbed", "wired up", "ripped out".
- but you are still a real engineer — be specific and correct. name the actual files, functions, keys, flags, commands. say what the mechanism was, not just that you did a thing. no hand-waving.
- if something failed or you're unsure, say so plainly. don't oversell.

grounding — this matters more than sounding good:
- only say things that are actually in the notes below. never invent a file, function, flag, or feature that isn't there.
- if the notes are thin and you genuinely can't tell what you did, say that: "honestly not much to show, mostly poking at X" or "cant really tell from what i've got". that's a fine answer.
- do not pad. a short vague-but-true answer beats a detailed invented one.

shape:
- 1-2 sentences. 35 words max. it renders in a speech bubble over your head.
- no markdown, no bullets, no headings, no backticks, no quotes wrapping the answer.
- don't greet, don't introduce yourself, don't say "i just" — start on the substance.`;

function buildUser(turn, question) {
  const L = [];
  if (turn.prompt) L.push(`what you were asked to do: ${turn.prompt}`);
  if (turn.files.length) L.push(`files you touched: ${turn.files.join(', ')}`);
  const tools = Object.entries(turn.tools).map(([k, v]) => (v > 1 ? `${k} (${v} times)` : k)).join(', ');
  if (tools) L.push(`tools you used: ${tools}`);
  if (turn.cmds.length) L.push(`commands you ran: ${turn.cmds.join(' ; ')}`);
  if (turn.finalText) L.push(`your own writeup of what you did:\n${turn.finalText}`);
  L.push(`\nyour teammate asks: ${question}`);
  return L.join('\n');
}

// The models drift out of lowercase on identifiers no matter how the prompt is
// worded, so it's enforced here rather than hoped for. Strip markdown too.
function clean(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[`*_#>]/g, '')
    .replace(/^\s*["']|["']\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Trim to the last complete sentence rather than chopping mid-word.
function fit(s, max = 240) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '…').trim();
}

async function viaAnthropic(turn, question, signal, onDelta) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: 200,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildUser(turn, question) }],
  }, { signal });
  if (onDelta) stream.on('text', (t) => onDelta(t));
  const res = await stream.finalMessage();
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function viaOllama(turn, question, signal, onDelta) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: true, think: false,
      keep_alive: '30m',                       // don't pay the reload on every gap
      options: { temperature: 0.7, num_predict: 100 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUser(turn, question) }],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);

  // NDJSON: one JSON object per line, each with the next token.
  let out = '', buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      if (j.error) throw new Error(j.error);
      const piece = j.message?.content || '';
      if (piece) { out += piece; onDelta?.(piece); }
    }
  }
  return out;
}

let ollamaUp = null;
async function ollamaReachable() {
  if (ollamaUp !== null) return ollamaUp;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    ollamaUp = r.ok;
  } catch { ollamaUp = false; }
  return ollamaUp;
}

/** Which backend tier 2 will use right now — for the startup banner. */
export async function describeBackend() {
  if (process.env.ANTHROPIC_API_KEY) return `anthropic (${ANTHROPIC_MODEL})`;
  if (await ollamaReachable()) return `ollama (${OLLAMA_MODEL})`;
  return null;
}

/** One spoken line, or null if no backend is available / it failed.
 *  `onDelta` receives raw text fragments as they generate, for live typing. */
export async function speak(turn, question, onDelta) {
  if (!turn) return null;
  // Too little to go on — a small model fills the gap with fiction, so don't
  // ask it. The caller falls back to the tier-1 facts.
  if (turn.thin) return null;
  const signal = AbortSignal.timeout(Number(process.env.AGENTS_LLM_TIMEOUT_MS) || 45_000);
  const chain = [];
  if (process.env.ANTHROPIC_API_KEY) chain.push(['anthropic', viaAnthropic]);
  if (await ollamaReachable()) chain.push(['ollama', viaOllama]);

  for (const [name, fn] of chain) {
    try {
      const out = fit(clean(await fn(turn, question, signal, onDelta)));
      if (out) return out;
    } catch (err) {
      console.warn(`[agents] tier2 ${name} failed: ${err.message}`);
      if (name === 'anthropic') ollamaUp = null;   // re-probe before falling through
    }
  }
  return null;
}

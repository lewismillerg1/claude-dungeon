// Context-window accounting for the agent relay.
//
// Claude Code transcripts record how many tokens a request carried, but NOT how
// big the session's context window is — and the model id ("claude-opus-5") is
// the same whether the 1M-token variant is in use or not. So we take the window
// from two signals: the `[1m]` marker in the user's settings as a starting
// guess, then ratchet up if a session is ever observed exceeding it.
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const WINDOW_LADDER = [200_000, 1_000_000];

/** Best guess at the context window before we've seen any usage. */
export function detectDefaultWindow() {
  const env = Number(process.env.AGENTS_CONTEXT_WINDOW);
  if (Number.isFinite(env) && env > 0) return env;
  for (const file of ['settings.local.json', 'settings.json']) {
    try {
      const s = JSON.parse(readFileSync(path.join(os.homedir(), '.claude', file), 'utf8'));
      if (s?.model) return /\[1m\]/i.test(String(s.model)) ? 1_000_000 : 200_000;
    } catch { /* missing or malformed — try the next one */ }
  }
  return 200_000;
}

/** Smallest window that fits `used`, never shrinking below `current`. */
export function nextWindow(used, current) {
  let w = current;
  for (const rung of WINDOW_LADDER) if (rung > w && rung >= used) return rung;
  return w;
}

// Async: this runs on the relay's request path, and a sync read of a quarter
// megabyte on every single tool-use event stalls the dev server's event loop.
async function readTail(p, bytes = 262144) {
  const fh = await open(p, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

/** Tokens in the most recent request's prompt, or undefined if unknown. */
export async function readContextTokens(transcriptPath) {
  if (!transcriptPath) return undefined;
  let txt;
  try { txt = await readTail(transcriptPath); } catch { return undefined; }
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }   // tail may start mid-line
    const u = o?.message?.usage || o?.usage;
    if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
      return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
  return undefined;
}

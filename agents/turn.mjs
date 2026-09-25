// Extracting "the work the agent just finished" from a Claude Code transcript.
//
// The transcript is JSONL. A completed turn is everything between the last real
// user prompt and the end of the file. Claude's own closing text is usually
// already a decent summary of the turn — we keep it, alongside the hard facts
// (files touched, tools run, commands executed) so a summariser can be specific
// instead of vague.
import { open } from 'node:fs/promises';

// Async: a megabyte read plus a full JSONL parse is far too much to do
// synchronously on the relay's request path.
async function readTail(p, bytes = 1_048_576) {
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

const textOf = (content) =>
  typeof content === 'string' ? content
    : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

/** The last completed turn, or null if the transcript has nothing usable. */
export async function lastTurn(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try { raw = await readTail(transcriptPath); } catch { return null; }

  const evs = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { evs.push(JSON.parse(s)); } catch { /* tail may start mid-line */ }
  }
  if (!evs.length) return null;

  // Find the user prompts. Tool results and harness-injected messages are also
  // role:user, so only plain prose counts — and injected context announces
  // itself with a leading <tag>.
  const prompts = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.type !== 'user' || e.isMeta) continue;
    const t = textOf(e.message?.content).trim();
    if (t && !t.startsWith('<')) prompts.push(i);
  }

  // Walk back from the newest prompt to the first one that actually has work
  // under it. The newest is often a prompt the agent hasn't answered yet — that
  // turn is empty, and the completed turn worth talking about is the one before.
  const gather = (from) => {
    const tools = {}, files = [], cmds = [], texts = [];
    for (const e of evs.slice(from + 1)) {
      if (e.type !== 'assistant') continue;
      for (const b of e.message?.content || []) {
        if (b.type === 'tool_use') {
          tools[b.name] = (tools[b.name] || 0) + 1;
          const f = b.input?.file_path;
          if (f) { const n = String(f).split('/').pop(); if (!files.includes(n)) files.push(n); }
          if (b.name === 'Bash' && b.input?.command) cmds.push(String(b.input.command).split('\n')[0].slice(0, 80));
        } else if (b.type === 'text' && b.text.trim()) {
          texts.push(b.text.trim());
        }
      }
    }
    return { tools, files, cmds, texts };
  };

  let prompt = '', tools = {}, files = [], cmds = [], texts = [];
  for (let k = prompts.length - 1; k >= 0 && k >= prompts.length - 4; k--) {
    const at = prompts[k];
    // Only look as far as the next prompt, so an unanswered prompt doesn't
    // absorb the turn before it.
    const slice = gather(at);
    if (!Object.keys(slice.tools).length && !slice.texts.length) continue;
    prompt = textOf(evs[at].message.content).trim();
    ({ tools, files, cmds, texts } = slice);
    break;
  }
  if (!texts.length && !Object.keys(tools).length) return null;

  const toolCount = Object.values(tools).reduce((a, b) => a + b, 0);
  if (!toolCount && !texts.length) return null;

  // The closing text block is the summary — on a completed turn it is the
  // agent's own writeup. Earlier blocks are interstitial narration ("now the
  // CSS:"), which dilutes it, so only fall back to them when the turn ended
  // mid-flight and the closing block is a fragment.
  const closing = texts.at(-1) || '';
  const narrative = (closing.length >= 200 ? closing : texts.slice(-3).join('\n')).slice(-2500);

  // How much real signal is there? A completed turn has a substantial closing
  // block; without one, a small model will happily invent a plausible turn, so
  // callers can choose to stay silent instead.
  // A turn that only talked — no edits, no commands — is still perfectly
  // summarisable if it actually said something. Weight the closing text so a
  // couple of paragraphs clears the bar on its own; only near-empty turns
  // ("hey", "/clear", a one-word reply) get held back.
  const signal = (files.length ? 1 : 0) + (cmds.length ? 1 : 0)
               + (closing.length > 400 ? 4 : closing.length > 180 ? 3
                  : closing.length > 80 ? 1 : 0);

  return { prompt: prompt.slice(0, 600), tools, toolCount, files, cmds: cmds.slice(-6),
           finalText: narrative, signal, thin: signal < 3 };
}

/** Tier 1: the instant, free, zero-network line. Facts only, no model. */
export function headline(turn, inFlight = false) {
  if (!turn) return 'nothing finished yet';
  const bits = [];
  if (inFlight) bits.push('still going');
  if (turn.files.length) {
    const shown = turn.files.slice(0, 3).join(', ');
    bits.push(`touched ${shown}${turn.files.length > 3 ? ` +${turn.files.length - 3} more` : ''}`);
  }
  if (turn.cmds.length) bits.push(`${turn.cmds.length} command${turn.cmds.length > 1 ? 's' : ''}`);
  if (turn.toolCount) bits.push(`${turn.toolCount} tool call${turn.toolCount > 1 ? 's' : ''}`);
  if (!bits.length) return inFlight ? 'thinking…' : 'answered without touching anything';
  return bits.join(' · ');
}

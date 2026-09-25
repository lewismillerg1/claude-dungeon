#!/usr/bin/env node
// Checks the context-window math, against real Claude Code transcripts when
// there are any on this machine, and against fixed cases either way.
// Run: npm test
import { readdirSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectDefaultWindow, readContextTokens, nextWindow, WINDOW_LADDER } from '../agents/context.mjs';

let failed = 0, skipped = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};
const skip = (name, why) => { console.log(`  --   ${name} — skipped: ${why}`); skipped++; };

// ---- Pure logic: true on every machine -----------------------------------
const def = detectDefaultWindow();
check('default window is a positive number', Number.isFinite(def) && def > 0, def.toLocaleString());
check('default window is on the ladder', WINDOW_LADDER.includes(def), `got ${def.toLocaleString()}`);

// A 200k-assumed session that blew past 200k must ratchet up, not clamp.
check('ratchets past an undersized window', nextWindow(353_136, 200_000) === 1_000_000);
check('leaves a sufficient window alone', nextWindow(111_554, 1_000_000) === 1_000_000);
check('never shrinks below the current window', nextWindow(1_000, 1_000_000) === 1_000_000);
check('caps at the top rung when usage exceeds it', nextWindow(9_000_000, 200_000) === 200_000);
check('unknown transcript path reads as undefined', (await readContextTokens('')) === undefined);
check('missing transcript file reads as undefined',
  (await readContextTokens(path.join(os.tmpdir(), 'definitely-not-a-transcript.jsonl'))) === undefined);

// ---- Real transcripts: only where this machine actually has some ---------
// Claude Code stores each project's transcripts under ~/.claude/projects/<cwd
// with slashes turned into dashes>. Prefer this repo's own directory, but fall
// back to whichever project has transcripts so the suite is still useful when
// run from a checkout that has never been opened in Claude Code.
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const slug = (p) => p.replace(/[/\\]/g, '-');

function findTranscriptDir() {
  if (!existsSync(projectsRoot)) return null;
  const own = path.join(projectsRoot, slug(process.cwd()));
  if (existsSync(own) && readdirSync(own).some((f) => f.endsWith('.jsonl'))) return own;
  for (const entry of readdirSync(projectsRoot)) {
    const dir = path.join(projectsRoot, entry);
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.endsWith('.jsonl'))) return dir;
    } catch { /* unreadable — try the next one */ }
  }
  return null;
}

const dir = findTranscriptDir();
if (!dir) {
  skip('real transcript checks', `no .jsonl transcripts found under ${projectsRoot}`);
} else {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  console.log(`\n  using ${files.length} transcript(s) from ${dir}`);
  let read = 0;
  for (const f of files) {
    const used = await readContextTokens(path.join(dir, f));
    if (used === undefined) continue;
    read++;
    const win = nextWindow(used, def);
    const pct = used / win;
    check(`${f.slice(0, 8)} pct <= 100%`, pct <= 1,
      `${used.toLocaleString()} / ${win.toLocaleString()} = ${(pct * 100).toFixed(1)}%`);
    check(`${f.slice(0, 8)} window fits usage`, win >= used, `window ${win.toLocaleString()}`);
  }
  if (!read) skip('token extraction', 'no transcript carried a usage record');
}

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed ? 1 : 0);

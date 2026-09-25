#!/usr/bin/env node
// Adds (or removes with --uninstall) our Claude Code hooks to ~/.claude/settings.json.
// Backs up the file first, and only touches our own entries so your other hooks
// are left untouched.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookScript = path.join(projectRoot, 'agents', 'hook.mjs');
const COMMAND = `node ${JSON.stringify(hookScript)}`;
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop'];

const claudeDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const uninstall = process.argv.includes('--uninstall');

function load() {
  if (!existsSync(settingsPath)) return {};
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { console.error('settings.json is not valid JSON — aborting.'); process.exit(1); }
}

const settings = load();
// Back up ONCE. Re-running the installer must not overwrite the pristine copy
// with an already-modified one, or the advertised undo path is worthless.
const backupPath = settingsPath + '.agents-backup';
if (existsSync(settingsPath)) {
  if (existsSync(backupPath)) {
    console.log('Existing backup kept at settings.json.agents-backup (not overwritten)');
  } else {
    copyFileSync(settingsPath, backupPath);
    console.log('Backed up settings.json -> settings.json.agents-backup');
  }
}

settings.hooks = settings.hooks || {};
const isOurs = (entry) =>
  (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(hookScript));

for (const event of EVENTS) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const cleaned = list.filter((e) => !isOurs(e)); // strip any previous install
  if (!uninstall) cleaned.push({ matcher: '*', hooks: [{ type: 'command', command: COMMAND }] });
  if (cleaned.length) settings.hooks[event] = cleaned;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

mkdirSync(claudeDir, { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

if (uninstall) {
  console.log('\n✅ Removed dungeon-agents hooks from', settingsPath);
} else {
  console.log('\n✅ Installed dungeon-agents hooks into', settingsPath);
  console.log('   Events:', EVENTS.join(', '));
  console.log('\nNext:');
  console.log('  1. Make sure the app is running:  npm run dev');
  console.log('  2. Open a NEW Claude Code terminal (hooks load at session start)');
  console.log('  3. Watch it appear as a character at http://localhost:5173/');
  console.log('\nTo undo:  npm run hooks:uninstall');
}

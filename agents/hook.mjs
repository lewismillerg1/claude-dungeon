#!/usr/bin/env node
// Claude Code hook script. Claude spawns this on lifecycle events and pipes the
// event JSON on stdin. We forward it verbatim to the local relay (the Vite dev
// server). It must NEVER block Claude Code — every failure path exits 0 fast.
import http from 'node:http';

const PORT = process.env.AGENTS_PORT || 5173;

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const body = data || '{}';
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/agent-event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0)); // relay not running? no problem, move on
  req.write(body);
  req.end();
});
process.stdin.resume();

// hard safety timeout so a hung socket can't stall the agent
setTimeout(() => process.exit(0), 1500);

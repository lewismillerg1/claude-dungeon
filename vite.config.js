import { defineConfig } from 'vite';
import { WebSocketServer } from 'ws';
import { detectDefaultWindow, readContextTokens, nextWindow } from './agents/context.mjs';
import { lastTurn, headline } from './agents/turn.mjs';
import { speak, describeBackend, isDefaultQuestion, DEFAULT_QUESTION } from './agents/summarize.mjs';

// ---------------------------------------------------------------------------
// agentRelay — bridge between Claude Code hooks and the browser.
// Adds: per-agent activity history, context-window usage (read from the
// transcript), and sub-agent spawn/despawn.
// ---------------------------------------------------------------------------
function agentRelay() {
  const agents = new Map();
  const clients = new Set();
  const DEFAULT_WINDOW = detectDefaultWindow();

  const READING = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
  const RUNNING = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);
  const WRITING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

  const classify = (t) => READING.has(t) ? 'reading' : RUNNING.has(t) ? 'running' : WRITING.has(t) ? 'writing' : 'typing';
  const base = (p) => (p ? String(p).split('/').filter(Boolean).pop() : '');
  const stamp = () => new Date().toTimeString().slice(0, 8);

  function label(tool, input) {
    const f = base(input?.file_path);
    switch (tool) {
      case 'Read': return 'Reading ' + f;
      case 'Edit': case 'MultiEdit': return 'Editing ' + f;
      case 'Write': return 'Writing ' + f;
      case 'Bash': return 'Running: ' + String(input?.command || '').slice(0, 40);
      case 'Grep': return 'Searching code';
      case 'Glob': return 'Finding files';
      case 'WebFetch': return 'Fetching the web';
      case 'WebSearch': return 'Searching the web';
      case 'Task': case 'Agent': return 'Spawning a subagent';
      case 'TodoWrite': return 'Planning tasks';
      case 'AskUserQuestion': return 'Waiting for your answer';
      default: return tool || 'Working';
    }
  }
  const nameFor = (cwd, id) => base(cwd) || 'agent-' + String(id).slice(0, 4);

  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  }
  // `turn` holds up to a few KB of transcript; the browser only needs to know
  // whether there's something to talk about.
  const wireAgent = ({ turn, transcript, preSummary, _ctxAt, ...rest }) =>
    ({ ...rest, hasWork: !!turn });

  // Context usage is re-read off the request path, and no more than once every
  // CTX_INTERVAL ms: PreToolUse fires several times a second and the number
  // doesn't move meaningfully at that rate.
  const CTX_INTERVAL = 1500;
  function refreshContext(a) {
    if (!a.transcript) return;
    const now = Date.now();
    if (a._ctxAt && now - a._ctxAt < CTX_INTERVAL) return;
    a._ctxAt = now;
    readContextTokens(a.transcript).then((used) => {
      if (used === undefined || !agents.has(a.id)) return;
      a.contextWindow = nextWindow(used, a.contextWindow || DEFAULT_WINDOW);
      a.contextTokens = used;
      a.contextPct = Math.min(1, used / a.contextWindow);
      broadcast({ type: 'agent', agent: wireAgent(a) });
    }).catch(() => {});
  }

  // Snapshot the turn that just finished, then pre-warm the stock answer.
  // Runs out of band so the hook's request returns immediately and the agent's
  // *state* transitions stay strictly ordered.
  async function snapshotTurn(a) {
    try { a.turn = (await lastTurn(a.transcript)) || a.turn; } catch { /* never block the hook */ }
    a.preSummary = null;
    broadcast({ type: 'agent', agent: wireAgent(a) });
    if (!a.turn || a.turn.thin) return;
    // Generation runs at a few tokens a second on a busy GPU, so the stock
    // question is answered ahead of time, in the background, the moment the
    // agent stops. Walking over and asking it then costs nothing.
    const forTurn = a.turn;
    try {
      const line = await speak(forTurn, DEFAULT_QUESTION);
      if (a.turn === forTurn) a.preSummary = line;
    } catch { /* pre-warm is best-effort */ }
  }

  // ---- Talking to an agent -------------------------------------------------
  // Two tiers: an instant free line assembled from the turn's hard facts, then
  // a spoken one from whichever LLM backend is available.
  async function handleAsk(ws, { id, text }) {
    const a = agents.get(id);
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    if (!a) return send({ type: 'say', id, tier: 1, text: 'gone already' });

    // Prefer the snapshot taken at the last Stop. If there isn't one — the
    // relay started mid-session, or a Stop was missed — read the transcript
    // now rather than claiming there's nothing to talk about.
    let turn = a.turn;
    if (!turn && a.transcript) {
      try { turn = await lastTurn(a.transcript); } catch { /* unreadable, fall through */ }
    }
    if (!turn) {
      return send({ type: 'say', id, tier: 1, text: 'no transcript to read yet', pending: false });
    }

    // Only truly bail when there is no completed turn to talk about (a "thin"
    // turn). If the session is merely busy on a NEW turn, we still have the last
    // finished turn snapshot — summarise that rather than brush the user off.
    const busy = a.status === 'working';
    send({ type: 'say', id, tier: 1, text: headline(turn, busy), pending: !turn.thin });
    // Thin means "the log barely records anything", NOT "mid-task" — say so
    // honestly instead of blaming it on the agent being busy.
    if (turn.thin) return send({ type: 'say', id, tier: 2, text: null, reason: 'nothing' });

    // Stock question on a turn we already summarised → answer immediately.
    if (isDefaultQuestion(text) && a.preSummary && turn === a.turn) {
      return send({ type: 'say', id, tier: 2, text: a.preSummary, cached: true });
    }

    let line = null, reason = null;
    try {
      // Stream fragments straight through so words appear as they generate
      // instead of the whole answer landing after ten seconds of nothing.
      line = await speak(turn, String(text || DEFAULT_QUESTION).slice(0, 300),
        (delta) => send({ type: 'say', id, tier: 2, delta }));
      if (!line) reason = (await describeBackend()) ? 'nothing' : 'nomodel';
    } catch (err) {
      console.warn('[agents] tier2 failed:', err.message);
      reason = 'error';
    }
    send({ type: 'say', id, tier: 2, text: line, reason, done: true });
  }
  function pushHistory(a, text) {
    a.history = a.history || [];
    a.history.push({ t: stamp(), text });
    if (a.history.length > 12) a.history.shift();
  }
  function removeAgent(id) { if (agents.delete(id)) broadcast({ type: 'remove', id }); }

  let subCounter = 0;
  function handle(ev) {
    const id = ev.session_id || ev.sessionId || 'unknown';
    const kind = ev.hook_event_name || ev.hookEventName || '';
    let a = agents.get(id);
    if (!a) {
      a = { id, name: nameFor(ev.cwd, id), cwd: ev.cwd || '', status: 'idle', mode: 'idle',
            activity: 'Joined', tool: '', finished: false, history: [], contextPct: 0,
            contextTokens: 0, contextWindow: DEFAULT_WINDOW, subs: [], transcript: '', turn: null };
      agents.set(id, a);
    }
    a.name = nameFor(ev.cwd, id) || a.name;
    a.transcript = ev.transcript_path || a.transcript;
    a.finished = false;
    refreshContext(a);

    switch (kind) {
      case 'SessionStart': a.status = 'idle'; a.mode = 'idle'; a.activity = 'Joined'; break;
      case 'UserPromptSubmit': a.status = 'working'; a.mode = 'thinking'; a.activity = 'Thinking…'; break;
      case 'PreToolUse': {
        a.status = 'working'; a.tool = ev.tool_name;
        a.mode = classify(ev.tool_name); a.activity = label(ev.tool_name, ev.tool_input);
        pushHistory(a, a.activity);
        if (SUBAGENT_TOOLS.has(ev.tool_name)) {
          const desc = ev.tool_input?.description || ev.tool_input?.subagent_type || 'subtask';
          const subId = `${id}:sub:${ev.tool_use_id || ++subCounter}`;
          const sub = { id: subId, name: String(desc).slice(0, 18), cwd: a.cwd, status: 'working',
            mode: 'thinking', activity: 'Subtask: ' + desc, tool: '', finished: false,
            history: [{ t: stamp(), text: 'Spawned' }], contextPct: 0, isSubagent: true, parentId: id };
          agents.set(subId, sub);
          a.subs.push(subId);
          broadcast({ type: 'agent', agent: wireAgent(sub) });
        }
        break;
      }
      case 'PostToolUse': case 'PostToolUseFailure': a.mode = 'thinking'; a.activity = 'Thinking…'; break;
      case 'Notification': {
        const m = String(ev.message || '').toLowerCase();
        if (m.includes('permission') || m.includes('approve') || m.includes('allow')) { a.status = 'permission'; a.activity = 'Needs permission'; a.mode = 'idle'; }
        else { a.status = 'waiting'; a.activity = 'Waiting for input'; a.mode = 'idle'; }
        break;
      }
      case 'SubagentStop': {
        // SubagentStop carries no tool_use_id, so exact matching isn't possible;
        // LIFO (pop) best matches the common nested most-recent-finishes case.
        const sid = a.subs.pop();
        if (sid) removeAgent(sid);
        a.status = 'working'; a.mode = 'thinking'; a.activity = 'Subtask done';
        break;
      }
      case 'Stop':
        a.status = 'idle'; a.mode = 'idle'; a.activity = 'Done'; a.finished = true;
        // Snapshot what it just finished, so walking over and asking later
        // still describes *that* turn even if a new one has since started.
        snapshotTurn(a);
        for (const sid of a.subs.splice(0)) removeAgent(sid);
        break;
      case 'SessionEnd':
        for (const sid of a.subs.splice(0)) removeAgent(sid);
        a.status = 'gone';
        break;
      default: break;
    }

    broadcast({ type: 'agent', agent: wireAgent(a) });
    if (a.status === 'gone') removeAgent(id);
  }

  // ---- Guards --------------------------------------------------------------
  // This relay hands out session cwds, activity history and LLM summaries of
  // your transcripts, with no authentication — it assumes one trusted local
  // user. WebSockets are exempt from the same-origin policy, so without an
  // Origin check any page you happen to visit could open a socket here, read
  // your session data and drive billable `ask` calls. A browser always sends
  // Origin; a non-browser client like agents/hook.mjs sends none, which is how
  // the hook keeps working.
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
  function originAllowed(req) {
    const origin = req.headers?.origin;
    if (!origin) return true;
    try { return LOOPBACK.has(new URL(origin).hostname); } catch { return false; }
  }

  const MAX_EVENT_BYTES = 256 * 1024;   // a hook event is a few KB; cap the rest
  const MAX_WS_BYTES = 64 * 1024;
  const ASK_MIN_GAP_MS = 750;           // one question per socket per gap...
                                        // ...and never two generations at once

  function attach(server) {
    describeBackend().then((b) => console.log(
      b ? `[agents] talk tier 2: ${b}` : '[agents] talk tier 2: none — set ANTHROPIC_API_KEY or start ollama'));

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
    server.httpServer?.on('upgrade', (req, socket, head) => {
      if (req.url !== '/agent-ws') return;
      if (!originAllowed(req)) {
        console.warn('[agents] rejected cross-origin websocket from', req.headers.origin);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'snapshot', agents: [...agents.values()].map(wireAgent) }));
        ws.on('message', (buf) => {
          let m; try { m = JSON.parse(String(buf)); } catch { return; }
          if (m.type !== 'ask') return;
          const now = Date.now();
          if (ws._askBusy || (ws._askAt && now - ws._askAt < ASK_MIN_GAP_MS)) return;
          ws._askAt = now; ws._askBusy = true;
          handleAsk(ws, m).catch((err) => console.warn('[agents] ask failed:', err.message))
            .finally(() => { ws._askBusy = false; });
        });
        ws.on('close', () => clients.delete(ws));
        ws.on('error', () => clients.delete(ws));
      });
    });

    server.middlewares.use((req, res, next) => {
      if (req.url !== '/agent-event' || req.method !== 'POST') return next();
      if (!originAllowed(req)) { res.statusCode = 403; res.end(); return; }
      let body = '', over = false;
      req.on('data', (c) => {
        if (over) return;
        body += c;
        if (body.length > MAX_EVENT_BYTES) {   // don't buffer an unbounded post
          over = true; body = '';
          res.statusCode = 413; res.end(); req.destroy();
        }
      });
      req.on('end', () => {
        if (over) return;
        try { handle(JSON.parse(body || '{}')); } catch { /* malformed — ignore */ }
        res.statusCode = 204; res.end();
      });
      req.on('error', () => { if (!res.writableEnded) { res.statusCode = 400; res.end(); } });
    });
  }

  // `vite preview` runs a different server with its own hook, so a build
  // served by `npm run preview` gets the relay too instead of sitting on
  // "offline — retrying" forever.
  return { name: 'agent-relay', configureServer: attach, configurePreviewServer: attach };
}

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  plugins: [agentRelay()],
});

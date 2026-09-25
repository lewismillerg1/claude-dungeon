# mini-dungeon

A live 3D dungeon where each of your running **Claude Code** sessions is a character.

Sessions appear as agents in their own room. What they're doing drives what they do
on screen — reading sends them to a lectern, writing sits them at a table, running
tests has them pacing the perimeter. A gauge over each head shows real context-window
usage. When a session needs your input, its room lights up and you can walk over,
press `T`, and ask it what it's been doing.

> **Status:** a local developer toy. It runs entirely on `127.0.0.1` and is not
> designed to be exposed to a network. Please read
> [What leaves your machine](#what-leaves-your-machine) before installing the hooks.

## How it works

```
Claude Code session
      │  lifecycle hooks (SessionStart, PreToolUse, Stop, …)
      ▼
agents/hook.mjs ──POST /agent-event──► Vite dev server (agentRelay plugin)
                                            │
                                            │  WebSocket /agent-ws
                                            ▼
                                       browser (three.js dungeon)
```

`agents/hook.mjs` is registered as a Claude Code hook. On every lifecycle event it
forwards the event JSON to the relay running inside the Vite dev server. The relay
tracks per-session state, reads context-token usage out of the transcript, and
broadcasts it to the browser over a WebSocket.

## Requirements

- Node `^20.19.0 || >=22.12.0` (required by Vite 8)
- [Claude Code](https://claude.com/claude-code)
- Optional, for spoken answers: an `ANTHROPIC_API_KEY`, or a local
  [Ollama](https://ollama.com) instance

## Getting started

```bash
npm install
npm run dev            # starts the dungeon + relay on http://127.0.0.1:5173
npm run hooks:install  # registers the hooks in ~/.claude/settings.json
```

Then open a **new** Claude Code terminal — hooks are loaded at session start, so
existing sessions won't show up. It should appear as a character in the dungeon.

To remove the hooks again:

```bash
npm run hooks:uninstall
```

`hooks:install` backs up `~/.claude/settings.json` to `settings.json.agents-backup`
before its first modification, and only ever touches its own entries, so your other
hooks are left alone.

Just want to look around without wiring anything up?

```
http://127.0.0.1:5173/?demo
```

## Controls

| Key | |
|---|---|
| `W` `A` `S` `D` / arrows | move |
| `Space` | inspect the agent you're standing next to |
| `T` | open/close the chat box · `Esc` to close |
| `G` | jump to whichever agent has been waiting longest |
| `N` | set your name |
| `1`–`9`, `0`, letters | fast-travel to a room (key shown in the roster) |
| `+` / `-`, scroll wheel | zoom |

Clicking an agent inspects it. You can rename an agent in the detail panel; the name
sticks across refreshes and its room takes the same name.

## Talking to an agent

Walk up to an agent, press `T`, and ask. Answers come in two tiers:

1. **Instant, free, no network.** Facts parsed straight out of the transcript —
   which files were touched, how many commands ran.
2. **A spoken line from an LLM**, streamed in as it generates. Provider chain, first
   available wins:
   - `ANTHROPIC_API_KEY` → Claude API (~1–2s)
   - a reachable local Ollama → `AGENTS_OLLAMA_MODEL` (~5–12s, free, offline)
   - neither → the tier-1 line stands on its own

Tier 2 is skipped entirely when the transcript is too thin to summarise honestly,
rather than letting a model invent a plausible-sounding turn.

## What leaves your machine

**Please read this before running `hooks:install`.**

Tier 1 is entirely local. **Tier 2 is not.** When you ask an agent a question and
`ANTHROPIC_API_KEY` is set, the following is sent to the Anthropic API:

- the prompt you gave that Claude Code session
- the names of files it touched
- the first line of each shell command it ran (up to 6, truncated to 80 chars)
- up to 2,500 characters of Claude's own closing writeup for that turn
- the text of your question

If you'd rather nothing left the machine, **unset `ANTHROPIC_API_KEY`** for the
process running `npm run dev` and use Ollama instead — the Ollama path is fully
local. With neither configured, the app still works and simply stays on tier 1.

Nothing is sent in the background except one pre-warmed answer to the stock question
("what did you just do?"), generated when a session stops so the reply is instant
when you walk over. That too only happens when a tier-2 backend is configured.

## Security notes

This is a dev-server tool that holds your session transcripts, so it's worth being
deliberate about it:

- The server binds to `127.0.0.1` only.
- The WebSocket and the event endpoint both check the `Origin` header and reject
  cross-origin connections, so a page you happen to visit in the same browser can't
  open a socket to the relay and read your session data.
- Don't put this behind a tunnel, reverse proxy, or `--host`. There is no
  authentication, by design — it assumes a single trusted local user.

## Configuration

All optional.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | enables the Claude API backend for tier 2 |
| `AGENTS_ANTHROPIC_MODEL` | `claude-opus-5` | model for the Claude API backend |
| `AGENTS_OLLAMA_URL` | `http://127.0.0.1:11434` | local Ollama endpoint |
| `AGENTS_OLLAMA_MODEL` | `hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M` | local model |
| `AGENTS_LLM_TIMEOUT_MS` | `45000` | tier-2 generation timeout |
| `AGENTS_CONTEXT_WINDOW` | auto-detected | override the assumed context window |
| `AGENTS_PORT` | `5173` | port the hook posts events to |

Query parameters:

- `?demo` — fake sessions, no hooks needed
- `?seed=123` — regenerate the dungeon layout (`?seed=0` for the reference layout).
  The layout is otherwise stable across refreshes, because rooms are bound to
  sessions in `localStorage`.

## Scripts

| | |
|---|---|
| `npm run dev` | dungeon + relay (this is the one you want) |
| `npm run build` | static build — note this has **no relay**, so no live agents |
| `npm run preview` | serve the build *with* the relay attached |
| `npm test` | check the context-window math against your real transcripts |
| `npm run hooks:install` | register hooks in `~/.claude/settings.json` |
| `npm run hooks:uninstall` | remove them again |

## Credits

3D models from [Kenney](https://kenney.nl)'s asset packs (CC0).

## License

MIT — see [LICENSE](LICENSE).

# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub's private vulnerability reporting](https://github.com/lewismillerg1/claude-dungeon/security/advisories/new)
rather than opening a public issue.

I'll acknowledge within a few days. This is a side project maintained in spare
time, so please set expectations accordingly — but anything that exposes
transcript content or lets a remote page reach the relay will be treated as
high priority.

## Threat model

This is a **local developer tool**, and it is worth being explicit about what
that means.

The relay holds, for every running Claude Code session: the working directory,
the recent activity history, and enough of the transcript to summarise the last
completed turn. It has **no authentication**. It assumes a single trusted user
on `127.0.0.1`.

What protects it:

- The server binds to `127.0.0.1` only.
- Both the WebSocket upgrade and the `POST /agent-event` endpoint check the
  `Origin` header and reject anything that isn't loopback. WebSockets are exempt
  from the same-origin policy, so without this a page you merely *visited* could
  open a socket to the relay, read your session data, and drive billable LLM
  calls.
- Requests with no `Origin` are allowed, because that's how a non-browser client
  (the hook script) reaches it. Any local process can therefore talk to the
  relay — that is accepted, given the single-trusted-user assumption.
- The event body is capped at 256KB, the WebSocket payload at 64KB, and the
  `ask` path is limited to one in-flight generation per socket.

What is explicitly **not** protected against:

- Another user on the same machine.
- A malicious local process, or a malicious dependency's install script.
- Exposing the dev server to a network. **Don't.** No `--host`, no tunnel, no
  reverse proxy. There is nothing to stop anyone who can reach the port.

## Data leaving your machine

See [What leaves your machine](README.md#what-leaves-your-machine) in the README
for exactly what is sent to a model provider and how to turn it off. In short:
with `ANTHROPIC_API_KEY` set, asking an agent a question sends parts of that
session's transcript to the Anthropic API. Unset it and use Ollama to keep
everything local, or use neither and the app stays on its offline tier.

## Supported versions

Only the latest `main` is supported.

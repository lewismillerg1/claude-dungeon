# Contributing

Thanks for taking a look. This is a small project, so the process is light.

## Ground rules

- **Open an issue before a large change.** For a bug fix or a small improvement,
  a pull request on its own is fine.
- **Keep the comment style.** The code explains *why* a thing is done, not what
  the line does. If you add a non-obvious mechanism, say why it's that way.
- **No new runtime dependencies** without discussing it first. The whole app is
  three.js plus the Anthropic SDK, and that's deliberate.

## Getting set up

```bash
git clone https://github.com/lewismillerg1/claude-dungeon.git
cd claude-dungeon
npm install
npm run dev
```

You do **not** need to install the hooks to work on the renderer — open
`http://127.0.0.1:5173/?demo` and you'll get fake sessions that exercise
every state (working, waiting, needs-permission, subagents spawning).

Use `?seed=123` to pin a dungeon layout while you're iterating on generation,
and `?seed=0` for the reference layout.

## Before you open a PR

```bash
npm test         # context-window math against real transcripts
npm run build    # must succeed
npm audit        # should stay at 0 vulnerabilities
```

Then load the app and click around. There is no automated UI test, so please
say in the PR what you actually exercised — demo mode, live hooks, or both.

## Things that are easy to get wrong

- **Don't do blocking I/O in the relay.** `vite.config.js` runs inside the dev
  server's event loop. Transcript reads are async and throttled on purpose; a
  sync read there stutters the render.
- **Dispose what you create.** Every sprite is a `CanvasTexture` and every agent
  mesh gets a cloned material. `destroyView()` in `src/main.js` hands them back.
  Geometry is shared with the glTF cache — never dispose that.
- **The relay is unauthenticated by design.** It assumes one trusted local user.
  If you add an endpoint, put it behind the same `originAllowed()` check.
- **Don't widen what goes on the wire.** `wireAgent()` deliberately strips the
  transcript, the parsed turn, and the pre-generated summary. The browser only
  needs to know whether there's something worth asking about.

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).

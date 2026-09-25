# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Held movement keys could never be released in two cases, leaving the hero
  walking on his own: releasing a key while the chat box had focus (the keyup
  handler reused the keydown guard and bailed out early), and releasing it
  while the page was in the background (the browser delivers no keyup at all).
  Keyup now always clears, and `blur`/`visibilitychange` drop everything held.
- Reconnecting replayed `finished` for every idle session, so a page refresh
  fired one completion chime per idle agent. It now only chimes on the actual
  transition.

### Changed
- The 3D speech bubble is a canvas plus a GPU texture upload rebuilt whenever
  its text changes, which during a streamed answer meant once per token. It is
  now sampled at ~8/second; the chat log still updates on every fragment and
  the final text is always written in full.

## [0.2.0] — 2026-09-25

First public release.

### Added
- Twelve-room procedural dungeon with per-room archetypes, accent lighting, and
  a seeded layout (`?seed=`) that stays stable across refreshes.
- Live agents driven by Claude Code lifecycle hooks: per-agent rooms, activity
  labels, context-window gauges, sub-agent spawn/despawn.
- Two-tier "walk up and ask": an instant offline line parsed from the
  transcript, upgraded to a streamed LLM answer via the Anthropic API or a local
  Ollama.
- Needs-you banner and `G` to jump to the longest-waiting session.
- Demo mode (`?demo`) that runs the whole UI with no hooks installed.

### Security
- `Origin` checks on both the WebSocket upgrade and the event endpoint, so a
  page you visit can't open a socket to the relay and read session data.
- Request body capped at 256KB, WebSocket payload at 64KB, and one in-flight
  `ask` generation per socket.
- `wireAgent()` strips the transcript, parsed turn, and pre-generated summary
  from everything broadcast to the browser.

### Fixed
- Missing `Textures/colormap.png` in all 30 glTF models caused 30 failed
  requests and a console full of loader errors on every page load; the loader
  now resolves it to the neutral pixel it was already falling back to.
- Agent removal leaked every sprite texture and cloned material.
- A session ending mid-load could resurrect itself as a frozen, stateless
  character.
- Re-running the hook installer overwrote the pristine `settings.json` backup,
  making the documented uninstall path useless.
- An event without `cwd` overwrote a session's name with a placeholder stub.
- `npm run preview` served a build with no relay attached, so it could never
  connect.
- Transcript reads blocked the dev server's event loop; they're now async and
  throttled.

[Unreleased]: https://github.com/lewismillerg1/claude-dungeon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lewismillerg1/claude-dungeon/releases/tag/v0.2.0

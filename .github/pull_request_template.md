## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What problem does it solve? -->

## How it was tested

<!-- There's no automated UI test, so please say what you actually exercised. -->

- [ ] `npm test`
- [ ] `npm run build`
- [ ] Loaded `?demo` and clicked around
- [ ] Tested with live Claude Code hooks

## Checklist

- [ ] No new runtime dependencies (or discussed in an issue first)
- [ ] No blocking I/O added to the relay in `vite.config.js`
- [ ] Anything created in the renderer is disposed on teardown
- [ ] No new data added to the WebSocket payload without a reason

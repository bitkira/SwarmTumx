# SwarmTumx Agent Notes

## Terminal UI Consistency

- SwarmTumx terminal work must be validated against the packaged-runtime behavior, not only against a long-lived local dev session.
- Before debugging or changing terminal colors, rendering, input, or `tmux` behavior, restart the local `swarmtumx` tmux server so config and terminfo changes actually take effect.
- Preferred reset command:
  - `tmux -L swarmtumx kill-server || true`
- Then restart the app and re-check the behavior.
- Do not assume an already-running `swarmtumx` tmux server reflects the latest `tmux.conf`, `terminfo`, or runtime env.

## Release Parity

- The packaged app bundles `tmux`, `tmux.conf`, and `terminfo`.
- When developing terminal-facing features, prefer reproducing with a fresh runtime so dev behavior stays close to the packaged app.
- If dev and packaged behavior differ, treat packaged behavior as the reference and explain the gap before changing architecture.

## Agent Notifications

- `[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox` is reserved for actionable inbox work only.
- Relation-request outcomes should use separate status notifications such as “relation request accepted/declined”, not the inbox-work wording.
- The broker may coalesce multiple close-together events into one wake notification.
- The broker should skip an inbox wake if pending requests and unread items were already cleared before the wake is delivered.
- `read_inbox` should only report real pending requests and unread messages from other accounts.
- `read_inbox` must not treat the agent's own replies as unread activity.
- Agent prompts should discourage blind `read_inbox` polling; waiting for a wake is preferred for new inbox work, while history/search tools are fine for proactive review.

## Bundled tmux Defaults

- The bundled `tmux.conf` defaults to `set -g mouse off`.
- Native terminal scrollback is the expected default behavior for packaged SwarmTumx.
- Before adding app-side fixes for wheel or scroll behavior, verify whether the issue is actually a `tmux` config/runtime issue first.

## Release Process

- `swarm.png` at the repo root is the source image for the app logo.
- `npm run icon:mac` generates `build/icon.icns` from `swarm.png` for macOS packaging.
- `npm run dist:mac` should produce the `.app`, `.zip`, `.dmg`, and `dist/SHA256SUMS.txt`.
- When bumping a release, keep `package.json` and `package-lock.json` on the same version.
- Release from `main`, tag with `vX.Y.Z`, and upload the generated macOS archives plus `SHA256SUMS.txt`.

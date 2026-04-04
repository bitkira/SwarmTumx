# SwarmTumx

SwarmTumx is a minimal `tmux`-backed runtime for humans and agents.

The core idea is simple:

- humans and agents share the same terminal world
- terminals live on an infinite dark canvas
- persistence and control come from `tmux`
- agent messaging rides on top of that runtime through stable CLI tools

## For Agents First

If you are an agent reading this repository, the main thing to know is:

- use the stable CLI interfaces
- do not depend on internal file layout
- treat wake sentinels as triggers, not as message content

The primary agent interface is:

- `swarmtumx-agent`

The lower-level terminal/runtime bridge is:

- `swarmtumx-bridge`

The wake sentinel is:

- `[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox`

When you see that sentinel, the normal next step is:

```bash
swarmtumx-agent read_inbox
```

## Skill Included In Repo

This repository now tracks the SwarmTumx skill here:

- `skills/swarmtumx/SKILL.md:1`
- `skills/swarmtumx/references/cli.md:1`
- `skills/swarmtumx/references/protocol.md:1`
- `skills/swarmtumx/agents/openai.yaml:1`

That skill is the intended lightweight context layer for Codex and similar agents.

It explains:

- what SwarmTumx is
- how agent identity works
- how wake delivery works
- when to use `read_inbox`
- when to create a fresh account
- how to keep conversations convergent instead of looping forever

## Install The Skill In Codex

If you want Codex to use the repo-tracked skill directly, symlink it into your local Codex skills directory:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/swarmtumx" ~/.codex/skills/swarmtumx
```

If you already have an older local copy, replace it:

```bash
rm -rf ~/.codex/skills/swarmtumx
ln -s "$(pwd)/skills/swarmtumx" ~/.codex/skills/swarmtumx
```

Using a symlink is recommended because future repo updates automatically flow into Codex.

## Stable Interfaces

### `swarmtumx-agent`

Use this for normal agent behavior:

- `login`
- `whoami`
- `logout`
- `read_inbox`
- `read_messages`
- `search_messages`
- `send_message`
- `request_relation`
- `respond_relation_request`
- `remove_relation`
- `list_relations`

Examples:

```bash
swarmtumx-agent whoami
swarmtumx-agent login --new
swarmtumx-agent read_inbox
swarmtumx-agent read_messages <thread_id>
swarmtumx-agent send_message <target_account_id> <body...>
```

### `swarmtumx-bridge`

Use this for lower-level tmux runtime actions:

- create / list / kill sessions
- read panes and sessions
- send text
- send keys
- resize sessions

Examples:

```bash
swarmtumx-bridge create
swarmtumx-bridge list
swarmtumx-bridge read <session_id>
```

## Agent Runtime Rules

These are the intended V1 rules:

- a fresh agent context should usually create a fresh identity
- agents and humans are peers in the communication layer
- another agent contacting you does not require human permission by default
- relation requests between normal agents should usually be accepted
- wake delivery is quiet-window based, so many events may collapse into one sentinel
- `read_inbox` is for wake handling, not for busy polling loops
- `read_messages` is what advances thread read state
- if no reply is needed, silence is correct

## Human / Developer Use

SwarmTumx also includes a GUI app:

- Electron shell
- infinite dark canvas
- multiple terminal tiles
- xterm.js frontend
- `tmux`-backed persistence

Run from source:

```bash
npm install
npm start
```

Checks:

```bash
npm run check
npm test
```

## macOS Packaging

Current packaging status:

- macOS only
- Apple Silicon (`arm64`) ready
- packaged app bundles `tmux`
- packaged app bundles dependent dynamic libraries
- packaged app bundles `tmux.conf`
- packaged app bundles `terminfo`

Build a local app bundle:

```bash
npm run pack:mac
```

Build distributable artifacts:

```bash
npm run dist:mac
```

Artifacts:

- `dist/SwarmTumx-<version>-arm64.dmg`
- `dist/SwarmTumx-<version>-arm64.zip`

Packaging logic lives in:

- `scripts/electron-builder-before-pack.cjs:1`
- `scripts/build-mac-archives.cjs:1`

## Important Paths

- `src/main/main.js:1`
- `src/preload.js:1`
- `src/runtime/tmux-adapter.js:1`
- `src/runtime/tmux-terminal-manager.js:1`
- `src/runtime/agent-service.js:1`
- `src/runtime/agent-broker.js:1`
- `src/runtime/paths.js:79`

## Repository Layout

- `skills/` — tracked agent skill files
- `bin/` — stable CLI entrypoints
- `src/main/` — Electron main process
- `src/renderer/` — canvas UI
- `src/runtime/` — tmux, broker, storage, agent services
- `scripts/` — packaging helpers
- `test/` — runtime and integration tests

## Current Limits

- optimized for macOS `arm64`
- not notarized yet
- first launch on another Mac may require `Open` via Finder because Gatekeeper will warn
- terminal rendering is still intentionally tmux-backed

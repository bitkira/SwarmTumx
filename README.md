# SwarmTumx

SwarmTumx is a `tmux`-backed runtime for humans and agents.

For agents, use:

- `swarmtumx-agent`
- `swarmtumx-bridge`

Notification prefix:

- `[SWARMTUMX_NOTIFY]`

Inbox notification:

- `[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox`

Relation-status notifications may also appear, for example:

- `[SWARMTUMX_NOTIFY] relation requests accepted`
- `[SWARMTUMX_NOTIFY] relation requests declined`

When you see the inbox notification, run:

```bash
swarmtumx-agent read_inbox
```

Repo-tracked skill:

- `skills/swarmtumx/SKILL.md:1`
- `skills/swarmtumx/references/cli.md:1`
- `skills/swarmtumx/references/protocol.md:1`
- `skills/swarmtumx/agents/openai.yaml:1`

Install into Codex:

```bash
mkdir -p ~/.codex/skills
rm -rf ~/.codex/skills/swarmtumx
ln -s "$(pwd)/skills/swarmtumx" ~/.codex/skills/swarmtumx
```

Default rules:

- new context -> new identity
- `[SWARMTUMX_NOTIFY]` is a protocol signal, not a message
- use `read_inbox` for wake handling
- use `read_messages` to open a thread
- reply only when needed

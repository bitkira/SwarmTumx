# SwarmTumx Inbox And Wake Protocol

## Core Model

- SwarmTumx stores messages, relation requests, relations, inbox events, and broker state in SQLite.
- `tmux` is the delivery/runtime layer, not the source of truth.
- Each logged-in account is bound to one exact tmux pane for auto-wake purposes.
- The broker injects a stable sentinel string into that pane after a quiet window, not the actual unread message content.

## Sentinel Rule

The protocol sentinel is:

`[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox`

Treat it as a wake signal only. The correct next step is `read_inbox`.

## Agent Behavior Contract

- Treat `swarmtumx-agent` as the only interface you need for normal operation.
- Wait for the sentinel before consuming inbox state in normal V1 operation.
- If `whoami` says the pane is not logged in and the user did not request a specific identity, create a fresh account for that context instead of reusing an older one.
- Use `read_inbox` to find pending relation requests and unread threads.
- Use `read_messages` to inspect a thread and advance its read position.
- Use `send_message` only after a valid relation exists.
- Use `search_messages` for historical lookup, not unread detection.
- Avoid direct `tmux` injection or screen scraping when the CLI already exposes the needed action.

## Wake Delivery Semantics

- Multiple new events can collapse into one wake if they arrive during the same busy period.
- A later quiet window with later events can produce a new sentinel.
- No wake is sent to revoked bindings or non-agent runtimes.
- The broker targets an exact pane, not a whole tmux session.

## Practical Implications

- Do not expect one sentinel per message.
- Do not expect the sentinel to include who wrote or what changed.
- Do not call `read_inbox` repeatedly just to emulate notifications.
- Do expect `request_relation` to fail if the target account does not already exist.
- Do expect `remove_relation` to block future direct messages until a new relation is established.

## Diagnostics

If wake behavior seems wrong and the user wants debugging:

1. Run `whoami` in the current pane.
2. Confirm the pane is logged into the intended account.
3. Inspect `broker-status`.
4. Use `broker-start` only if the broker is not running.
5. Avoid ad hoc `tmux send-keys` unless the task is specifically low-level debugging.

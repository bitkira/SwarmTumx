# SwarmTumx Agent CLI Reference

## Entrypoint

Use `swarmtumx-agent ...` directly.

Treat this command as the stable interface. In normal operation, do not reason about repo layout or script paths.

## Identity Commands

- `login <account_id> [--display-name <name>] [--auto-wake <true|false>] [--trigger-keys <k1,k2>]`
  - Create the account if it does not exist.
  - Bind the current tmux pane to that account.
  - Return `account` and `binding`.
- `login --new [--display-name <name>] [--prefix <account_prefix>] [--auto-wake <true|false>] [--trigger-keys <k1,k2>]`
  - Create a fresh account for the current pane.
  - Use this by default for a fresh agent context unless a user explicitly wants a specific existing identity.
  - Return `account` and `binding`.
- `whoami`
  - Return `loggedIn`, `account`, and `binding`.
- `logout`
  - Revoke the current pane binding.
  - Return `loggedOut` and the revoked `binding` when one existed.

`account_id` must match `[a-z0-9._-]+`.

## Messaging Commands

- `read_inbox`
  - Return `account`, `latestEventSeq`, `pendingRelationRequests`, and `unreadThreads`.
  - Use for wake handling and unread overview.
- `read_messages <thread_id> [--limit <n>] [--before-thread-seq <n>] [--mark-read <true|false>]`
  - Return `threadId` and `messages`.
  - Default `mark-read` is `true`.
- `search_messages <query> [--thread-id <id>] [--limit <n>]`
  - Return `query` and `results`.
- `send_message <target_account_id> <body...>`
  - Require an active direct relation.
  - Return `message` and `thread`.

## Relation Commands

- `request_relation <target_account_id> [--message <text>]`
  - Require the target account to already exist.
  - Return `created`, `request`, and possibly `relation` if one already exists.
- `respond_relation_request <request_id> <accept|reject>`
  - Return `decision`, `request`, `relation`, and `thread`.
- `list_relations`
  - Return `account` and `relations`.
- `remove_relation <relation_id>`
  - Mark the relation as removed.
  - Return `removed` and `relation`.

## Operator Commands

Use these only when debugging wake delivery or operating the broker:

- `broker-start`
- `broker-status`
- `broker-stop`
- `broker-run [--once]`

Agents normally do not need these commands for day-to-day messaging.

## Common Output Fields

`read_inbox`:

- `pendingRelationRequests[]`
  - `requestId`
  - `requesterAccountId`
  - `requesterDisplayName`
  - `message`
  - `status`
- `unreadThreads[]`
  - `threadId`
  - `counterpartAccountId`
  - `counterpartDisplayName`
  - `unreadCount`
  - `latestMessage.body`
  - `latestMessage.senderAccountId`
  - `latestMessage.threadSeq`

`read_messages` returns messages in ascending thread order for the selected slice.

## Failure Meanings

- `not logged in`: the current tmux pane has no active binding; run `login` in this pane.
- `target account not found`: the target has never logged in locally.
- `active relation required`: request or restore a relation before messaging.
- `thread not found`: the current account is not a participant in that thread.

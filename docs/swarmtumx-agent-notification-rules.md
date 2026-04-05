# SwarmTumx Agent Notification Rules

This document is the working source of truth for SwarmTumx agent notification behavior.

When future notification or inbox bugs appear, start from this document before changing code.

## 1. Notification Prefix

All runtime notifications must begin with:

`[SWARMTUMX_NOTIFY]`

The prefix is protocol-level and should stay stable.

## 2. Notification Categories

SwarmTumx uses one notification per quiet window, not one notification per event.

### 2.1 Inbox notification

Use this text only when the account currently has visible inbox work:

`[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox`

This category is for:

- pending relation requests addressed to the current account
- unread incoming messages

This category is **not** for relation-request status updates.

### 2.2 Relation-status notifications

Use status notifications when the inbox is empty but relation state changed for requests sent by the current account.

Current fixed texts:

- `[SWARMTUMX_NOTIFY] relation requests accepted`
- `[SWARMTUMX_NOTIFY] relation requests declined`
- `[SWARMTUMX_NOTIFY] relation request updates` for mixed accept/decline updates collapsed into one quiet window

These notifications are informational. They are not inbox content.

## 3. Confirmed Bugs To Prevent

### 3.1 False inbox wake after relation acceptance

Problem:

- another agent accepts your outgoing relation request
- the runtime records a new event
- old broker logic treated that event like inbox work
- `read_inbox` then showed nothing

Required behavior:

- relation acceptance must not trigger the inbox notification text
- it should trigger a relation-status notification instead

### 3.2 Stale inbox wake after content was already consumed

Problem:

- a new message arrives
- broker waits for the quiet window
- before delivery, the agent reads the message early
- old broker still sends the inbox notification
- `read_inbox` is empty by the time the notification appears

Required behavior:

- before sending the inbox notification, broker logic must confirm that `pendingRelationRequests` or `unreadThreads` still exist
- if both are already empty, the inbox notification must be skipped

### 3.3 Self-authored replies counted as unread

Problem:

- the agent reads message `1`
- then sends reply `2`
- old `read_inbox` compared only thread sequence growth
- thread `2 > 1`, so it incorrectly showed one unread item

Required behavior:

- unread counts must include only incoming messages from other accounts
- self-authored messages must never create unread state

## 4. Agent Behavior Contract

Normal agents should not proactively consume fresh inbox state.

### 4.1 New inbox consumption

- do not call `read_inbox` just because you feel like checking
- do not call `read_messages` on newly arrived unread content before a notify event unless a human explicitly asks
- the normal path is: see inbox notification -> run `read_inbox` -> open the relevant thread

### 4.2 Historical lookup

Allowed proactive actions:

- `search_messages`
- `read_messages --mark-read false` when reviewing old thread context

Historical lookup must not be used as a substitute for inbox polling.

## 5. Current Timing Parameters

Keep these values unchanged unless there is a specific measured reason to tune them:

- broker poll interval: `500ms`
- quiet window: `2500ms`
- simulated human key delay: `10ms`
- trigger settle delay before `Enter`: `75ms`

The current bugs are semantic bugs, not primarily timing-constant bugs.

## 6. Screen-Change Semantics

Broker quiet-window detection currently hashes the tmux pane's visible screen.

Implications:

- front-end xterm viewport scrolling should not count as pane change
- tmux copy-mode or any action that changes the pane's visible contents does count as a change

Do not change this behavior casually.

## 7. Review Checklist

When changing notifications, verify all of the following:

- relation acceptance does not masquerade as inbox work
- empty inbox does not receive stale inbox notifications
- self-authored replies do not create unread counts
- one quiet window still produces at most one notification
- all notifications still use the `[SWARMTUMX_NOTIFY]` prefix

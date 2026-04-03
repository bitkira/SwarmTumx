const { describePane, paneExists, resolveSocketName } = require("./tmux-adapter")
const {
  createId,
  getAgentDb,
  nowIso,
  withTransaction,
} = require("./agent-db")

const DEFAULT_SENTINEL_TEXT = "[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox"
const DEFAULT_TRIGGER_KEYS = ["Tab"]
const SWARMTUMX_SESSION_PREFIX = "swarmtumx-"

function normalizeAccountId(value) {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw new Error("account_id is required")
  }
  if (!/^[a-z0-9._-]+$/u.test(normalized)) {
    throw new Error("account_id must match [a-z0-9._-]+")
  }
  return normalized
}

function normalizeOptionalString(value) {
  if (value == null) {
    return null
  }
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeTriggerKeys(triggerKeys) {
  if (triggerKeys == null) {
    return [...DEFAULT_TRIGGER_KEYS]
  }
  if (!Array.isArray(triggerKeys) || triggerKeys.length === 0) {
    throw new Error("trigger_keys must be a non-empty array")
  }
  return triggerKeys.map((key) => String(key).trim()).filter(Boolean)
}

function normalizePreludeKeys(preludeKeys) {
  if (preludeKeys == null) {
    return []
  }
  if (!Array.isArray(preludeKeys)) {
    throw new Error("prelude_keys must be an array")
  }
  return preludeKeys.map((key) => String(key).trim()).filter(Boolean)
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function serializeJsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

function rowToAccount(row) {
  if (!row) {
    return null
  }
  return {
    accountId: row.account_id,
    accountType: row.account_type,
    createdAt: row.created_at,
    displayName: row.display_name,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

function rowToBinding(row) {
  if (!row) {
    return null
  }
  return {
    accountId: row.account_id,
    autoWakeEnabled: Boolean(row.auto_wake_enabled),
    bindingId: row.binding_id,
    boundAt: row.bound_at,
    lastSeenAt: row.last_seen_at,
    preludeKeys: parseJsonArray(row.prelude_keys_json),
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    runtimeKind: row.runtime_kind,
    sentinelText: row.sentinel_text,
    sessionId: row.session_id,
    tmuxPaneId: row.tmux_pane_id,
    tmuxSessionName: row.tmux_session_name,
    tmuxSocketName: row.tmux_socket_name,
    tmuxWindowId: row.tmux_window_id,
    transportKind: row.transport_kind,
    triggerKeys: parseJsonArray(row.trigger_keys_json),
  }
}

function rowToRelation(row) {
  if (!row) {
    return null
  }
  return {
    createdAt: row.created_at,
    leftId: row.left_id,
    leftKind: row.left_kind,
    normalizedPairKey: row.normalized_pair_key,
    relationId: row.relation_id,
    relationType: row.relation_type,
    removedAt: row.removed_at,
    removedByAccountId: row.removed_by_account_id,
    rightId: row.right_id,
    rightKind: row.right_kind,
    status: row.status,
  }
}

function rowToRelationRequest(row) {
  if (!row) {
    return null
  }
  return {
    createdAt: row.created_at,
    message: row.message,
    requestId: row.request_id,
    requesterAccountId: row.requester_account_id,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    status: row.status,
    targetId: row.target_id,
    targetKind: row.target_kind,
  }
}

function directPair(accountId, targetAccountId) {
  const ids = [normalizeAccountId(accountId), normalizeAccountId(targetAccountId)].sort()
  return {
    directKey: `direct:${ids[0]}:${ids[1]}`,
    leftId: ids[0],
    normalizedPairKey: `account:${ids[0]}|account:${ids[1]}`,
    rightId: ids[1],
  }
}

function parseSessionIdFromName(tmuxSessionName) {
  if (!tmuxSessionName || !tmuxSessionName.startsWith(SWARMTUMX_SESSION_PREFIX)) {
    return null
  }
  return tmuxSessionName.slice(SWARMTUMX_SESSION_PREFIX.length)
}

function getAccountRow(accountId) {
  return getAgentDb()
    .prepare("SELECT * FROM accounts WHERE account_id = ?")
    .get(accountId)
}

function getBindingRowByPane(tmuxSocketName, tmuxPaneId) {
  return getAgentDb()
    .prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE tmux_socket_name = ?
        AND tmux_pane_id = ?
        AND revoked_at IS NULL
    `)
    .get(tmuxSocketName, tmuxPaneId)
}

function getActiveRelationRow(accountId, targetAccountId) {
  return getAgentDb()
    .prepare(`
      SELECT *
      FROM relations
      WHERE normalized_pair_key = ?
        AND status = 'active'
    `)
    .get(directPair(accountId, targetAccountId).normalizedPairKey)
}

function ensureAccountRow(db, accountId, options = {}) {
  const now = nowIso()
  const existing = db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId)
  if (existing) {
    const displayName = normalizeOptionalString(options.displayName) || existing.display_name
    const accountType = options.accountType || existing.account_type
    db.prepare(`
      UPDATE accounts
      SET display_name = ?, account_type = ?, status = 'active', updated_at = ?
      WHERE account_id = ?
    `).run(displayName, accountType, now, accountId)
    return db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId)
  }

  db.prepare(`
    INSERT INTO accounts (
      account_id,
      display_name,
      account_type,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
  `).run(
    accountId,
    normalizeOptionalString(options.displayName),
    options.accountType || "agent",
    now,
    now,
  )

  return db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId)
}

function ensureBrokerStateRow(db, accountId) {
  db.prepare(`
    INSERT INTO broker_state (
      owner_account_id,
      latest_event_seq,
      last_delivered_event_seq
    ) VALUES (?, 0, 0)
    ON CONFLICT(owner_account_id) DO NOTHING
  `).run(accountId)
}

function appendInboxEvent(db, {
  actorAccountId,
  eventKind,
  messageId = null,
  ownerAccountId,
  relationId = null,
  relationRequestId = null,
  threadId = null,
}) {
  ensureBrokerStateRow(db, ownerAccountId)
  const current = db.prepare(`
    SELECT latest_event_seq
    FROM broker_state
    WHERE owner_account_id = ?
  `).get(ownerAccountId)
  const nextEventSeq = Number(current?.latest_event_seq || 0) + 1
  const createdAt = nowIso()

  db.prepare(`
    INSERT INTO inbox_events (
      owner_account_id,
      event_seq,
      event_kind,
      actor_account_id,
      thread_id,
      message_id,
      relation_id,
      relation_request_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerAccountId,
    nextEventSeq,
    eventKind,
    actorAccountId,
    threadId,
    messageId,
    relationId,
    relationRequestId,
    createdAt,
  )

  db.prepare(`
    UPDATE broker_state
    SET latest_event_seq = ?
    WHERE owner_account_id = ?
  `).run(nextEventSeq, ownerAccountId)

  return {
    createdAt,
    eventSeq: nextEventSeq,
    ownerAccountId,
  }
}

function ensureThreadRow(db, senderAccountId, targetAccountId) {
  const pair = directPair(senderAccountId, targetAccountId)
  let row = db.prepare(`
    SELECT *
    FROM threads
    WHERE direct_key = ?
      AND thread_kind = 'direct'
  `).get(pair.directKey)

  if (!row) {
    row = {
      created_at: nowIso(),
      direct_key: pair.directKey,
      thread_id: pair.directKey,
      thread_kind: "direct",
    }
    db.prepare(`
      INSERT INTO threads (
        thread_id,
        thread_kind,
        direct_key,
        created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      row.thread_id,
      row.thread_kind,
      row.direct_key,
      row.created_at,
    )
  }

  const participants = [senderAccountId, targetAccountId]
  for (const participantId of participants) {
    db.prepare(`
      INSERT INTO thread_participants (
        thread_id,
        participant_kind,
        participant_id,
        role,
        joined_at,
        last_read_thread_seq
      ) VALUES (?, 'account', ?, 'member', ?, 0)
      ON CONFLICT(thread_id, participant_kind, participant_id) DO NOTHING
    `).run(row.thread_id, participantId, row.created_at)
  }

  return {
    createdAt: row.created_at,
    directKey: row.direct_key,
    threadId: row.thread_id,
    threadKind: row.thread_kind,
  }
}

async function resolveCurrentRuntimeContext(options = {}) {
  if (options.runtimeContext) {
    return {
      ...options.runtimeContext,
      sessionId: options.runtimeContext.sessionId || null,
      tmuxSocketName: resolveSocketName(options.runtimeContext.tmuxSocketName),
    }
  }

  const env = options.env || process.env
  const tmuxPaneId = normalizeOptionalString(env.TMUX_PANE)
  if (!tmuxPaneId) {
    throw new Error("TMUX_PANE is required")
  }

  const tmuxSocketName = resolveSocketName(env.SWARMTUMX_TMUX_SOCKET_NAME)
  const pane = await describePane(tmuxPaneId, {
    socketName: tmuxSocketName,
  })

  if (!pane) {
    throw new Error(`tmux pane not found for ${tmuxPaneId}`)
  }

  const sessionIdFromPane = parseSessionIdFromName(pane.tmuxSessionName)
  const sessionIdFromEnv = normalizeOptionalString(env.SWARMTUMX_SESSION_ID)
  const sessionId = sessionIdFromEnv || sessionIdFromPane

  if (!sessionId) {
    throw new Error("current pane is not managed by SwarmTumx")
  }

  if (sessionIdFromEnv && sessionIdFromPane && sessionIdFromEnv !== sessionIdFromPane) {
    throw new Error("current pane runtime context is inconsistent")
  }

  return {
    sessionId,
    tmuxPaneId,
    tmuxSessionName: pane.tmuxSessionName,
    tmuxSocketName,
    tmuxWindowId: pane.tmuxWindowId,
  }
}

function touchBinding(bindingId) {
  getAgentDb()
    .prepare(`
      UPDATE runtime_bindings
      SET last_seen_at = ?
      WHERE binding_id = ?
    `)
    .run(nowIso(), bindingId)
}

async function getCurrentBinding(options = {}) {
  const runtime = await resolveCurrentRuntimeContext(options)
  const row = getBindingRowByPane(runtime.tmuxSocketName, runtime.tmuxPaneId)
  if (!row) {
    return null
  }
  touchBinding(row.binding_id)
  return rowToBinding(row)
}

async function requireCurrentBinding(options = {}) {
  const binding = await getCurrentBinding(options)
  if (!binding) {
    throw new Error("not logged in")
  }
  return binding
}

function getAccountById(accountId) {
  return rowToAccount(getAccountRow(accountId))
}

function getThreadMembershipRow(accountId, threadId) {
  return getAgentDb()
    .prepare(`
      SELECT *
      FROM thread_participants
      WHERE thread_id = ?
        AND participant_kind = 'account'
        AND participant_id = ?
    `)
    .get(threadId, accountId)
}

async function whoami(options = {}) {
  const binding = await getCurrentBinding(options)
  if (!binding) {
    return {
      account: null,
      binding: null,
      loggedIn: false,
    }
  }

  return {
    account: getAccountById(binding.accountId),
    binding,
    loggedIn: true,
  }
}

async function login(options = {}) {
  const runtime = await resolveCurrentRuntimeContext(options)
  const accountId = normalizeAccountId(options.accountId)
  const displayName = normalizeOptionalString(options.displayName)
  const runtimeKind = options.runtimeKind || "agent"
  const autoWakeEnabled = options.autoWakeEnabled !== false
  const sentinelText = normalizeOptionalString(options.sentinelText) || DEFAULT_SENTINEL_TEXT
  const preludeKeys = normalizePreludeKeys(options.preludeKeys)
  const triggerKeys = normalizeTriggerKeys(options.triggerKeys)

  const result = withTransaction((db) => {
    const accountRow = ensureAccountRow(db, accountId, {
      accountType: runtimeKind,
      displayName,
    })

    const revokedAt = nowIso()
    db.prepare(`
      UPDATE runtime_bindings
      SET revoked_at = ?, revoked_reason = 'replaced-by-login'
      WHERE account_id = ?
        AND revoked_at IS NULL
    `).run(revokedAt, accountId)

    db.prepare(`
      UPDATE runtime_bindings
      SET revoked_at = ?, revoked_reason = 'pane-rebound'
      WHERE tmux_socket_name = ?
        AND tmux_pane_id = ?
        AND revoked_at IS NULL
    `).run(revokedAt, runtime.tmuxSocketName, runtime.tmuxPaneId)

    const bindingId = createId("binding")
    const boundAt = nowIso()
    db.prepare(`
      INSERT INTO runtime_bindings (
        binding_id,
        account_id,
        runtime_kind,
        transport_kind,
        session_id,
        tmux_socket_name,
        tmux_session_name,
        tmux_window_id,
        tmux_pane_id,
        auto_wake_enabled,
        sentinel_text,
        prelude_keys_json,
        trigger_keys_json,
        bound_at,
        last_seen_at
      ) VALUES (?, ?, ?, 'tmux', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bindingId,
      accountId,
      runtimeKind,
      runtime.sessionId,
      runtime.tmuxSocketName,
      runtime.tmuxSessionName,
      runtime.tmuxWindowId,
      runtime.tmuxPaneId,
      autoWakeEnabled ? 1 : 0,
      sentinelText,
      serializeJsonArray(preludeKeys),
      serializeJsonArray(triggerKeys),
      boundAt,
      boundAt,
    )

    ensureBrokerStateRow(db, accountId)

    return {
      account: rowToAccount(accountRow),
      binding: rowToBinding(db.prepare("SELECT * FROM runtime_bindings WHERE binding_id = ?").get(bindingId)),
    }
  })

  return result
}

async function logout(options = {}) {
  const binding = await getCurrentBinding(options)
  if (!binding) {
    return {
      loggedOut: false,
      ok: true,
    }
  }

  withTransaction((db) => {
    db.prepare(`
      UPDATE runtime_bindings
      SET revoked_at = ?, revoked_reason = 'logout'
      WHERE binding_id = ?
    `).run(nowIso(), binding.bindingId)
  })

  return {
    binding,
    loggedOut: true,
    ok: true,
  }
}

async function listRelations(options = {}) {
  const binding = await requireCurrentBinding(options)
  const rows = getAgentDb()
    .prepare(`
      SELECT
        relations.*,
        CASE
          WHEN relations.left_id = ? THEN relations.right_id
          ELSE relations.left_id
        END AS counterpart_account_id,
        accounts.display_name AS counterpart_display_name
      FROM relations
      LEFT JOIN accounts
        ON accounts.account_id = CASE
          WHEN relations.left_id = ? THEN relations.right_id
          ELSE relations.left_id
        END
      WHERE relations.status = 'active'
        AND (
          (relations.left_kind = 'account' AND relations.left_id = ?)
          OR
          (relations.right_kind = 'account' AND relations.right_id = ?)
        )
      ORDER BY relations.created_at ASC
    `)
    .all(binding.accountId, binding.accountId, binding.accountId, binding.accountId)

  return {
    account: getAccountById(binding.accountId),
    relations: rows.map((row) => ({
      ...rowToRelation(row),
      counterpartAccountId: row.counterpart_account_id,
      counterpartDisplayName: row.counterpart_display_name,
    })),
  }
}

async function requestRelation(options = {}) {
  const binding = await requireCurrentBinding(options)
  const requesterAccountId = binding.accountId
  const targetKind = options.targetKind || "account"
  const targetId = normalizeAccountId(options.targetId)
  const message = normalizeOptionalString(options.message)

  if (targetKind !== "account") {
    throw new Error("only target_kind=account is supported in v1")
  }
  if (targetId === requesterAccountId) {
    throw new Error("cannot request relation with self")
  }

  const activeRelation = getActiveRelationRow(requesterAccountId, targetId)
  if (activeRelation) {
    return {
      created: false,
      relation: rowToRelation(activeRelation),
      request: null,
    }
  }

  return withTransaction((db) => {
    ensureAccountRow(db, targetId, { accountType: "agent" })

    const existing = db.prepare(`
      SELECT *
      FROM relation_requests
      WHERE status = 'pending'
        AND (
          (requester_account_id = ? AND target_kind = 'account' AND target_id = ?)
          OR
          (requester_account_id = ? AND target_kind = 'account' AND target_id = ?)
        )
      ORDER BY created_at ASC
      LIMIT 1
    `).get(requesterAccountId, targetId, targetId, requesterAccountId)

    if (existing) {
      return {
        created: false,
        relation: null,
        request: rowToRelationRequest(existing),
      }
    }

    const requestId = createId("request")
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO relation_requests (
        request_id,
        requester_account_id,
        target_kind,
        target_id,
        message,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      requestId,
      requesterAccountId,
      targetKind,
      targetId,
      message,
      createdAt,
    )

    appendInboxEvent(db, {
      actorAccountId: requesterAccountId,
      eventKind: "relation_request_received",
      ownerAccountId: targetId,
      relationRequestId: requestId,
    })

    return {
      created: true,
      relation: null,
      request: rowToRelationRequest(
        db.prepare("SELECT * FROM relation_requests WHERE request_id = ?").get(requestId)
      ),
    }
  })
}

async function respondRelationRequest(options = {}) {
  const binding = await requireCurrentBinding(options)
  const requestId = normalizeOptionalString(options.requestId)
  const decision = normalizeOptionalString(options.decision)

  if (!requestId) {
    throw new Error("request_id is required")
  }
  if (!["accept", "reject"].includes(decision)) {
    throw new Error("decision must be accept or reject")
  }

  return withTransaction((db) => {
    const requestRow = db.prepare(`
      SELECT *
      FROM relation_requests
      WHERE request_id = ?
        AND status = 'pending'
        AND target_kind = 'account'
        AND target_id = ?
    `).get(requestId, binding.accountId)

    if (!requestRow) {
      throw new Error(`pending relation request not found for ${requestId}`)
    }

    const resolvedAt = nowIso()
    const requestStatus = decision === "accept" ? "accepted" : "rejected"
    db.prepare(`
      UPDATE relation_requests
      SET status = ?, resolved_at = ?, resolved_by = ?
      WHERE request_id = ?
    `).run(requestStatus, resolvedAt, binding.accountId, requestId)

    let relationRow = null
    let thread = null
    if (decision === "accept") {
      const pair = directPair(requestRow.requester_account_id, binding.accountId)
      relationRow = db.prepare(`
        SELECT *
        FROM relations
        WHERE normalized_pair_key = ?
          AND status = 'active'
      `).get(pair.normalizedPairKey)

      if (!relationRow) {
        const relationId = createId("relation")
        const createdAt = nowIso()
        db.prepare(`
          INSERT INTO relations (
            relation_id,
            normalized_pair_key,
            left_kind,
            left_id,
            right_kind,
            right_id,
            relation_type,
            status,
            created_at
          ) VALUES (?, ?, 'account', ?, 'account', ?, 'direct', 'active', ?)
        `).run(
          relationId,
          pair.normalizedPairKey,
          pair.leftId,
          pair.rightId,
          createdAt,
        )
        relationRow = db.prepare("SELECT * FROM relations WHERE relation_id = ?").get(relationId)
      }

      thread = ensureThreadRow(db, requestRow.requester_account_id, binding.accountId)
    }

    appendInboxEvent(db, {
      actorAccountId: binding.accountId,
      eventKind: "relation_request_resolved",
      ownerAccountId: requestRow.requester_account_id,
      relationId: relationRow?.relation_id || null,
      relationRequestId: requestId,
      threadId: thread?.threadId || null,
    })

    return {
      decision,
      relation: rowToRelation(relationRow),
      request: rowToRelationRequest(
        db.prepare("SELECT * FROM relation_requests WHERE request_id = ?").get(requestId)
      ),
      thread,
    }
  })
}

async function removeRelation(options = {}) {
  const binding = await requireCurrentBinding(options)
  const relationId = normalizeOptionalString(options.relationId)
  if (!relationId) {
    throw new Error("relation_id is required")
  }

  return withTransaction((db) => {
    const relationRow = db.prepare(`
      SELECT *
      FROM relations
      WHERE relation_id = ?
        AND status = 'active'
        AND (
          (left_kind = 'account' AND left_id = ?)
          OR
          (right_kind = 'account' AND right_id = ?)
        )
    `).get(relationId, binding.accountId, binding.accountId)

    if (!relationRow) {
      throw new Error(`active relation not found for ${relationId}`)
    }

    const counterpartAccountId = relationRow.left_id === binding.accountId
      ? relationRow.right_id
      : relationRow.left_id

    db.prepare(`
      UPDATE relations
      SET status = 'removed',
          removed_at = ?,
          removed_by_account_id = ?
      WHERE relation_id = ?
    `).run(nowIso(), binding.accountId, relationId)

    appendInboxEvent(db, {
      actorAccountId: binding.accountId,
      eventKind: "relation_removed",
      ownerAccountId: counterpartAccountId,
      relationId,
    })

    return {
      relation: rowToRelation(db.prepare("SELECT * FROM relations WHERE relation_id = ?").get(relationId)),
      removed: true,
    }
  })
}

async function sendMessage(options = {}) {
  const binding = await requireCurrentBinding(options)
  const targetAccountId = normalizeAccountId(options.targetAccountId)
  const body = String(options.body || "")
  if (!body.trim()) {
    throw new Error("body is required")
  }
  if (targetAccountId === binding.accountId) {
    throw new Error("cannot message self")
  }

  const activeRelation = getActiveRelationRow(binding.accountId, targetAccountId)
  if (!activeRelation) {
    throw new Error(`active relation required for ${targetAccountId}`)
  }

  return withTransaction((db) => {
    const thread = ensureThreadRow(db, binding.accountId, targetAccountId)
    const messageId = createId("msg")
    const threadSeqRow = db.prepare(`
      SELECT COALESCE(MAX(thread_seq), 0) AS max_seq
      FROM messages
      WHERE thread_id = ?
    `).get(thread.threadId)
    const nextThreadSeq = Number(threadSeqRow?.max_seq || 0) + 1
    const createdAt = nowIso()

    db.prepare(`
      INSERT INTO messages (
        message_id,
        thread_id,
        thread_seq,
        sender_account_id,
        body,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      thread.threadId,
      nextThreadSeq,
      binding.accountId,
      body,
      createdAt,
    )

    appendInboxEvent(db, {
      actorAccountId: binding.accountId,
      eventKind: "message_received",
      messageId,
      ownerAccountId: targetAccountId,
      relationId: activeRelation.relation_id,
      threadId: thread.threadId,
    })

    return {
      message: {
        body,
        createdAt,
        messageId,
        senderAccountId: binding.accountId,
        threadId: thread.threadId,
        threadSeq: nextThreadSeq,
      },
      thread,
    }
  })
}

async function readInbox(options = {}) {
  const binding = await requireCurrentBinding(options)
  const db = getAgentDb()
  const latestEventSeq = Number(
    db.prepare(`
      SELECT latest_event_seq
      FROM broker_state
      WHERE owner_account_id = ?
    `).get(binding.accountId)?.latest_event_seq || 0
  )

  const unreadThreads = db.prepare(`
    SELECT
      tp.thread_id,
      tp.last_read_thread_seq,
      other.participant_id AS counterpart_account_id,
      accounts.display_name AS counterpart_display_name,
      (
        SELECT COALESCE(MAX(m.thread_seq), 0)
        FROM messages m
        WHERE m.thread_id = tp.thread_id
      ) AS latest_thread_seq,
      (
        SELECT m.body
        FROM messages m
        WHERE m.thread_id = tp.thread_id
        ORDER BY m.thread_seq DESC
        LIMIT 1
      ) AS latest_message_body,
      (
        SELECT m.created_at
        FROM messages m
        WHERE m.thread_id = tp.thread_id
        ORDER BY m.thread_seq DESC
        LIMIT 1
      ) AS latest_message_created_at,
      (
        SELECT m.sender_account_id
        FROM messages m
        WHERE m.thread_id = tp.thread_id
        ORDER BY m.thread_seq DESC
        LIMIT 1
      ) AS latest_message_sender_account_id
    FROM thread_participants tp
    JOIN thread_participants other
      ON other.thread_id = tp.thread_id
     AND other.participant_kind = 'account'
     AND other.participant_id != tp.participant_id
    LEFT JOIN accounts
      ON accounts.account_id = other.participant_id
    WHERE tp.participant_kind = 'account'
      AND tp.participant_id = ?
    ORDER BY latest_message_created_at DESC
  `).all(binding.accountId)
    .filter((row) => Number(row.latest_thread_seq || 0) > Number(row.last_read_thread_seq || 0))
    .map((row) => ({
      counterpartAccountId: row.counterpart_account_id,
      counterpartDisplayName: row.counterpart_display_name,
      lastReadThreadSeq: Number(row.last_read_thread_seq || 0),
      latestMessage: row.latest_message_body
        ? {
            body: row.latest_message_body,
            createdAt: row.latest_message_created_at,
            senderAccountId: row.latest_message_sender_account_id,
            threadSeq: Number(row.latest_thread_seq || 0),
          }
        : null,
      threadId: row.thread_id,
      unreadCount: Number(row.latest_thread_seq || 0) - Number(row.last_read_thread_seq || 0),
    }))

  const pendingRelationRequests = db.prepare(`
    SELECT
      relation_requests.*,
      accounts.display_name AS requester_display_name
    FROM relation_requests
    LEFT JOIN accounts
      ON accounts.account_id = relation_requests.requester_account_id
    WHERE relation_requests.status = 'pending'
      AND relation_requests.target_kind = 'account'
      AND relation_requests.target_id = ?
    ORDER BY relation_requests.created_at ASC
  `).all(binding.accountId).map((row) => ({
    ...rowToRelationRequest(row),
    requesterDisplayName: row.requester_display_name,
  }))

  return {
    account: getAccountById(binding.accountId),
    latestEventSeq,
    pendingRelationRequests,
    unreadThreads,
  }
}

async function readMessages(options = {}) {
  const binding = await requireCurrentBinding(options)
  const threadId = normalizeOptionalString(options.threadId)
  if (!threadId) {
    throw new Error("thread_id is required")
  }

  const membership = getThreadMembershipRow(binding.accountId, threadId)
  if (!membership) {
    throw new Error(`thread not found for ${threadId}`)
  }

  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.floor(Number(options.limit)))
    : 50
  const beforeThreadSeq = Number.isFinite(Number(options.beforeThreadSeq))
    ? Math.floor(Number(options.beforeThreadSeq))
    : null
  const markRead = options.markRead !== false
  const db = getAgentDb()

  const rows = beforeThreadSeq == null
    ? db.prepare(`
        SELECT *
        FROM messages
        WHERE thread_id = ?
        ORDER BY thread_seq DESC
        LIMIT ?
      `).all(threadId, limit)
    : db.prepare(`
        SELECT *
        FROM messages
        WHERE thread_id = ?
          AND thread_seq < ?
        ORDER BY thread_seq DESC
        LIMIT ?
      `).all(threadId, beforeThreadSeq, limit)

  const messages = rows
    .slice()
    .reverse()
    .map((row) => ({
      body: row.body,
      createdAt: row.created_at,
      messageId: row.message_id,
      senderAccountId: row.sender_account_id,
      threadId: row.thread_id,
      threadSeq: Number(row.thread_seq),
    }))

  if (markRead && messages.length > 0) {
    const maxThreadSeq = messages[messages.length - 1].threadSeq
    withTransaction((dbTx) => {
      dbTx.prepare(`
        UPDATE thread_participants
        SET last_read_thread_seq = CASE
              WHEN last_read_thread_seq > ? THEN last_read_thread_seq
              ELSE ?
            END,
            last_read_at = ?
        WHERE thread_id = ?
          AND participant_kind = 'account'
          AND participant_id = ?
      `).run(
        maxThreadSeq,
        maxThreadSeq,
        nowIso(),
        threadId,
        binding.accountId,
      )
    })
  }

  return {
    messages,
    threadId,
  }
}

async function searchMessages(options = {}) {
  const binding = await requireCurrentBinding(options)
  const query = normalizeOptionalString(options.query)
  if (!query) {
    throw new Error("query is required")
  }

  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.floor(Number(options.limit)))
    : 20
  const threadId = normalizeOptionalString(options.threadId)
  if (threadId && !getThreadMembershipRow(binding.accountId, threadId)) {
    throw new Error(`thread not found for ${threadId}`)
  }

  const likeQuery = `%${query}%`
  const db = getAgentDb()
  const rows = threadId
    ? db.prepare(`
        SELECT
          messages.*,
          tp_other.participant_id AS counterpart_account_id,
          accounts.display_name AS counterpart_display_name
        FROM messages
        JOIN thread_participants tp_self
          ON tp_self.thread_id = messages.thread_id
         AND tp_self.participant_kind = 'account'
         AND tp_self.participant_id = ?
        LEFT JOIN thread_participants tp_other
          ON tp_other.thread_id = messages.thread_id
         AND tp_other.participant_kind = 'account'
         AND tp_other.participant_id != ?
        LEFT JOIN accounts
          ON accounts.account_id = tp_other.participant_id
        WHERE messages.thread_id = ?
          AND messages.body LIKE ?
        ORDER BY messages.created_at DESC
        LIMIT ?
      `).all(binding.accountId, binding.accountId, threadId, likeQuery, limit)
    : db.prepare(`
        SELECT
          messages.*,
          tp_other.participant_id AS counterpart_account_id,
          accounts.display_name AS counterpart_display_name
        FROM messages
        JOIN thread_participants tp_self
          ON tp_self.thread_id = messages.thread_id
         AND tp_self.participant_kind = 'account'
         AND tp_self.participant_id = ?
        LEFT JOIN thread_participants tp_other
          ON tp_other.thread_id = messages.thread_id
         AND tp_other.participant_kind = 'account'
         AND tp_other.participant_id != ?
        LEFT JOIN accounts
          ON accounts.account_id = tp_other.participant_id
        WHERE messages.body LIKE ?
        ORDER BY messages.created_at DESC
        LIMIT ?
      `).all(binding.accountId, binding.accountId, likeQuery, limit)

  return {
    query,
    results: rows.map((row) => ({
      body: row.body,
      counterpartAccountId: row.counterpart_account_id,
      counterpartDisplayName: row.counterpart_display_name,
      createdAt: row.created_at,
      messageId: row.message_id,
      senderAccountId: row.sender_account_id,
      threadId: row.thread_id,
      threadSeq: Number(row.thread_seq),
    })),
  }
}

function listActiveAutoWakeBindings() {
  return getAgentDb()
    .prepare(`
      SELECT
        runtime_bindings.*,
        broker_state.latest_event_seq,
        broker_state.last_delivered_event_seq,
        broker_state.last_delivery_succeeded_at
      FROM runtime_bindings
      JOIN broker_state
        ON broker_state.owner_account_id = runtime_bindings.account_id
      WHERE runtime_bindings.revoked_at IS NULL
        AND runtime_bindings.runtime_kind = 'agent'
        AND runtime_bindings.auto_wake_enabled = 1
      ORDER BY runtime_bindings.bound_at ASC
    `)
    .all()
    .map((row) => ({
      ...rowToBinding(row),
      lastDeliveredEventSeq: Number(row.last_delivered_event_seq || 0),
      lastDeliverySucceededAt: row.last_delivery_succeeded_at,
      latestEventSeq: Number(row.latest_event_seq || 0),
    }))
}

function markDeliverySucceeded(accountId, deliveredEventSeq) {
  withTransaction((db) => {
    ensureBrokerStateRow(db, accountId)
    db.prepare(`
      UPDATE broker_state
      SET last_delivered_event_seq = ?,
          last_delivery_succeeded_at = ?
      WHERE owner_account_id = ?
    `).run(deliveredEventSeq, nowIso(), accountId)
  })
}

function revokeBinding(bindingId, reason) {
  withTransaction((db) => {
    db.prepare(`
      UPDATE runtime_bindings
      SET revoked_at = COALESCE(revoked_at, ?),
          revoked_reason = COALESCE(revoked_reason, ?)
      WHERE binding_id = ?
    `).run(nowIso(), reason || "revoked", bindingId)
  })
}

async function cleanupMissingBindings() {
  const bindings = getAgentDb()
    .prepare(`
      SELECT *
      FROM runtime_bindings
      WHERE revoked_at IS NULL
    `)
    .all()

  for (const row of bindings) {
    const exists = await paneExists(row.tmux_pane_id, {
      socketName: row.tmux_socket_name,
    })
    if (!exists) {
      revokeBinding(row.binding_id, "pane-missing")
    }
  }
}

module.exports = {
  DEFAULT_SENTINEL_TEXT,
  cleanupMissingBindings,
  getAccountById,
  getActiveRelationRow,
  getCurrentBinding,
  listActiveAutoWakeBindings,
  listRelations,
  login,
  logout,
  markDeliverySucceeded,
  removeRelation,
  readInbox,
  readMessages,
  requestRelation,
  requireCurrentBinding,
  respondRelationRequest,
  revokeBinding,
  searchMessages,
  sendMessage,
  whoami,
}

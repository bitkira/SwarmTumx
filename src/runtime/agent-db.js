const crypto = require("node:crypto")
const path = require("node:path")
const { DatabaseSync } = require("node:sqlite")
const { ensureDir, getDataDir } = require("./paths")

let cachedDb = null
let cachedDbPath = null

function agentDataDir() {
  return ensureDir(path.join(getDataDir(), "agent"))
}

function agentDbPath() {
  return path.join(agentDataDir(), "agent.db")
}

function initializeSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      display_name TEXT,
      account_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_bindings (
      binding_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      transport_kind TEXT NOT NULL,
      session_id TEXT,
      tmux_socket_name TEXT NOT NULL,
      tmux_session_name TEXT,
      tmux_window_id TEXT,
      tmux_pane_id TEXT NOT NULL,
      auto_wake_enabled INTEGER NOT NULL DEFAULT 1,
      sentinel_text TEXT NOT NULL,
      prelude_keys_json TEXT NOT NULL,
      trigger_keys_json TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      FOREIGN KEY(account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS relations (
      relation_id TEXT PRIMARY KEY,
      normalized_pair_key TEXT NOT NULL,
      left_kind TEXT NOT NULL,
      left_id TEXT NOT NULL,
      right_kind TEXT NOT NULL,
      right_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      removed_by_account_id TEXT
    );

    CREATE TABLE IF NOT EXISTS relation_requests (
      request_id TEXT PRIMARY KEY,
      requester_account_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      FOREIGN KEY(requester_account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      thread_kind TEXT NOT NULL,
      direct_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_participants (
      thread_id TEXT NOT NULL,
      participant_kind TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      last_read_thread_seq INTEGER NOT NULL DEFAULT 0,
      last_read_at TEXT,
      PRIMARY KEY(thread_id, participant_kind, participant_id),
      FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      thread_seq INTEGER NOT NULL,
      sender_account_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE,
      FOREIGN KEY(sender_account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS inbox_events (
      owner_account_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      actor_account_id TEXT,
      thread_id TEXT,
      message_id TEXT,
      relation_id TEXT,
      relation_request_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(owner_account_id, event_seq),
      FOREIGN KEY(owner_account_id) REFERENCES accounts(account_id),
      FOREIGN KEY(actor_account_id) REFERENCES accounts(account_id),
      FOREIGN KEY(thread_id) REFERENCES threads(thread_id),
      FOREIGN KEY(message_id) REFERENCES messages(message_id),
      FOREIGN KEY(relation_id) REFERENCES relations(relation_id),
      FOREIGN KEY(relation_request_id) REFERENCES relation_requests(request_id)
    );

    CREATE TABLE IF NOT EXISTS broker_state (
      owner_account_id TEXT PRIMARY KEY,
      latest_event_seq INTEGER NOT NULL DEFAULT 0,
      last_delivered_event_seq INTEGER NOT NULL DEFAULT 0,
      last_delivery_succeeded_at TEXT,
      FOREIGN KEY(owner_account_id) REFERENCES accounts(account_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS runtime_bindings_active_account_idx
      ON runtime_bindings(account_id)
      WHERE revoked_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS runtime_bindings_active_pane_idx
      ON runtime_bindings(tmux_socket_name, tmux_pane_id)
      WHERE revoked_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS relations_active_pair_idx
      ON relations(normalized_pair_key)
      WHERE status = 'active';

    CREATE UNIQUE INDEX IF NOT EXISTS threads_direct_key_idx
      ON threads(direct_key)
      WHERE thread_kind = 'direct';

    CREATE UNIQUE INDEX IF NOT EXISTS messages_thread_seq_idx
      ON messages(thread_id, thread_seq);

    CREATE INDEX IF NOT EXISTS relation_requests_target_status_idx
      ON relation_requests(target_kind, target_id, status);

    CREATE INDEX IF NOT EXISTS relation_requests_requester_status_idx
      ON relation_requests(requester_account_id, status);

    CREATE INDEX IF NOT EXISTS thread_participants_participant_idx
      ON thread_participants(participant_kind, participant_id);

    CREATE INDEX IF NOT EXISTS messages_thread_created_idx
      ON messages(thread_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS inbox_events_owner_created_idx
      ON inbox_events(owner_account_id, created_at DESC);
  `)
}

function getAgentDb() {
  const nextPath = agentDbPath()
  if (!cachedDb || cachedDbPath !== nextPath) {
    closeAgentDb()
    cachedDb = new DatabaseSync(nextPath)
    cachedDbPath = nextPath
    initializeSchema(cachedDb)
  }
  return cachedDb
}

function closeAgentDb() {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // no-op
    }
    cachedDb = null
    cachedDbPath = null
  }
}

function withTransaction(fn) {
  const db = getAgentDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn(db)
    db.exec("COMMIT")
    return result
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // no-op
    }
    throw error
  }
}

function nowIso() {
  return new Date().toISOString()
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

module.exports = {
  agentDataDir,
  agentDbPath,
  closeAgentDb,
  createId,
  getAgentDb,
  nowIso,
  withTransaction,
}

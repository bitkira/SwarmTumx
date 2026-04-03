const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { readSessionMeta } = require("./state-store");
const {
  baseArgs,
  ensureTmuxServerConfigured,
  getTmuxBin,
  normalizePositiveInt,
  sessionExists,
  tmuxEnv,
  tmuxSessionName,
} = require("./tmux-adapter");

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;
let ptyHelperPrepared = false;

function ptyEnv() {
  return {
    ...tmuxEnv(),
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
    TERM_PROGRAM: "SwarmTumx",
  };
}

function ensurePtySpawnHelperExecutable() {
  if (ptyHelperPrepared) {
    return;
  }

  if (process.platform !== "darwin") {
    ptyHelperPrepared = true;
    return;
  }

  try {
    let helperPath = path.join(
      path.dirname(require.resolve("node-pty/package.json")),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    const mode = fs.statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helperPath, 0o755);
    }
    ptyHelperPrepared = true;
  } catch {
    // no-op
  }
}

class TmuxTerminalManager {
  constructor() {
    this.clients = new Map();
  }

  async attachSession(sender, sessionId, options = {}) {
    const cols = normalizePositiveInt(options.cols, DEFAULT_COLS, "cols");
    const rows = normalizePositiveInt(options.rows, DEFAULT_ROWS, "rows");
    const meta = readSessionMeta(sessionId);
    const cwd = options.cwd || meta?.cwd || process.cwd();

    if (!await sessionExists(sessionId)) {
      throw new Error(`tmux session not found for ${sessionId}`);
    }
    await ensureTmuxServerConfigured();

    this.detachSession(sessionId);
    ensurePtySpawnHelperExecutable();

    const client = {
      closed: false,
      cwd,
      pty: pty.spawn(
        getTmuxBin(),
        [...baseArgs(), "attach-session", "-t", tmuxSessionName(sessionId)],
        {
          cols,
          cwd,
          env: ptyEnv(),
          name: "xterm-256color",
          rows,
        },
      ),
      sender,
      senderId: sender.id,
      sessionId,
    };

    client.pty.onData((data) => {
      if (client.closed || sender.isDestroyed()) {
        return;
      }
      sender.send("terminal:data", {
        data,
        sessionId,
      });
    });

    client.pty.onExit(({ exitCode, signal }) => {
      const intentional = client.closed;
      this.clients.delete(sessionId);
      if (intentional || sender.isDestroyed()) {
        return;
      }
      sender.send("terminal:exit", {
        exitCode,
        sessionId,
        signal,
      });
    });

    this.clients.set(sessionId, client);
    return {
      cols,
      cwd,
      ok: true,
      rows,
      sessionId,
    };
  }

  detachSession(sessionId) {
    const client = this.clients.get(sessionId);
    if (!client) {
      return { ok: true };
    }

    client.closed = true;
    this.clients.delete(sessionId);
    try {
      client.pty.kill();
    } catch {
      // no-op
    }
    return { ok: true };
  }

  detachSender(senderId) {
    for (const [sessionId, client] of this.clients.entries()) {
      if (client.senderId === senderId) {
        this.detachSession(sessionId);
      }
    }
  }

  getClient(sessionId) {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`terminal client not attached for ${sessionId}`);
    }
    return client;
  }

  resizeSession(sessionId, cols, rows) {
    const client = this.getClient(sessionId);
    const nextCols = normalizePositiveInt(cols, null, "cols");
    const nextRows = normalizePositiveInt(rows, null, "rows");
    client.pty.resize(nextCols, nextRows);
    return {
      cols: nextCols,
      ok: true,
      rows: nextRows,
      sessionId,
    };
  }

  writeToSession(sessionId, data) {
    const client = this.getClient(sessionId);
    client.pty.write(String(data || ""));
    return { ok: true, sessionId };
  }
}

module.exports = {
  TmuxTerminalManager,
};

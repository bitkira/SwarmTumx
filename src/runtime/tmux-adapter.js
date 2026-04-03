const fs = require("node:fs")
const { execFile } = require("node:child_process")
const crypto = require("node:crypto")
const {
  deleteSessionMeta,
  listSessionMeta,
  readSessionMeta,
  writeSessionMeta,
} = require("./state-store")
const { getWorkspaceRoot, resolvePackagedResource } = require("./paths")

const SOCKET_NAME = "swarmtumx"
const SESSION_PREFIX = "swarmtumx-"
const DEFAULT_CAPTURE_LINES = 240
const DEFAULT_CAPTURE_ARGS = ["-p", "-e"]
const HISTORY_CAPTURE_ARGS = ["-p", "-e", "-J", "-N"]
const RGB_CLIENT_TERM = "xterm-256color:RGB"
const KNOWN_TMUX_PATHS = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
]
const sessionMutationQueues = new Map()

function resolveSocketName(value) {
  return value || process.env.SWARMTUMX_TMUX_SOCKET_NAME || SOCKET_NAME
}

function getTmuxBin() {
  return resolvePackagedResource("tmux")
    || process.env.SWARMTUMX_TMUX_BIN
    || KNOWN_TMUX_PATHS.find((candidate) => fs.existsSync(candidate))
    || "tmux"
}

function getTmuxConf() {
  const packaged = resolvePackagedResource("tmux.conf")
  if (packaged) {
    return packaged
  }

  const local = `${getWorkspaceRoot()}/tmux.conf`
  return fs.existsSync(local) ? local : null
}

function getTerminfoDir() {
  return resolvePackagedResource("terminfo") || process.env.TERMINFO
}

function tmuxEnv() {
  const env = { ...process.env }

  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8"
  }

  env.COLORTERM = env.COLORTERM || "truecolor"
  env.TERM_PROGRAM = env.TERM_PROGRAM || "SwarmTumx"

  const terminfo = getTerminfoDir()
  if (terminfo) {
    env.TERMINFO = terminfo
  }

  return env
}

function baseArgs(socketName = SOCKET_NAME) {
  const args = ["-L", resolveSocketName(socketName), "-u"]
  const tmuxConf = getTmuxConf()
  if (tmuxConf) {
    args.push("-f", tmuxConf)
  }
  return args
}

function execFileUtf8(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        encoding: "utf8",
        env: tmuxEnv(),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT") {
            reject(
              new Error(
                "tmux was not found. Install it or set SWARMTUMX_TMUX_BIN.",
              ),
            )
            return
          }

          error.stderr = stderr
          reject(error)
          return
        }

        resolve(stdout.trimEnd())
      },
    )
  })
}

async function tmuxExec(...args) {
  return execFileUtf8(getTmuxBin(), [...baseArgs(), ...args])
}

async function tmuxExecWithSocket(socketName, ...args) {
  return execFileUtf8(getTmuxBin(), [...baseArgs(socketName), ...args])
}

function tmuxSessionName(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`
}

function parsePaneFields(output) {
  if (!output) {
    return null
  }

  const [
    tmuxPaneId,
    tmuxWindowId,
    tmuxSessionNameValue,
    tmuxSessionId,
  ] = output.split("\t")

  return {
    tmuxPaneId,
    tmuxSessionId,
    tmuxSessionName: tmuxSessionNameValue,
    tmuxWindowId,
  }
}

function isMissingSessionError(error) {
  const message = String(error?.stderr || error?.message || "")
  return /can't find session|no server running|error connecting .*no such file or directory/u.test(message)
}

function createSessionId() {
  return crypto.randomBytes(8).toString("hex")
}

function normalizePositiveInt(value, fallback, label) {
  if (value == null) {
    return fallback
  }

  const normalized = Math.floor(Number(value))
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`)
  }

  return normalized
}

function enqueueSessionMutation(sessionId, task) {
  const previous = sessionMutationQueues.get(sessionId) || Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(task)

  sessionMutationQueues.set(sessionId, next)
  next.finally(() => {
    if (sessionMutationQueues.get(sessionId) === next) {
      sessionMutationQueues.delete(sessionId)
    }
  })

  return next
}

async function ensureTmuxServerConfigured() {
  try {
    await tmuxExec("set-option", "-g", "default-terminal", "tmux-256color")
  } catch (error) {
    if (isMissingSessionError(error)) {
      return false
    }
    throw error
  }

  const terminalFeatures = await tmuxExec("show-options", "-g", "terminal-features")
  if (!terminalFeatures.includes(RGB_CLIENT_TERM)) {
    await tmuxExec("set-option", "-ag", "terminal-features", RGB_CLIENT_TERM)
  }

  return true
}

async function sessionExists(sessionId) {
  try {
    await tmuxExec("has-session", "-t", tmuxSessionName(sessionId))
    return true
  } catch (error) {
    if (isMissingSessionError(error)) {
      return false
    }
    throw error
  }
}

async function createSession(options = {}) {
  const sessionId = createSessionId()
  const tmuxName = tmuxSessionName(sessionId)
  const socketName = resolveSocketName(options.socketName)
  const cwd = options.cwd || process.cwd()
  const shell = process.env.SHELL || "/bin/zsh"
  const cols = normalizePositiveInt(options.cols, 100, "cols")
  const rows = normalizePositiveInt(options.rows, 28, "rows")

  const terminalFeatures = await execFileUtf8(
    getTmuxBin(),
    [...baseArgs(socketName), "start-server", ";", "show-options", "-g", "terminal-features"],
  )

  const createArgs = [
    ...baseArgs(socketName),
    "start-server",
    ";",
    "set-option",
    "-g",
    "default-terminal",
    "tmux-256color",
  ]

  if (!terminalFeatures.includes(RGB_CLIENT_TERM)) {
    createArgs.push(
      ";",
      "set-option",
      "-ag",
      "terminal-features",
      RGB_CLIENT_TERM,
    )
  }

  createArgs.push(
    ";",
    "new-session",
    "-d",
    "-s",
    tmuxName,
    "-c",
    cwd,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-e",
    `SWARMTUMX_SESSION_ID=${sessionId}`,
    "-e",
    `SWARMTUMX_TMUX_SOCKET_NAME=${socketName}`,
    "-e",
    `SHELL=${shell}`,
    "-e",
    "COLORTERM=truecolor",
    "-e",
    "TERM_PROGRAM=SwarmTumx",
    shell,
  )

  await execFileUtf8(getTmuxBin(), createArgs)

  const sessionEnv = [
    ["SWARMTUMX_SESSION_ID", sessionId],
    ["SWARMTUMX_TMUX_SOCKET_NAME", socketName],
    ["SHELL", shell],
    ["COLORTERM", "truecolor"],
    ["TERM_PROGRAM", "SwarmTumx"],
  ]

  for (const [key, value] of sessionEnv) {
    await tmuxExecWithSocket(socketName, "set-environment", "-t", tmuxName, key, value)
  }

  const paneInfo = await tmuxExecWithSocket(
    socketName,
    "list-panes",
    "-t",
    tmuxName,
    "-F",
    "#{pane_id}\t#{window_id}\t#{session_name}\t#{session_id}",
  )
  const primaryPane = parsePaneFields(paneInfo.split("\n")[0])

  const meta = {
    sessionId,
    tmuxPaneId: primaryPane?.tmuxPaneId || null,
    tmuxSessionName: tmuxName,
    tmuxSocketName: socketName,
    tmuxWindowId: primaryPane?.tmuxWindowId || null,
    cwd,
    shell,
    createdAt: new Date().toISOString(),
  }

  writeSessionMeta(sessionId, meta)
  return meta
}

async function readSession(sessionId, options = {}) {
  const screenOnly = Boolean(options.screenOnly)
  const lines = screenOnly
    ? null
    : normalizePositiveInt(options.lines, DEFAULT_CAPTURE_LINES, "lines")

  if (!await sessionExists(sessionId)) {
    throw new Error(`tmux session not found for ${sessionId}`)
  }

  const output = await captureTarget(tmuxSessionName(sessionId), {
    lines,
    screenOnly,
  })

  return {
    sessionId,
    output,
  }
}

async function captureTarget(target, options = {}) {
  const screenOnly = Boolean(options.screenOnly)
  const lines = screenOnly
    ? null
    : normalizePositiveInt(options.lines, DEFAULT_CAPTURE_LINES, "lines")
  const socketName = resolveSocketName(options.socketName)

  const captureArgs = [
    "capture-pane",
    "-t",
    target,
    ...(screenOnly ? DEFAULT_CAPTURE_ARGS : HISTORY_CAPTURE_ARGS),
  ]

  if (!screenOnly) {
    captureArgs.push("-S", `-${lines}`)
  }

  return tmuxExecWithSocket(socketName, ...captureArgs)
}

async function paneExists(tmuxPaneId, options = {}) {
  try {
    await tmuxExecWithSocket(
      resolveSocketName(options.socketName),
      "display-message",
      "-p",
      "-t",
      tmuxPaneId,
      "#{pane_id}",
    )
    return true
  } catch (error) {
    if (isMissingSessionError(error)) {
      return false
    }
    const message = String(error?.stderr || error?.message || "")
    if (/can't find pane|unknown pane/u.test(message)) {
      return false
    }
    throw error
  }
}

async function describePane(tmuxPaneId, options = {}) {
  if (!await paneExists(tmuxPaneId, options)) {
    return null
  }

  const output = await tmuxExecWithSocket(
    resolveSocketName(options.socketName),
    "display-message",
    "-p",
    "-t",
    tmuxPaneId,
    "#{pane_id}\t#{window_id}\t#{session_name}\t#{session_id}",
  )

  return parsePaneFields(output)
}

async function readPane(tmuxPaneId, options = {}) {
  if (!await paneExists(tmuxPaneId, options)) {
    throw new Error(`tmux pane not found for ${tmuxPaneId}`)
  }

  return {
    output: await captureTarget(tmuxPaneId, options),
    tmuxPaneId,
  }
}

async function typeText(sessionId, text) {
  return enqueueSessionMutation(sessionId, async () => {
    if (!await sessionExists(sessionId)) {
      throw new Error(`tmux session not found for ${sessionId}`)
    }

    await tmuxExec(
      "send-keys",
      "-l",
      "-t",
      tmuxSessionName(sessionId),
      text,
    )

    return { ok: true }
  })
}

async function typeToPane(tmuxPaneId, text, options = {}) {
  const socketName = resolveSocketName(options.socketName)
  const queueKey = `pane:${socketName}:${tmuxPaneId}`
  return enqueueSessionMutation(queueKey, async () => {
    if (!await paneExists(tmuxPaneId, { socketName })) {
      throw new Error(`tmux pane not found for ${tmuxPaneId}`)
    }

    await tmuxExecWithSocket(
      socketName,
      "send-keys",
      "-l",
      "-t",
      tmuxPaneId,
      text,
    )

    return { ok: true }
  })
}

async function sendKeys(sessionId, keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("keys must be a non-empty array")
  }

  return enqueueSessionMutation(sessionId, async () => {
    if (!await sessionExists(sessionId)) {
      throw new Error(`tmux session not found for ${sessionId}`)
    }

    await tmuxExec(
      "send-keys",
      "-t",
      tmuxSessionName(sessionId),
      ...keys,
    )

    return { ok: true }
  })
}

async function sendKeysToPane(tmuxPaneId, keys, options = {}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("keys must be a non-empty array")
  }

  const socketName = resolveSocketName(options.socketName)
  const queueKey = `pane:${socketName}:${tmuxPaneId}`
  return enqueueSessionMutation(queueKey, async () => {
    if (!await paneExists(tmuxPaneId, { socketName })) {
      throw new Error(`tmux pane not found for ${tmuxPaneId}`)
    }

    await tmuxExecWithSocket(
      socketName,
      "send-keys",
      "-t",
      tmuxPaneId,
      ...keys,
    )

    return { ok: true }
  })
}

async function resizeSession(sessionId, cols, rows) {
  return enqueueSessionMutation(sessionId, async () => {
    const nextCols = normalizePositiveInt(cols, null, "cols")
    const nextRows = normalizePositiveInt(rows, null, "rows")

    if (!await sessionExists(sessionId)) {
      throw new Error(`tmux session not found for ${sessionId}`)
    }

    await tmuxExec(
      "resize-window",
      "-t",
      tmuxSessionName(sessionId),
      "-x",
      String(nextCols),
      "-y",
      String(nextRows),
    )

    return { ok: true }
  })
}

async function killSession(sessionId) {
  return enqueueSessionMutation(sessionId, async () => {
    try {
      await tmuxExec("kill-session", "-t", tmuxSessionName(sessionId))
    } catch (error) {
      if (!isMissingSessionError(error)) {
        throw error
      }
    } finally {
      deleteSessionMeta(sessionId)
    }

    return { ok: true }
  })
}

async function listSessions() {
  const metas = listSessionMeta()
  const entries = await Promise.all(
    metas.map(async (meta) => ({
      ...meta,
      running: await sessionExists(meta.sessionId),
    })),
  )

  return entries.sort((left, right) =>
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
}

async function describeSession(sessionId) {
  const meta = readSessionMeta(sessionId)
  return {
    ...meta,
    running: await sessionExists(sessionId),
  }
}

module.exports = {
  baseArgs,
  captureTarget,
  createSession,
  describePane,
  describeSession,
  ensureTmuxServerConfigured,
  getTmuxBin,
  killSession,
  listSessions,
  normalizePositiveInt,
  paneExists,
  readPane,
  readSession,
  resizeSession,
  sendKeys,
  sendKeysToPane,
  sessionExists,
  tmuxEnv,
  tmuxExec,
  tmuxExecWithSocket,
  tmuxSessionName,
  typeToPane,
  typeText,
  resolveSocketName,
}

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

function baseArgs() {
  const args = ["-L", SOCKET_NAME, "-u"]
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

function tmuxSessionName(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`
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
  const cwd = options.cwd || process.cwd()
  const shell = process.env.SHELL || "/bin/zsh"
  const cols = normalizePositiveInt(options.cols, 100, "cols")
  const rows = normalizePositiveInt(options.rows, 28, "rows")

  const terminalFeatures = await execFileUtf8(
    getTmuxBin(),
    [...baseArgs(), "start-server", ";", "show-options", "-g", "terminal-features"],
  )

  const createArgs = [
    ...baseArgs(),
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
    shell,
  )

  await execFileUtf8(getTmuxBin(), createArgs)

  const sessionEnv = [
    ["SWARMTUMX_SESSION_ID", sessionId],
    ["SHELL", shell],
    ["COLORTERM", "truecolor"],
    ["TERM_PROGRAM", "SwarmTumx"],
  ]

  for (const [key, value] of sessionEnv) {
    await tmuxExec("set-environment", "-t", tmuxName, key, value)
  }

  const meta = {
    sessionId,
    tmuxSessionName: tmuxName,
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

  const captureArgs = [
    "capture-pane",
    "-t",
    tmuxSessionName(sessionId),
    ...(screenOnly ? DEFAULT_CAPTURE_ARGS : HISTORY_CAPTURE_ARGS),
  ]

  if (!screenOnly) {
    captureArgs.push("-S", `-${lines}`)
  }

  const output = await tmuxExec(...captureArgs)

  return {
    sessionId,
    output,
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
  createSession,
  describeSession,
  ensureTmuxServerConfigured,
  getTmuxBin,
  killSession,
  listSessions,
  normalizePositiveInt,
  readSession,
  resizeSession,
  sendKeys,
  sessionExists,
  tmuxEnv,
  tmuxExec,
  tmuxSessionName,
  typeText,
}

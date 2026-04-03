const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { agentDataDir } = require("./agent-db")
const {
  listActiveAutoWakeBindings,
  markDeliverySucceeded,
  revokeBinding,
} = require("./agent-service")
const {
  readPane,
  sendKeysToPane,
  typeHumanToPane,
} = require("./tmux-adapter")

const DEFAULT_INTERVAL_MS = 500
const DEFAULT_QUIET_MS = 2500
const DEFAULT_MISSING_PANE_RETRIES = 3

function brokerPidPath() {
  return path.join(agentDataDir(), "broker.pid")
}

function brokerStatusPath() {
  return path.join(agentDataDir(), "broker-status.json")
}

function nowMs() {
  return Date.now()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readBrokerPid() {
  try {
    const raw = fs.readFileSync(brokerPidPath(), "utf8").trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

function writeBrokerPid(pid) {
  fs.writeFileSync(brokerPidPath(), `${pid}\n`)
}

function clearBrokerPid(pid) {
  try {
    const currentPid = readBrokerPid()
    if (currentPid == null || currentPid === pid) {
      fs.unlinkSync(brokerPidPath())
    }
  } catch {
    // no-op
  }
}

function writeBrokerHealth(health) {
  try {
    fs.writeFileSync(brokerStatusPath(), JSON.stringify(health, null, 2))
  } catch {
    // no-op
  }
}

function readBrokerHealth() {
  try {
    return JSON.parse(fs.readFileSync(brokerStatusPath(), "utf8"))
  } catch {
    return null
  }
}

function hashOutput(output) {
  return crypto.createHash("sha1").update(String(output || "")).digest("hex")
}

async function deliverAttention(binding) {
  if (binding.preludeKeys.length > 0) {
    await sendKeysToPane(binding.tmuxPaneId, binding.preludeKeys, {
      socketName: binding.tmuxSocketName,
    })
  }

  await typeHumanToPane(binding.tmuxPaneId, binding.sentinelText, {
    socketName: binding.tmuxSocketName,
  })

  if (binding.triggerKeys.length > 0) {
    await sendKeysToPane(binding.tmuxPaneId, binding.triggerKeys, {
      socketName: binding.tmuxSocketName,
    })
  }
}

class AgentAttentionBroker {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS
    this.missingPaneRetries = options.missingPaneRetries || DEFAULT_MISSING_PANE_RETRIES
    this.quietMs = options.quietMs || DEFAULT_QUIET_MS
    this.runtimeState = new Map()
    this.timer = null
    this.stopped = false
  }

  start() {
    if (this.timer) {
      return
    }
    this.stopped = false
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.recordHealth({
          error,
          scope: "tick",
        })
      })
    }, this.intervalMs)
  }

  async stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  recordHealth(options = {}) {
    writeBrokerHealth({
      accountId: options.accountId || null,
      bindingId: options.bindingId || null,
      lastErrorAt: options.error ? new Date().toISOString() : null,
      lastErrorMessage: options.error
        ? (options.error.stack || options.error.message || String(options.error))
        : null,
      lastTickAt: new Date().toISOString(),
      pid: process.pid,
      running: true,
      scope: options.scope || "tick",
    })
  }

  stateFor(accountId) {
    if (!this.runtimeState.has(accountId)) {
      this.runtimeState.set(accountId, {
        deliveryInFlight: false,
        lastDeliveryAttemptAt: 0,
        lastDeliveryCompletedAt: 0,
        lastScreenChangedAt: 0,
        lastScreenHash: null,
        missingSamples: 0,
        screenEpoch: 0,
      })
    }
    return this.runtimeState.get(accountId)
  }

  async tick() {
    if (this.stopped) {
      return
    }

    const bindings = listActiveAutoWakeBindings()
    const activeAccounts = new Set(bindings.map((binding) => binding.accountId))
    for (const accountId of this.runtimeState.keys()) {
      if (!activeAccounts.has(accountId)) {
        this.runtimeState.delete(accountId)
      }
    }

    await Promise.all(bindings.map(async (binding) => {
      try {
        await this.tickBinding(binding)
      } catch (error) {
        this.recordHealth({
          accountId: binding.accountId,
          bindingId: binding.bindingId,
          error,
          scope: "binding",
        })
      }
    }))

    this.recordHealth({
      scope: "tick",
    })
  }

  async tickBinding(binding) {
    const state = this.stateFor(binding.accountId)
    const now = nowMs()

    let paneRead
    try {
      paneRead = await readPane(binding.tmuxPaneId, {
        screenOnly: true,
        socketName: binding.tmuxSocketName,
      })
      state.missingSamples = 0
    } catch (error) {
      if (/tmux pane not found/u.test(String(error?.message || ""))) {
        state.missingSamples += 1
        if (state.missingSamples >= this.missingPaneRetries) {
          revokeBinding(binding.bindingId, "pane-missing")
        }
        return
      }
      throw error
    }

    const nextHash = hashOutput(paneRead.output)

    if (state.lastScreenHash == null) {
      state.lastScreenHash = nextHash
      state.lastScreenChangedAt = now
      state.screenEpoch = 1
      return
    }

    if (state.lastScreenHash !== nextHash) {
      state.lastScreenHash = nextHash
      state.lastScreenChangedAt = now
      state.screenEpoch += 1
      return
    }

    if (binding.latestEventSeq <= binding.lastDeliveredEventSeq) {
      return
    }

    if (state.deliveryInFlight) {
      return
    }

    const quietSince = Math.max(
      state.lastScreenChangedAt || 0,
      state.lastDeliveryCompletedAt || 0,
    )

    if (now - quietSince < this.quietMs) {
      return
    }

    if (state.lastDeliveryAttemptAt > 0 && now - state.lastDeliveryAttemptAt < this.quietMs) {
      return
    }

    state.deliveryInFlight = true
    state.lastDeliveryAttemptAt = now
    try {
      await deliverAttention(binding)
      markDeliverySucceeded(binding.accountId, binding.latestEventSeq)
      state.lastDeliveryCompletedAt = nowMs()
    } finally {
      state.deliveryInFlight = false
    }
  }
}

function brokerStatus() {
  const pid = readBrokerPid()
  return {
    health: readBrokerHealth(),
    pid,
    running: isProcessAlive(pid),
  }
}

async function ensureBrokerDaemonRunning(cliPath) {
  const status = brokerStatus()
  if (status.running) {
    return status
  }

  const child = spawn(
    process.execPath,
    [cliPath, "broker-run", "--daemon-child"],
    {
      detached: true,
      env: {
        ...process.env,
        SWARMTUMX_BROKER_DAEMON: "1",
      },
      stdio: "ignore",
    },
  )

  child.unref()

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100)
    const nextStatus = brokerStatus()
    if (nextStatus.running || readBrokerPid() === child.pid) {
      return {
        ...nextStatus,
        pid: child.pid,
        running: true,
        started: true,
      }
    }
  }

  return {
    health: readBrokerHealth(),
    pid: child.pid,
    running: isProcessAlive(child.pid),
    started: isProcessAlive(child.pid),
  }
}

async function stopBrokerDaemon() {
  const pid = readBrokerPid()
  if (!isProcessAlive(pid)) {
    clearBrokerPid(pid)
    return {
      health: readBrokerHealth(),
      ok: true,
      running: false,
    }
  }

  process.kill(pid, "SIGTERM")

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100)
    if (!isProcessAlive(pid)) {
      clearBrokerPid(pid)
      return {
        health: readBrokerHealth(),
        ok: true,
        pid,
        running: false,
      }
    }
  }

  return {
    health: readBrokerHealth(),
    ok: false,
    pid,
    running: isProcessAlive(pid),
  }
}

async function runBrokerLoop(options = {}) {
  const existingPid = readBrokerPid()
  if (isProcessAlive(existingPid) && existingPid !== process.pid) {
    return
  }

  writeBrokerPid(process.pid)
  const broker = new AgentAttentionBroker(options)
  const shutdown = async () => {
    await broker.stop()
    clearBrokerPid(process.pid)
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("exit", () => clearBrokerPid(process.pid))

  broker.start()
  await broker.tick()

  if (options.once) {
    await shutdown()
    return
  }

  await new Promise(() => {})
}

module.exports = {
  AgentAttentionBroker,
  brokerStatus,
  clearBrokerPid,
  ensureBrokerDaemonRunning,
  runBrokerLoop,
  stopBrokerDaemon,
}

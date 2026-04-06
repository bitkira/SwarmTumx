const { spawn } = require("node:child_process")
const { StringDecoder } = require("node:string_decoder")
const { readSessionMeta } = require("./state-store")
const {
  baseArgs,
  captureTarget,
  getTmuxBin,
  normalizePositiveInt,
  sessionExists,
  tmuxEnv,
  tmuxExecWithSocket,
  tmuxSessionName,
} = require("./tmux-adapter")

const DEFAULT_COLS = 100
const DEFAULT_ROWS = 28
const DEFAULT_INITIAL_HISTORY_LINES = 5000
const DEFAULT_ATTACH_TIMEOUT_MS = 3000
const DEFAULT_ATTACH_REDRAW_SETTLE_MS = 120
const WRITE_HEX_CHUNK_SIZE = 256

function controlEnv() {
  return {
    ...tmuxEnv(),
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
    TERM_PROGRAM: "SwarmTumx",
  }
}

function senderIsDestroyed(sender) {
  return Boolean(sender && typeof sender.isDestroyed === "function" && sender.isDestroyed())
}

function decodeTmuxControlValue(value) {
  const source = String(value || "")
  const bytes = []

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      const octal = source.slice(index + 1, index + 4)
      if (/^[0-7]{3}$/u.test(octal)) {
        bytes.push(Number.parseInt(octal, 8))
        index += 3
        continue
      }
    }

    const codePoint = source.codePointAt(index)
    const character = String.fromCodePoint(codePoint)
    bytes.push(...Buffer.from(character, "utf8"))
    if (codePoint > 0xffff) {
      index += 1
    }
  }

  return Buffer.from(bytes).toString("utf8")
}

function encodeTmuxInput(data, options = {}) {
  const encoding = options.binary ? "latin1" : "utf8"
  return [...Buffer.from(String(data || ""), encoding)]
    .map((value) => value.toString(16).padStart(2, "0"))
}

function parseNotificationLine(line) {
  if (!line.startsWith("%")) {
    return null
  }

  if (line.startsWith("%output ")) {
    const [, paneId, value = ""] = line.match(/^%output\s+(\S+)\s?(.*)$/u) || []
    if (!paneId) {
      return null
    }
    return {
      paneId,
      type: "output",
      value: decodeTmuxControlValue(value),
    }
  }

  if (line.startsWith("%extended-output ")) {
    const match = line.match(/^%extended-output\s+(\S+)\s+\S+(?:\s+\S+)*\s+:\s?(.*)$/u)
    if (!match) {
      return null
    }
    return {
      paneId: match[1],
      type: "output",
      value: decodeTmuxControlValue(match[2]),
    }
  }

  if (line.startsWith("%session-changed ")) {
    const [, tmuxSessionId, sessionName = ""] = line.match(/^%session-changed\s+(\S+)\s?(.*)$/u) || []
    if (!tmuxSessionId) {
      return null
    }
    return {
      sessionName,
      tmuxSessionId,
      type: "session-changed",
    }
  }

  if (line.startsWith("%exit")) {
    return {
      reason: line.replace(/^%exit\s*/u, ""),
      type: "exit",
    }
  }

  return null
}

async function resolveSessionPaneId(sessionId, socketName, fallbackPaneId) {
  if (fallbackPaneId) {
    return fallbackPaneId
  }

  const output = await tmuxExecWithSocket(
    socketName,
    "list-panes",
    "-t",
    tmuxSessionName(sessionId),
    "-F",
    "#{pane_id}",
  )

  return output.split("\n")[0] || null
}

async function readPaneDisplayState(tmuxPaneId, socketName) {
  const output = await tmuxExecWithSocket(
    socketName,
    "display-message",
    "-p",
    "-t",
    tmuxPaneId,
    "#{alternate_on}\t#{pane_in_mode}",
  )
  const [alternateOn = "0", paneInMode = "0"] = output.split("\t")
  return {
    alternateOn: alternateOn === "1",
    paneInMode: paneInMode === "1",
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class ControlModeTerminalManager {
  constructor(options = {}) {
    this.attachTimeoutMs = normalizePositiveInt(
      options.attachTimeoutMs,
      DEFAULT_ATTACH_TIMEOUT_MS,
      "attachTimeoutMs",
    )
    this.initialHistoryLines = normalizePositiveInt(
      options.initialHistoryLines,
      DEFAULT_INITIAL_HISTORY_LINES,
      "initialHistoryLines",
    )
    this.attachRedrawSettleMs = normalizePositiveInt(
      options.attachRedrawSettleMs,
      DEFAULT_ATTACH_REDRAW_SETTLE_MS,
      "attachRedrawSettleMs",
    )
    this.clients = new Map()
  }

  async attachSession(sender, sessionId, options = {}) {
    const cols = normalizePositiveInt(options.cols, DEFAULT_COLS, "cols")
    const rows = normalizePositiveInt(options.rows, DEFAULT_ROWS, "rows")
    const meta = readSessionMeta(sessionId)
    const cwd = options.cwd || meta?.cwd || process.cwd()

    if (!await sessionExists(sessionId)) {
      throw new Error(`tmux session not found for ${sessionId}`)
    }

    const paneId = await resolveSessionPaneId(sessionId, meta?.tmuxSocketName, meta?.tmuxPaneId)
    if (!paneId) {
      throw new Error(`tmux pane not found for ${sessionId}`)
    }
    const paneState = await readPaneDisplayState(paneId, meta?.tmuxSocketName)

    this.detachSession(sessionId)

    const processHandle = spawn(
      getTmuxBin(),
      [...baseArgs(meta?.tmuxSocketName), "-C", "attach-session", "-t", tmuxSessionName(sessionId)],
      {
        cwd,
        env: controlEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    )

    const client = {
      attachResolved: false,
      closed: false,
      commandQueue: [],
      controlProcess: processHandle,
      currentBlock: null,
      cwd,
      paneId,
      paneState,
      outputCount: 0,
      paneDecoders: new Map(),
      readyForOutput: false,
      sender,
      senderId: sender?.id,
      sessionId,
      socketName: meta?.tmuxSocketName,
      stderr: "",
      stderrDecoder: new StringDecoder("utf8"),
      stdoutBuffer: "",
      stdoutDecoder: new StringDecoder("utf8"),
    }

    const attachPromise = new Promise((resolve, reject) => {
      client.resolveAttach = resolve
      client.rejectAttach = reject
      client.attachTimer = setTimeout(() => {
        reject(new Error(`timed out attaching tmux control client for ${sessionId}`))
      }, this.attachTimeoutMs)
    })

    processHandle.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(client, chunk)
    })
    processHandle.stderr.on("data", (chunk) => {
      client.stderr += client.stderrDecoder.write(chunk)
    })
    processHandle.on("error", (error) => {
      this.finalizeClient(client, error)
    })
    processHandle.on("close", (exitCode, signal) => {
      const stderrTail = client.stderr + client.stderrDecoder.end()
      if (stderrTail) {
        client.stderr = stderrTail
      }
      this.finalizeClient(client, null, exitCode, signal)
    })

    this.clients.set(sessionId, client)

    try {
      await attachPromise
      await this.sendCommand(client, `refresh-client -C ${cols}x${rows}`)
      if (client.paneState.alternateOn || client.paneState.paneInMode) {
        client.readyForOutput = true
        this.emitTerminalData(
          client,
          client.paneState.alternateOn ? "\u001b[?1049h\u001b[2J\u001b[H" : "\u001b[2J\u001b[H",
        )
        const outputCountBeforeRedraw = client.outputCount
        await this.forceInitialRedraw(client, cols, rows)
        await wait(this.attachRedrawSettleMs)
        if (client.outputCount === outputCountBeforeRedraw) {
          await this.sendInitialCapture(client, { screenOnly: true })
        }
      } else {
        await this.sendInitialCapture(client)
        client.readyForOutput = true
      }
    } catch (error) {
      this.detachSession(sessionId)
      throw error
    }

    return {
      cols,
      cwd,
      ok: true,
      rows,
      sessionId,
      transport: "control-mode",
    }
  }

  detachSession(sessionId) {
    const client = this.clients.get(sessionId)
    if (!client) {
      return { ok: true }
    }

    client.closed = true
    this.clients.delete(sessionId)

    clearTimeout(client.attachTimer)
    this.rejectPendingCommands(client, new Error(`terminal detached for ${sessionId}`))

    try {
      client.controlProcess.kill()
    } catch {
      // no-op
    }

    return { ok: true }
  }

  detachSender(senderId) {
    for (const [sessionId, client] of this.clients.entries()) {
      if (client.senderId === senderId) {
        this.detachSession(sessionId)
      }
    }
  }

  getClient(sessionId) {
    const client = this.clients.get(sessionId)
    if (!client) {
      throw new Error(`terminal client not attached for ${sessionId}`)
    }
    return client
  }

  async resizeSession(sessionId, cols, rows) {
    const client = this.getClient(sessionId)
    const nextCols = normalizePositiveInt(cols, null, "cols")
    const nextRows = normalizePositiveInt(rows, null, "rows")
    await this.sendCommand(client, `refresh-client -C ${nextCols}x${nextRows}`)
    return {
      cols: nextCols,
      ok: true,
      rows: nextRows,
      sessionId,
    }
  }

  async writeToSession(sessionId, data, options = {}) {
    const client = this.getClient(sessionId)
    const hexKeys = encodeTmuxInput(data, options)
    if (hexKeys.length === 0) {
      return { ok: true, sessionId }
    }

    for (let index = 0; index < hexKeys.length; index += WRITE_HEX_CHUNK_SIZE) {
      const chunk = hexKeys.slice(index, index + WRITE_HEX_CHUNK_SIZE)
      await this.sendCommand(client, `send-keys -H -t ${client.paneId} ${chunk.join(" ")}`)
    }

    return { ok: true, sessionId }
  }

  async sendInitialCapture(client, options = {}) {
    const output = await captureTarget(client.paneId, {
      lines: options.screenOnly ? undefined : this.initialHistoryLines,
      screenOnly: Boolean(options.screenOnly),
      socketName: client.socketName,
    })
    if (!output || client.closed) {
      return
    }

    this.emitTerminalData(client, output)
  }

  async forceInitialRedraw(client, cols, rows) {
    const fallbackCols = cols > 2 ? cols - 1 : cols + 1
    const fallbackRows = rows > 2 ? rows - 1 : rows + 1
    const intermediateSize = cols > 2
      ? `${fallbackCols}x${rows}`
      : `${cols}x${fallbackRows}`

    if (!intermediateSize || intermediateSize === `${cols}x${rows}`) {
      return
    }

    await this.sendCommand(client, `refresh-client -C ${intermediateSize}`)
    await wait(20)
    await this.sendCommand(client, `refresh-client -C ${cols}x${rows}`)
  }

  sendCommand(client, command) {
    if (client.closed || client.controlProcess.killed || client.controlProcess.stdin.destroyed) {
      return Promise.reject(new Error(`terminal client not attached for ${client.sessionId}`))
    }

    return new Promise((resolve, reject) => {
      const entry = {
        command,
        reject,
        resolve,
      }

      client.commandQueue.push(entry)
      client.controlProcess.stdin.write(`${command}\n`, (error) => {
        if (!error) {
          return
        }

        const index = client.commandQueue.indexOf(entry)
        if (index >= 0) {
          client.commandQueue.splice(index, 1)
        }
        reject(error)
      })
    })
  }

  handleStdoutChunk(client, chunk) {
    client.stdoutBuffer += client.stdoutDecoder.write(chunk)

    while (true) {
      const newlineIndex = client.stdoutBuffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      let line = client.stdoutBuffer.slice(0, newlineIndex)
      client.stdoutBuffer = client.stdoutBuffer.slice(newlineIndex + 1)
      if (line.endsWith("\r")) {
        line = line.slice(0, -1)
      }
      this.handleControlLine(client, line)
    }
  }

  handleControlLine(client, line) {
    if (line.startsWith("%begin ")) {
      const entry = client.commandQueue.shift() || null
      client.currentBlock = {
        entry,
        lines: [],
      }
      return
    }

    if (line.startsWith("%end ") || line.startsWith("%error ")) {
      const block = client.currentBlock
      client.currentBlock = null

      if (!block?.entry) {
        return
      }

      const output = block.lines.join("\n")
      if (line.startsWith("%error ")) {
        block.entry.reject(new Error(output || `tmux control command failed: ${block.entry.command}`))
        return
      }

      block.entry.resolve(output)
      return
    }

    if (client.currentBlock) {
      client.currentBlock.lines.push(line)
      return
    }

    const notification = parseNotificationLine(line)
    if (!notification) {
      return
    }

    if (notification.type === "session-changed") {
      if (!client.attachResolved) {
        client.attachResolved = true
        clearTimeout(client.attachTimer)
        client.resolveAttach()
      }
      return
    }

    if (notification.type === "output") {
      if (!client.readyForOutput || notification.paneId !== client.paneId) {
        return
      }
      client.outputCount += 1
      this.emitTerminalData(client, notification.value)
      return
    }

    if (notification.type === "exit") {
      client.exitReason = notification.reason || ""
      if (!client.attachResolved) {
        client.attachResolved = true
        clearTimeout(client.attachTimer)
        client.rejectAttach(new Error(notification.reason || `tmux exited for ${client.sessionId}`))
      }
    }
  }

  emitTerminalData(client, data) {
    if (!data || client.closed || senderIsDestroyed(client.sender)) {
      return
    }

    try {
      client.sender.send("terminal:data", {
        data,
        sessionId: client.sessionId,
      })
    } catch {
      // no-op
    }
  }

  rejectPendingCommands(client, error) {
    for (const decoder of client.paneDecoders.values()) {
      decoder.end()
    }
    client.paneDecoders.clear()

    if (client.currentBlock?.entry) {
      client.currentBlock.entry.reject(error)
      client.currentBlock = null
    }

    while (client.commandQueue.length > 0) {
      const entry = client.commandQueue.shift()
      entry?.reject(error)
    }
  }

  finalizeClient(client, processError, exitCode = null, signal = null) {
    if (!client.closed) {
      this.clients.delete(client.sessionId)
    }

    clearTimeout(client.attachTimer)

    const reason = client.exitReason || client.stderr || processError?.message || ""
    const terminalError = processError || (reason ? new Error(reason) : new Error(`tmux exited for ${client.sessionId}`))

    if (!client.attachResolved) {
      client.attachResolved = true
      client.rejectAttach(terminalError)
    }

    this.rejectPendingCommands(client, terminalError)

    if (client.closed || senderIsDestroyed(client.sender)) {
      return
    }

    try {
      client.sender.send("terminal:exit", {
        exitCode,
        reason: reason || null,
        sessionId: client.sessionId,
        signal,
      })
    } catch {
      // no-op
    }
  }
}

module.exports = {
  ControlModeTerminalManager,
  decodeTmuxControlValue,
  encodeTmuxInput,
}

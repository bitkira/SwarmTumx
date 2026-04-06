const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { Terminal } = require("@xterm/xterm")

const {
  ControlModeTerminalManager,
  decodeTmuxControlValue,
  encodeTmuxInput,
} = require("../src/runtime/control-mode-terminal-manager")
const {
  createSession,
  killSession,
  sendKeys,
  typeText,
} = require("../src/runtime/tmux-adapter")

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function killSocketServer(socketName) {
  try {
    execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" })
  } catch {
    // no-op
  }
}

function createSocketName(label) {
  return `swarmtumx-${label}-${process.pid}-${Date.now().toString(16)}`
}

async function withSocketName(label, task) {
  const previousSocketName = process.env.SWARMTUMX_TMUX_SOCKET_NAME
  const socketName = createSocketName(label)
  process.env.SWARMTUMX_TMUX_SOCKET_NAME = socketName
  killSocketServer(socketName)

  try {
    return await task(socketName)
  } finally {
    killSocketServer(socketName)
    if (previousSocketName == null) {
      delete process.env.SWARMTUMX_TMUX_SOCKET_NAME
    } else {
      process.env.SWARMTUMX_TMUX_SOCKET_NAME = previousSocketName
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return
    }
    await wait(50)
  }

  throw new Error("timed out waiting for condition")
}

function readTerminalText(terminal) {
  const lines = []
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    const line = terminal.buffer.active.getLine(index)
    lines.push(line ? line.translateToString(true) : "")
  }
  return lines.join("\n")
}

function createMockSender(terminal, exitEvents) {
  let renderQueue = Promise.resolve()

  return {
    sender: {
      id: 1,
      isDestroyed() {
        return false
      },
      send(channel, payload) {
        if (channel === "terminal:data") {
          renderQueue = renderQueue.then(() =>
            new Promise((resolve) => terminal.write(payload.data, resolve))
          )
          return
        }

        if (channel === "terminal:exit") {
          exitEvents.push(payload)
        }
      },
    },
    waitForRender() {
      return renderQueue
    },
  }
}

async function sendLine(sessionId, command) {
  await typeText(sessionId, command)
  await sendKeys(sessionId, ["Enter"])
}

function writeAltScreenDemoScript() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-alt-demo-"))
  const scriptPath = path.join(tempDir, "demo.py")
  fs.writeFileSync(scriptPath, `
import shutil
import signal
import sys
import time

def draw(*_args):
    size = shutil.get_terminal_size((30, 12))
    cols = size.columns
    left = max(1, min(20, cols - 14))
    sys.stdout.write("\\x1b[?1049h")
    sys.stdout.write("\\x1b[2J\\x1b[H")
    sys.stdout.write("\\x1b[1;1H┌──── Claude Code ────┐")
    sys.stdout.write("\\x1b[2;1H│ 欢迎回来           │")
    sys.stdout.write("\\x1b[4;12HWelcome back!")
    sys.stdout.write(f"\\x1b[8;{left}H┌──── 菜单 ────┐")
    sys.stdout.write(f"\\x1b[9;{left}H│ 继续  设置  │")
    sys.stdout.write(f"\\x1b[10;{left}H└─────────────┘")
    sys.stdout.flush()

signal.signal(signal.SIGWINCH, draw)
draw()
while True:
    time.sleep(1)
`.trimStart())
  return scriptPath
}

test("decodeTmuxControlValue decodes octal escapes and backslashes", () => {
  assert.equal(
    decodeTmuxControlValue("\\033[31mhi\\015\\012\\134done"),
    "\u001b[31mhi\r\n\\done",
  )
  assert.equal(
    decodeTmuxControlValue("\\342\\224\\200\\344\\275\\240\\345\\245\\275│"),
    "─你好│",
  )
})

test("encodeTmuxInput preserves utf8 text and binary payloads", () => {
  assert.deepEqual(
    encodeTmuxInput("你好"),
    ["e4", "bd", "a0", "e5", "a5", "bd"],
  )
  assert.deepEqual(
    encodeTmuxInput("\u0080\u00ff", { binary: true }),
    ["80", "ff"],
  )
})

test("control mode manager replays output and preserves scrollback across grow/shrink", { skip: !hasTmux() }, async () => {
  await withSocketName("control-scrollback", async () => {
    const manager = new ControlModeTerminalManager()
    const session = await createSession({
      cols: 80,
      cwd: process.cwd(),
      rows: 5,
    })
    const terminal = new Terminal({
      cols: 80,
      rows: 5,
      scrollback: 5000,
    })
    const exitEvents = []
    const transport = createMockSender(terminal, exitEvents)

    try {
      await wait(300)
      await sendLine(
        session.sessionId,
        "for i in $(seq 1 14); do printf 'line-%02d\\n' \"$i\"; done",
      )
      await wait(300)

      await manager.attachSession(transport.sender, session.sessionId, {
        cols: 80,
        cwd: process.cwd(),
        rows: 5,
      })

      await waitFor(async () => {
        await transport.waitForRender()
        return readTerminalText(terminal).includes("line-14")
      })

      await sendLine(
        session.sessionId,
        "printf 'unicode-─你好│\\n'",
      )
      await waitFor(async () => {
        await transport.waitForRender()
        return readTerminalText(terminal).includes("unicode-─你好│")
      })

      const lengthBeforeResize = terminal.buffer.active.length
      assert.ok(lengthBeforeResize > terminal.rows)

      terminal.resize(80, 20)
      await manager.resizeSession(session.sessionId, 80, 20)
      await transport.waitForRender()

      terminal.resize(80, 5)
      await manager.resizeSession(session.sessionId, 80, 5)
      await transport.waitForRender()

      assert.ok(terminal.buffer.active.length >= lengthBeforeResize)
      assert.ok(terminal.buffer.active.length > terminal.rows)
      assert.ok(terminal.buffer.active.baseY > 0)

      await manager.writeToSession(session.sessionId, "printf 'typed-你好\\n'")
      await manager.writeToSession(session.sessionId, "\r")

      await waitFor(async () => {
        await transport.waitForRender()
        return readTerminalText(terminal).includes("typed-你好")
      })

      assert.deepEqual(exitEvents, [])
    } finally {
      manager.detachSession(session.sessionId)
      terminal.dispose()
      await killSession(session.sessionId)
    }
  })
})

test("control mode manager emits terminal exit when session is killed", { skip: !hasTmux() }, async () => {
  await withSocketName("control-exit", async () => {
    const manager = new ControlModeTerminalManager()
    const session = await createSession({
      cols: 40,
      cwd: process.cwd(),
      rows: 5,
    })
    const terminal = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 100,
    })
    const exitEvents = []
    const transport = createMockSender(terminal, exitEvents)

    try {
      await manager.attachSession(transport.sender, session.sessionId, {
        cols: 40,
        cwd: process.cwd(),
        rows: 5,
      })

      await killSession(session.sessionId)

      await waitFor(() => exitEvents.length > 0)
      assert.equal(exitEvents[0].sessionId, session.sessionId)
    } finally {
      manager.detachSession(session.sessionId)
      terminal.dispose()
    }
  })
})

test("control mode manager redraws alternate-screen TUI on small attach", { skip: !hasTmux() }, async () => {
  await withSocketName("control-alternate", async () => {
    const manager = new ControlModeTerminalManager()
    const session = await createSession({
      cols: 30,
      cwd: process.cwd(),
      rows: 12,
    })
    const terminal = new Terminal({
      cols: 30,
      rows: 12,
      scrollback: 200,
    })
    const exitEvents = []
    const transport = createMockSender(terminal, exitEvents)
    const scriptPath = writeAltScreenDemoScript()

    try {
      await wait(300)
      await sendLine(session.sessionId, `python3 ${JSON.stringify(scriptPath)}`)
      await wait(400)

      await manager.attachSession(transport.sender, session.sessionId, {
        cols: 30,
        cwd: process.cwd(),
        rows: 12,
      })

      await waitFor(async () => {
        await transport.waitForRender()
        const text = readTerminalText(terminal)
        return (
          text.includes("Claude Code")
          && text.includes("Welcome back!")
          && text.includes("菜单")
        )
      }, 4000)

      const text = readTerminalText(terminal)
      assert.ok(text.includes("Claude Code"))
      assert.ok(text.includes("Welcome back!"))
      assert.ok(text.includes("菜单"))
      assert.deepEqual(exitEvents, [])
    } finally {
      manager.detachSession(session.sessionId)
      terminal.dispose()
      await killSession(session.sessionId)
    }
  })
})

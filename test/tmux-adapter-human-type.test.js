const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")

const {
  createSession,
  killSession,
  readSession,
  typeHumanToPane,
} = require("../src/runtime/tmux-adapter")

const SENTINEL_TEXT = "[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox"

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/gu, "")
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test("typeHumanToPane preserves sentinel punctuation", { skip: !hasTmux() }, async () => {
  const session = await createSession({ cwd: process.cwd(), cols: 100, rows: 28 })

  try {
    await wait(600)
    await typeHumanToPane(session.tmuxPaneId, SENTINEL_TEXT)
    await wait(300)

    const screen = await readSession(session.sessionId, { lines: 120 })
    assert.match(stripAnsi(screen.output), new RegExp(SENTINEL_TEXT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
  } finally {
    await killSession(session.sessionId)
  }
})

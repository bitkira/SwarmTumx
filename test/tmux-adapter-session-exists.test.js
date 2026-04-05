const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")

const {
  createSession,
  killSession,
  sessionExists,
} = require("../src/runtime/tmux-adapter")

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

test("sessionExists returns false when tmux socket is missing", { skip: !hasTmux() }, async () => {
  const previousSocketName = process.env.SWARMTUMX_TMUX_SOCKET_NAME
  process.env.SWARMTUMX_TMUX_SOCKET_NAME = `swarmtumx-missing-${Date.now()}`

  try {
    await assert.doesNotReject(() => sessionExists("missing-session"))
    assert.equal(await sessionExists("missing-session"), false)
  } finally {
    if (previousSocketName == null) {
      delete process.env.SWARMTUMX_TMUX_SOCKET_NAME
    } else {
      process.env.SWARMTUMX_TMUX_SOCKET_NAME = previousSocketName
    }
  }
})

test("createSession applies the bundled tmux mouse setting", { skip: !hasTmux() }, async () => {
  const session = await createSession({ cwd: process.cwd(), cols: 80, rows: 24 })

  try {
    const mouseSetting = execFileSync(
      "tmux",
      ["-L", "swarmtumx", "-f", "tmux.conf", "show", "-g", "mouse"],
      { encoding: "utf8" },
    ).trim()

    assert.equal(mouseSetting, "mouse off")
  } finally {
    await killSession(session.sessionId)
  }
})

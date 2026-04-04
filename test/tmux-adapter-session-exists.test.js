const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")

const { sessionExists } = require("../src/runtime/tmux-adapter")

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

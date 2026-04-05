const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")

const { closeAgentDb } = require("../src/runtime/agent-db")
const { stopBrokerDaemon } = require("../src/runtime/agent-broker")
const {
  createSession,
  killSession,
  readSession,
  sendKeys,
  typeText,
} = require("../src/runtime/tmux-adapter")

const SENTINEL_TEXT = "[SWARMTUMX_NOTIFY] pending inbox items; use read_inbox"
const RELATION_ACCEPTED_TEXT = "[SWARMTUMX_NOTIFY] relation requests accepted"

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFileJson(filePath, timeoutMs = 6000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").trim()
      if (raw) {
        try {
          return JSON.parse(raw)
        } catch {
          await wait(100)
          continue
        }
      }
    }
    await wait(100)
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

async function runAgentCommandInSession(sessionId, command, outputFile) {
  const script = `${command} > ${shellEscape(outputFile)} 2>&1`
  await typeText(sessionId, script)
  await sendKeys(sessionId, ["Enter"])
  return waitForFileJson(outputFile)
}

function countOccurrences(haystack, needle) {
  return String(haystack).split(needle).length - 1
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/gu, "")
}

test.afterEach(() => {
  closeAgentDb()
})

test("broker delivers one wake per quiet window and re-delivers for later events", { skip: !hasTmux() }, async () => {
  const repoRoot = path.resolve(__dirname, "..")
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-broker-test-"))
  const dataDir = path.join(tempDir, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  process.env.SWARMTUMX_DATA_DIR = dataDir

  await stopBrokerDaemon()

  const aliceSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const bobSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const out = (name) => path.join(tempDir, `${name}.json`)
  const prefix = `cd ${shellEscape(repoRoot)} && SWARMTUMX_DATA_DIR=${shellEscape(dataDir)}`

  try {
    await wait(600)

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login alice --trigger-keys Enter`,
      out("alice-login"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login bob --trigger-keys Enter`,
      out("bob-login"),
    )

    const relationRequest = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs request_relation bob`,
      out("request-relation"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs respond_relation_request ${shellEscape(relationRequest.request.requestId)} accept`,
      out("accept-relation"),
    )

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs send_message bob ${shellEscape("m1")}`,
      out("message-1"),
    )
    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs send_message bob ${shellEscape("m2")}`,
      out("message-2"),
    )

    await wait(4500)
    const firstScreen = await readSession(bobSession.sessionId, { lines: 400 })
    assert.equal(countOccurrences(stripAnsi(firstScreen.output), SENTINEL_TEXT), 1)

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs send_message bob ${shellEscape("m3")}`,
      out("message-3"),
    )

    await wait(4500)
    const secondScreen = await readSession(bobSession.sessionId, { lines: 400 })
    assert.equal(countOccurrences(stripAnsi(secondScreen.output), SENTINEL_TEXT), 2)
  } finally {
    await stopBrokerDaemon()
    await killSession(aliceSession.sessionId)
    await killSession(bobSession.sessionId)
  }
})

test("broker sends a relation-accepted status notification", { skip: !hasTmux() }, async () => {
  const repoRoot = path.resolve(__dirname, "..")
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-broker-test-"))
  const dataDir = path.join(tempDir, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  process.env.SWARMTUMX_DATA_DIR = dataDir

  await stopBrokerDaemon()

  const aliceSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const bobSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const out = (name) => path.join(tempDir, `${name}.json`)
  const prefix = `cd ${shellEscape(repoRoot)} && SWARMTUMX_DATA_DIR=${shellEscape(dataDir)}`

  try {
    await wait(600)

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login alice --trigger-keys Enter`,
      out("alice-login"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login bob --trigger-keys Enter`,
      out("bob-login"),
    )

    const relationRequest = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs request_relation bob`,
      out("request-relation"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs respond_relation_request ${shellEscape(relationRequest.request.requestId)} accept`,
      out("accept-relation"),
    )

    await wait(4500)
    const aliceScreen = await readSession(aliceSession.sessionId, { lines: 400 })
    assert.equal(countOccurrences(stripAnsi(aliceScreen.output), RELATION_ACCEPTED_TEXT), 1)
    assert.equal(countOccurrences(stripAnsi(aliceScreen.output), SENTINEL_TEXT), 0)

    const aliceInbox = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_inbox`,
      out("alice-inbox"),
    )
    assert.deepEqual(aliceInbox.pendingRelationRequests, [])
    assert.deepEqual(aliceInbox.unreadThreads, [])
  } finally {
    await stopBrokerDaemon()
    await killSession(aliceSession.sessionId)
    await killSession(bobSession.sessionId)
  }
})

test("broker skips inbox wake when unread content was read before delivery", { skip: !hasTmux() }, async () => {
  const repoRoot = path.resolve(__dirname, "..")
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-broker-test-"))
  const dataDir = path.join(tempDir, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  process.env.SWARMTUMX_DATA_DIR = dataDir

  await stopBrokerDaemon()

  const aliceSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const bobSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const out = (name) => path.join(tempDir, `${name}.json`)
  const prefix = `cd ${shellEscape(repoRoot)} && SWARMTUMX_DATA_DIR=${shellEscape(dataDir)}`

  try {
    await wait(600)

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login alice --trigger-keys Enter`,
      out("alice-login"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login bob --trigger-keys Enter`,
      out("bob-login"),
    )

    const relationRequest = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs request_relation bob`,
      out("request-relation"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs respond_relation_request ${shellEscape(relationRequest.request.requestId)} accept`,
      out("accept-relation"),
    )

    await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs send_message bob ${shellEscape("m1")}`,
      out("message-1"),
    )

    const bobInbox = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_inbox`,
      out("bob-inbox"),
    )
    await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_messages ${shellEscape(bobInbox.unreadThreads[0].threadId)}`,
      out("bob-read"),
    )

    await wait(4500)
    const bobScreen = await readSession(bobSession.sessionId, { lines: 400 })
    assert.equal(countOccurrences(stripAnsi(bobScreen.output), SENTINEL_TEXT), 0)

    const bobInboxAfter = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_inbox`,
      out("bob-inbox-after"),
    )
    assert.deepEqual(bobInboxAfter.pendingRelationRequests, [])
    assert.deepEqual(bobInboxAfter.unreadThreads, [])
  } finally {
    await stopBrokerDaemon()
    await killSession(aliceSession.sessionId)
    await killSession(bobSession.sessionId)
  }
})

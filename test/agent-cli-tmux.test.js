const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const assert = require("node:assert/strict")
const test = require("node:test")
const { execFileSync } = require("node:child_process")

const { closeAgentDb } = require("../src/runtime/agent-db")
const {
  createSession,
  killSession,
  readSession,
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

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function waitForFileJson(filePath, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").trim()
      if (raw) {
        try {
          return JSON.parse(raw)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

async function runAgentCommandInSession(sessionId, command, outputFile) {
  const script = `${command} > ${shellEscape(outputFile)} 2>&1`
  await typeText(sessionId, script)
  await sendKeys(sessionId, ["Enter"])
  return waitForFileJson(outputFile)
}

test.afterEach(() => {
  closeAgentDb()
})

test("agent CLI works inside real tmux panes", { skip: !hasTmux() }, async () => {
  const repoRoot = path.resolve(__dirname, "..")
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-cli-"))
  const dataDir = path.join(tempDir, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const aliceSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })
  const bobSession = await createSession({ cwd: repoRoot, cols: 100, rows: 28 })

  const out = (name) => path.join(tempDir, `${name}.json`)
  const prefix = `cd ${shellEscape(repoRoot)} && SWARMTUMX_DATA_DIR=${shellEscape(dataDir)}`

  try {
    await new Promise((resolve) => setTimeout(resolve, 600))

    const aliceLogin = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login alice --trigger-keys Enter`,
      out("alice-login"),
    )
    assert.equal(aliceLogin.account.accountId, "alice")

    const bobLogin = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs login bob --trigger-keys Enter`,
      out("bob-login"),
    )
    assert.equal(bobLogin.account.accountId, "bob")

    const relationRequest = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs request_relation bob`,
      out("request-relation"),
    )
    assert.equal(relationRequest.request.requesterAccountId, "alice")

    const accept = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs respond_relation_request ${shellEscape(relationRequest.request.requestId)} accept`,
      out("accept-relation"),
    )
    assert.equal(accept.request.status, "accepted")

    const sent = await runAgentCommandInSession(
      aliceSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs send_message bob ${shellEscape("hello from alice in tmux")}`,
      out("send-message"),
    )
    assert.equal(sent.message.senderAccountId, "alice")

    const bobInbox = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_inbox`,
      out("bob-inbox"),
    )
    assert.equal(bobInbox.unreadThreads.length, 1)
    assert.equal(bobInbox.unreadThreads[0].latestMessage.body, "hello from alice in tmux")

    const bobMessages = await runAgentCommandInSession(
      bobSession.sessionId,
      `${prefix} node ./bin/swarmtumx-agent.cjs read_messages ${shellEscape(bobInbox.unreadThreads[0].threadId)}`,
      out("bob-read-messages"),
    )
    assert.equal(bobMessages.messages.length, 1)
    assert.equal(bobMessages.messages[0].body, "hello from alice in tmux")
  } finally {
    await killSession(aliceSession.sessionId)
    await killSession(bobSession.sessionId)
  }
})

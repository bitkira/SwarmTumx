const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const assert = require("node:assert/strict")

const { closeAgentDb } = require("../src/runtime/agent-db")
const { stopBrokerDaemon } = require("../src/runtime/agent-broker")
const {
  listRelations,
  login,
  logout,
  readInbox,
  readMessages,
  requestRelation,
  respondRelationRequest,
  removeRelation,
  searchMessages,
  sendMessage,
  whoami,
} = require("../src/runtime/agent-service")
const {
  createSession,
  killSession,
  sendKeysToPane,
  typeToPane,
} = require("../src/runtime/tmux-adapter")

function runtimeContext(sessionId, paneId) {
  return {
    sessionId,
    tmuxPaneId: paneId,
    tmuxSessionName: `swarmtumx-${sessionId}`,
    tmuxSocketName: "swarmtumx",
    tmuxWindowId: "@1",
  }
}

test.afterEach(() => {
  closeAgentDb()
})

async function waitForJsonFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").trim()
      if (!raw) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      try {
        return JSON.parse(raw)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

test("login, whoami, logout and rebinding revoke old binding", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-test-"))
  process.env.SWARMTUMX_DATA_DIR = tempDir

  const alpha = runtimeContext("session-alpha", "%101")
  const beta = runtimeContext("session-beta", "%102")

  const firstLogin = await login({
    accountId: "alice",
    runtimeContext: alpha,
  })
  assert.equal(firstLogin.account.accountId, "alice")
  assert.equal(firstLogin.binding.tmuxPaneId, "%101")

  const firstWhoami = await whoami({ runtimeContext: alpha })
  assert.equal(firstWhoami.loggedIn, true)
  assert.equal(firstWhoami.binding.accountId, "alice")

  const secondLogin = await login({
    accountId: "alice",
    runtimeContext: beta,
  })
  assert.equal(secondLogin.binding.tmuxPaneId, "%102")

  const oldPaneWhoami = await whoami({ runtimeContext: alpha })
  assert.equal(oldPaneWhoami.loggedIn, false)

  const newPaneWhoami = await whoami({ runtimeContext: beta })
  assert.equal(newPaneWhoami.loggedIn, true)

  const logoutResult = await logout({ runtimeContext: beta })
  assert.equal(logoutResult.loggedOut, true)

  const finalWhoami = await whoami({ runtimeContext: beta })
  assert.equal(finalWhoami.loggedIn, false)
})

test("relation request, accept, messaging, inbox and search flow", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-test-"))
  process.env.SWARMTUMX_DATA_DIR = tempDir

  const alice = runtimeContext("session-alice", "%201")
  const bob = runtimeContext("session-bob", "%202")

  await login({ accountId: "alice", runtimeContext: alice })
  await login({ accountId: "bob", runtimeContext: bob })

  const relationRequest = await requestRelation({
    runtimeContext: alice,
    targetId: "bob",
  })
  assert.equal(relationRequest.created, true)

  const bobInboxBefore = await readInbox({ runtimeContext: bob })
  assert.equal(bobInboxBefore.pendingRelationRequests.length, 1)
  assert.equal(bobInboxBefore.pendingRelationRequests[0].requesterAccountId, "alice")

  const acceptResult = await respondRelationRequest({
    decision: "accept",
    requestId: relationRequest.request.requestId,
    runtimeContext: bob,
  })
  assert.equal(acceptResult.request.status, "accepted")
  assert.equal(acceptResult.relation.status, "active")

  const aliceRelations = await listRelations({ runtimeContext: alice })
  assert.equal(aliceRelations.relations.length, 1)
  assert.equal(aliceRelations.relations[0].counterpartAccountId, "bob")

  const sent = await sendMessage({
    body: "hello bob from alice",
    runtimeContext: alice,
    targetAccountId: "bob",
  })
  assert.equal(sent.message.threadSeq, 1)

  const bobInboxAfter = await readInbox({ runtimeContext: bob })
  assert.equal(bobInboxAfter.unreadThreads.length, 1)
  assert.equal(bobInboxAfter.unreadThreads[0].unreadCount, 1)
  assert.equal(bobInboxAfter.unreadThreads[0].latestMessage.body, "hello bob from alice")

  const threadId = bobInboxAfter.unreadThreads[0].threadId
  const bobMessages = await readMessages({
    runtimeContext: bob,
    threadId,
  })
  assert.equal(bobMessages.messages.length, 1)
  assert.equal(bobMessages.messages[0].body, "hello bob from alice")

  const bobInboxPostRead = await readInbox({ runtimeContext: bob })
  assert.equal(bobInboxPostRead.unreadThreads.length, 0)

  const bobSearch = await searchMessages({
    query: "alice",
    runtimeContext: bob,
  })
  assert.equal(bobSearch.results.length, 1)
  assert.equal(bobSearch.results[0].threadId, threadId)
})

test("request_relation requires an existing target account", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-test-"))
  process.env.SWARMTUMX_DATA_DIR = tempDir

  const alice = runtimeContext("session-alice", "%251")
  await login({ accountId: "alice", runtimeContext: alice })

  await assert.rejects(
    requestRelation({
      runtimeContext: alice,
      targetId: "missing-bob",
    }),
    /target account not found/,
  )
})

test("tmux integration: createSession and login from inside pane", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-test-"))
  process.env.SWARMTUMX_DATA_DIR = tempDir

  let session = null
  try {
    session = await createSession({
      cwd: path.join(__dirname, ".."),
    })
  } catch (error) {
    if (/tmux was not found/u.test(String(error.message || ""))) {
      context.skip("tmux not available")
      return
    }
    throw error
  }

  try {
    const outputPath = path.join(tempDir, "login-output.json")
    const cliPath = path.join(__dirname, "..", "bin", "swarmtumx-agent.cjs")
    const command = `${process.execPath} ${cliPath} login integ_alice > ${outputPath}`

    await typeToPane(session.tmuxPaneId, command, {
      socketName: session.tmuxSocketName,
    })
    await sendKeysToPane(session.tmuxPaneId, ["Enter"], {
      socketName: session.tmuxSocketName,
    })

    const parsed = await waitForJsonFile(outputPath)
    assert.equal(parsed.account.accountId, "integ_alice")
    assert.equal(parsed.binding.sessionId, session.sessionId)

    const whoamiPath = path.join(tempDir, "whoami-output.json")
    const whoamiCommand = `${process.execPath} ${cliPath} whoami > ${whoamiPath}`
    await typeToPane(session.tmuxPaneId, whoamiCommand, {
      socketName: session.tmuxSocketName,
    })
    await sendKeysToPane(session.tmuxPaneId, ["Enter"], {
      socketName: session.tmuxSocketName,
    })

    const whoamiParsed = await waitForJsonFile(whoamiPath)
    assert.equal(whoamiParsed.loggedIn, true)
    assert.equal(whoamiParsed.binding.tmuxPaneId, session.tmuxPaneId)
  } finally {
    await stopBrokerDaemon().catch(() => {})
    if (session) {
      await killSession(session.sessionId)
    }
  }
})

test("remove relation blocks future direct messaging and notifies counterpart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-agent-test-"))
  process.env.SWARMTUMX_DATA_DIR = tempDir

  const alice = runtimeContext("session-alice", "%301")
  const bob = runtimeContext("session-bob", "%302")

  await login({ accountId: "alice", runtimeContext: alice })
  await login({ accountId: "bob", runtimeContext: bob })

  const relationRequest = await requestRelation({
    runtimeContext: alice,
    targetId: "bob",
  })
  await respondRelationRequest({
    decision: "accept",
    requestId: relationRequest.request.requestId,
    runtimeContext: bob,
  })

  const relations = await listRelations({ runtimeContext: alice })
  const relationId = relations.relations[0].relationId

  const removed = await removeRelation({
    relationId,
    runtimeContext: alice,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.relation.status, "removed")

  await assert.rejects(
    sendMessage({
      body: "should fail",
      runtimeContext: alice,
      targetAccountId: "bob",
    }),
    /active relation required/,
  )

  const bobInbox = await readInbox({ runtimeContext: bob })
  assert.equal(bobInbox.latestEventSeq > 0, true)
})

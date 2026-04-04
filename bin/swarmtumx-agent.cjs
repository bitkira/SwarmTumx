#!/usr/bin/env node

const {
  brokerStatus,
  ensureBrokerDaemonRunning,
  runBrokerLoop,
  stopBrokerDaemon,
} = require("../src/runtime/agent-broker")
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function parseBoolean(value, fallback = undefined) {
  if (value == null) {
    return fallback
  }
  if (typeof value === "boolean") {
    return value
  }
  const normalized = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }
  throw new Error(`invalid boolean value: ${value}`)
}

function parseList(value) {
  if (value == null || value === "") {
    return undefined
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseFlagArgs(argv) {
  const positionals = []
  const flags = {}

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index]
    if (!part.startsWith("--")) {
      positionals.push(part)
      continue
    }

    const key = part.slice(2)
    const next = argv[index + 1]
    if (next == null || next.startsWith("--")) {
      flags[key] = true
      continue
    }

    flags[key] = next
    index += 1
  }

  return {
    flags,
    positionals,
  }
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  swarmtumx-agent login <account_id> [--display-name <name>] [--auto-wake <true|false>]",
      "  swarmtumx-agent login --new [--display-name <name>] [--prefix <account_prefix>] [--auto-wake <true|false>]",
      "  swarmtumx-agent whoami",
      "  swarmtumx-agent logout",
      "  swarmtumx-agent send_message <target_account_id> <body...>",
      "  swarmtumx-agent read_inbox",
      "  swarmtumx-agent read_messages <thread_id> [--limit <n>] [--before-thread-seq <n>] [--mark-read <true|false>]",
      "  swarmtumx-agent search_messages <query> [--thread-id <id>] [--limit <n>]",
      "  swarmtumx-agent request_relation <target_account_id> [--message <text>]",
      "  swarmtumx-agent respond_relation_request <request_id> <accept|reject>",
      "  swarmtumx-agent remove_relation <relation_id>",
      "  swarmtumx-agent list_relations",
      "  swarmtumx-agent broker-start",
      "  swarmtumx-agent broker-status",
      "  swarmtumx-agent broker-stop",
      "  swarmtumx-agent broker-run [--once]",
    ].join("\n"),
  )
}

async function maybeEnsureBroker(command) {
  if (![
    "login",
    "request_relation",
    "respond_relation_request",
    "remove_relation",
    "send_message",
  ].includes(command)) {
    return null
  }

  return ensureBrokerDaemonRunning(__filename)
}

async function main() {
  const [, , command, ...rest] = process.argv

  if (!command) {
    usage()
    process.exitCode = 1
    return
  }

  if (["help", "--help", "-h"].includes(command)) {
    usage()
    return
  }

  const { flags, positionals } = parseFlagArgs(rest)

  if (command === "login") {
    const [accountId] = positionals
    const createFresh = parseBoolean(flags.new, false)
    if (createFresh && accountId) {
      throw new Error("login accepts either <account_id> or --new, not both")
    }
    if (!createFresh && !accountId) {
      throw new Error("login requires <account_id> or --new")
    }
    const result = await login({
      accountId,
      accountIdPrefix: flags.prefix,
      autoWakeEnabled: parseBoolean(flags["auto-wake"], true),
      createFresh,
      displayName: flags["display-name"],
      preludeKeys: parseList(flags["prelude-keys"]),
      runtimeKind: flags["runtime-kind"] || "agent",
      triggerKeys: parseList(flags["trigger-keys"]),
    })
    await maybeEnsureBroker(command)
    printJson(result)
    return
  }

  if (command === "whoami") {
    printJson(await whoami())
    return
  }

  if (command === "logout") {
    printJson(await logout())
    return
  }

  if (command === "send_message") {
    const [targetAccountId, ...bodyParts] = positionals
    const body = flags.body || bodyParts.join(" ")
    const result = await sendMessage({
      body,
      targetAccountId,
    })
    await maybeEnsureBroker(command)
    printJson(result)
    return
  }

  if (command === "read_inbox") {
    printJson(await readInbox())
    return
  }

  if (command === "read_messages") {
    const [threadId] = positionals
    printJson(await readMessages({
      beforeThreadSeq: flags["before-thread-seq"],
      limit: flags.limit,
      markRead: parseBoolean(flags["mark-read"], true),
      threadId,
    }))
    return
  }

  if (command === "search_messages") {
    const [query] = positionals
    printJson(await searchMessages({
      limit: flags.limit,
      query,
      threadId: flags["thread-id"],
    }))
    return
  }

  if (command === "request_relation") {
    const [targetId] = positionals
    const result = await requestRelation({
      message: flags.message,
      targetId,
      targetKind: "account",
    })
    await maybeEnsureBroker(command)
    printJson(result)
    return
  }

  if (command === "respond_relation_request") {
    const [requestId, decision] = positionals
    const result = await respondRelationRequest({
      decision,
      requestId,
    })
    await maybeEnsureBroker(command)
    printJson(result)
    return
  }

  if (command === "remove_relation") {
    const [relationId] = positionals
    const result = await removeRelation({
      relationId,
    })
    await maybeEnsureBroker(command)
    printJson(result)
    return
  }

  if (command === "list_relations") {
    printJson(await listRelations())
    return
  }

  if (command === "broker-start") {
    printJson(await ensureBrokerDaemonRunning(__filename))
    return
  }

  if (command === "broker-status") {
    printJson(brokerStatus())
    return
  }

  if (command === "broker-stop") {
    printJson(await stopBrokerDaemon())
    return
  }

  if (command === "broker-run") {
    await runBrokerLoop({
      once: parseBoolean(flags.once, false),
    })
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})

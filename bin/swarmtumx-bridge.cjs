#!/usr/bin/env node

const {
  createSession,
  killSession,
  listSessions,
  readSession,
  resizeSession,
  sendKeys,
  sessionExists,
  typeText,
} = require("../src/runtime/tmux-adapter");

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  swarmtumx-bridge create [cwd] [cols] [rows]",
      "  swarmtumx-bridge list",
      "  swarmtumx-bridge exists <sessionId>",
      "  swarmtumx-bridge read <sessionId> [lines]",
      "  swarmtumx-bridge type <sessionId> <text>",
      "  swarmtumx-bridge keys <sessionId> <key...>",
      "  swarmtumx-bridge resize <sessionId> <cols> <rows>",
      "  swarmtumx-bridge kill <sessionId>",
    ].join("\n"),
  );
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (command === "create") {
    const [cwd, cols, rows] = args;
    const created = await createSession({
      cwd: cwd || process.cwd(),
      cols: cols ? Number(cols) : undefined,
      rows: rows ? Number(rows) : undefined,
    });
    printJson(created);
    return;
  }

  if (command === "list") {
    printJson(await listSessions());
    return;
  }

  if (command === "exists") {
    printJson({
      sessionId: args[0],
      exists: await sessionExists(args[0]),
    });
    return;
  }

  if (command === "read") {
    const [sessionId, lines] = args;
    printJson(await readSession(sessionId, {
      lines: lines ? Number(lines) : undefined,
    }));
    return;
  }

  if (command === "type") {
    const [sessionId, ...textParts] = args;
    await typeText(sessionId, textParts.join(" "));
    printJson({ ok: true });
    return;
  }

  if (command === "keys") {
    const [sessionId, ...keys] = args;
    await sendKeys(sessionId, keys);
    printJson({ ok: true });
    return;
  }

  if (command === "resize") {
    const [sessionId, cols, rows] = args;
    await resizeSession(sessionId, Number(cols), Number(rows));
    printJson({ ok: true });
    return;
  }

  if (command === "kill") {
    await killSession(args[0]);
    printJson({ ok: true });
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

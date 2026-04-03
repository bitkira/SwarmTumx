const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createSession,
  describePane,
  describeSession,
  killSession,
  listSessions,
  readPane,
  readSession,
  resizeSession,
  sendKeys,
  sendKeysToPane,
  sessionExists,
  typeHumanToPane,
  typeToPane,
  typeText,
} = require("../runtime/tmux-adapter");
const { TmuxTerminalManager } = require("../runtime/tmux-terminal-manager");
const {
  loadCanvasState,
  saveCanvasState,
} = require("../runtime/state-store");
const {
  getWorkspaceRoot,
} = require("../runtime/paths");

let mainWindow = null;
let terminalManager = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#181818",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  const senderId = mainWindow.webContents.id;
  mainWindow.webContents.once("destroyed", () => {
    terminalManager?.detachSender(senderId);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  terminalManager = new TmuxTerminalManager();

  ipcMain.handle("app:get-workspace-root", () => getWorkspaceRoot());

  ipcMain.handle("canvas:load-state", () => loadCanvasState());
  ipcMain.handle("canvas:save-state", (_event, state) => saveCanvasState(state));

  ipcMain.handle("tmux:create-session", (_event, options) =>
    createSession({
      cwd: options?.cwd || getWorkspaceRoot(),
      cols: options?.cols,
      rows: options?.rows,
    })
  );
  ipcMain.handle("tmux:list-sessions", () => listSessions());
  ipcMain.handle("tmux:describe-pane", (_event, tmuxPaneId) => describePane(tmuxPaneId));
  ipcMain.handle("tmux:describe-session", (_event, sessionId) => describeSession(sessionId));
  ipcMain.handle("tmux:session-exists", (_event, sessionId) => sessionExists(sessionId));
  ipcMain.handle("tmux:read-pane", (_event, tmuxPaneId, options) => readPane(tmuxPaneId, options));
  ipcMain.handle("tmux:read-session", (_event, sessionId, options) => readSession(sessionId, options));
  ipcMain.handle("tmux:type-pane", (_event, tmuxPaneId, text) => typeToPane(tmuxPaneId, text));
  ipcMain.handle("tmux:type-human-pane", (_event, tmuxPaneId, text, options) =>
    typeHumanToPane(tmuxPaneId, text, options)
  );
  ipcMain.handle("tmux:type-text", (_event, sessionId, text) => typeText(sessionId, text));
  ipcMain.handle("tmux:send-keys-pane", (_event, tmuxPaneId, keys) => sendKeysToPane(tmuxPaneId, keys));
  ipcMain.handle("tmux:send-keys", (_event, sessionId, keys) => sendKeys(sessionId, keys));
  ipcMain.handle("tmux:resize-session", (_event, sessionId, cols, rows) =>
    resizeSession(sessionId, cols, rows)
  );
  ipcMain.handle("tmux:kill-session", (_event, sessionId) => killSession(sessionId));

  ipcMain.handle("terminal:attach-session", (event, sessionId, options) =>
    terminalManager.attachSession(event.sender, sessionId, options)
  );
  ipcMain.handle("terminal:detach-session", (_event, sessionId) =>
    terminalManager.detachSession(sessionId)
  );
  ipcMain.handle("terminal:resize-session", (_event, sessionId, cols, rows) =>
    terminalManager.resizeSession(sessionId, cols, rows)
  );
  ipcMain.handle("terminal:write", (_event, sessionId, data) =>
    terminalManager.writeToSession(sessionId, data)
  );
}

app.whenReady().then(() => {
  registerIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

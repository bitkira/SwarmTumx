const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  createSession,
  describeSession,
  killSession,
  listSessions,
  readSession,
  resizeSession,
  sendKeys,
  sessionExists,
  typeText,
} = require("../runtime/tmux-adapter");
const {
  loadCanvasState,
  saveCanvasState,
} = require("../runtime/state-store");
const {
  getWorkspaceRoot,
} = require("../runtime/paths");

let mainWindow = null;

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
}

function registerIpc() {
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
  ipcMain.handle("tmux:describe-session", (_event, sessionId) => describeSession(sessionId));
  ipcMain.handle("tmux:session-exists", (_event, sessionId) => sessionExists(sessionId));
  ipcMain.handle("tmux:read-session", (_event, sessionId, options) => readSession(sessionId, options));
  ipcMain.handle("tmux:type-text", (_event, sessionId, text) => typeText(sessionId, text));
  ipcMain.handle("tmux:send-keys", (_event, sessionId, keys) => sendKeys(sessionId, keys));
  ipcMain.handle("tmux:resize-session", (_event, sessionId, cols, rows) =>
    resizeSession(sessionId, cols, rows)
  );
  ipcMain.handle("tmux:kill-session", (_event, sessionId) => killSession(sessionId));
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

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("swarmTumx", {
  app: {
    getWorkspaceRoot: () => ipcRenderer.invoke("app:get-workspace-root"),
  },
  canvas: {
    loadState: () => ipcRenderer.invoke("canvas:load-state"),
    saveState: (state) => ipcRenderer.invoke("canvas:save-state", state),
  },
  tmux: {
    createSession: (options) => ipcRenderer.invoke("tmux:create-session", options),
    listSessions: () => ipcRenderer.invoke("tmux:list-sessions"),
    describeSession: (sessionId) => ipcRenderer.invoke("tmux:describe-session", sessionId),
    sessionExists: (sessionId) => ipcRenderer.invoke("tmux:session-exists", sessionId),
    readSession: (sessionId, options) => ipcRenderer.invoke("tmux:read-session", sessionId, options),
    typeText: (sessionId, text) => ipcRenderer.invoke("tmux:type-text", sessionId, text),
    sendKeys: (sessionId, keys) => ipcRenderer.invoke("tmux:send-keys", sessionId, keys),
    resizeSession: (sessionId, cols, rows) =>
      ipcRenderer.invoke("tmux:resize-session", sessionId, cols, rows),
    killSession: (sessionId) => ipcRenderer.invoke("tmux:kill-session", sessionId),
  },
});

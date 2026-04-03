const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

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
    describePane: (tmuxPaneId) => ipcRenderer.invoke("tmux:describe-pane", tmuxPaneId),
    listSessions: () => ipcRenderer.invoke("tmux:list-sessions"),
    describeSession: (sessionId) => ipcRenderer.invoke("tmux:describe-session", sessionId),
    sessionExists: (sessionId) => ipcRenderer.invoke("tmux:session-exists", sessionId),
    readPane: (tmuxPaneId, options) => ipcRenderer.invoke("tmux:read-pane", tmuxPaneId, options),
    readSession: (sessionId, options) => ipcRenderer.invoke("tmux:read-session", sessionId, options),
    typePane: (tmuxPaneId, text) => ipcRenderer.invoke("tmux:type-pane", tmuxPaneId, text),
    typeHumanPane: (tmuxPaneId, text, options) =>
      ipcRenderer.invoke("tmux:type-human-pane", tmuxPaneId, text, options),
    typeText: (sessionId, text) => ipcRenderer.invoke("tmux:type-text", sessionId, text),
    sendKeysToPane: (tmuxPaneId, keys) => ipcRenderer.invoke("tmux:send-keys-pane", tmuxPaneId, keys),
    sendKeys: (sessionId, keys) => ipcRenderer.invoke("tmux:send-keys", sessionId, keys),
    resizeSession: (sessionId, cols, rows) =>
      ipcRenderer.invoke("tmux:resize-session", sessionId, cols, rows),
    killSession: (sessionId) => ipcRenderer.invoke("tmux:kill-session", sessionId),
  },
  terminal: {
    attachSession: (sessionId, options) =>
      ipcRenderer.invoke("terminal:attach-session", sessionId, options),
    detachSession: (sessionId) => ipcRenderer.invoke("terminal:detach-session", sessionId),
    resizeSession: (sessionId, cols, rows) =>
      ipcRenderer.invoke("terminal:resize-session", sessionId, cols, rows),
    write: (sessionId, data) => ipcRenderer.invoke("terminal:write", sessionId, data),
    onData: (handler) => subscribe("terminal:data", handler),
    onExit: (handler) => subscribe("terminal:exit", handler),
  },
});

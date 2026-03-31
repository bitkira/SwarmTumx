const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, getDataDir } = require("./paths");

const DEFAULT_CANVAS_STATE = {
  viewport: {
    panX: 320,
    panY: 160,
    zoom: 0.8,
  },
  activeTileId: null,
  tiles: [],
};

function canvasStatePath() {
  return path.join(getDataDir(), "canvas-state.json");
}

function sessionMetaDir() {
  return ensureDir(path.join(getDataDir(), "sessions"));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadCanvasState() {
  const loaded = readJson(canvasStatePath(), DEFAULT_CANVAS_STATE);
  return {
    viewport: {
      ...DEFAULT_CANVAS_STATE.viewport,
      ...(loaded.viewport || {}),
    },
    activeTileId: loaded.activeTileId || null,
    tiles: Array.isArray(loaded.tiles) ? loaded.tiles : [],
  };
}

function saveCanvasState(state) {
  writeJson(canvasStatePath(), state);
  return state;
}

function sessionMetaPath(sessionId) {
  return path.join(sessionMetaDir(), `${sessionId}.json`);
}

function readSessionMeta(sessionId) {
  return readJson(sessionMetaPath(sessionId), null);
}

function writeSessionMeta(sessionId, meta) {
  writeJson(sessionMetaPath(sessionId), meta);
  return meta;
}

function deleteSessionMeta(sessionId) {
  try {
    fs.unlinkSync(sessionMetaPath(sessionId));
  } catch {
    // no-op
  }
}

function listSessionMeta() {
  const dir = sessionMetaDir();
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const sessionId = entry.replace(/\.json$/u, "");
      const meta = readSessionMeta(sessionId);
      return meta ? { sessionId, ...meta } : null;
    })
    .filter(Boolean);
}

module.exports = {
  DEFAULT_CANVAS_STATE,
  deleteSessionMeta,
  listSessionMeta,
  loadCanvasState,
  readSessionMeta,
  saveCanvasState,
  sessionMetaDir,
  writeSessionMeta,
};

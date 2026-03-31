const MIN_ZOOM = 0.33;
const MAX_ZOOM = 1;
const GRID_SIZE = 20;
const GRID_GROUP = 4;
const DEFAULT_TILE_WIDTH = 420;
const DEFAULT_TILE_HEIGHT = 260;
const MIN_TILE_WIDTH = 280;
const MIN_TILE_HEIGHT = 180;
const DEFAULT_CAPTURE_LINES = 240;
const POLL_INTERVAL_MS = 900;
const SAVE_DEBOUNCE_MS = 200;
const CHAR_WIDTH = 7.22;
const CELL_HEIGHT = 17;
const SPECIAL_KEY_MAP = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "BSpace",
  Delete: "DC",
  End: "End",
  Enter: "Enter",
  Escape: "Escape",
  Home: "Home",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Tab: "Tab",
};
const ANSI_OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const ANSI_CSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;

const api = window.swarmTumx;

const canvasShell = document.querySelector("#canvas-shell");
const canvasSurface = document.querySelector("#canvas-surface");
const gridLayer = document.querySelector("#grid-layer");
const zoomIndicator = document.querySelector("#zoom-indicator");

const state = {
  workspaceRoot: "",
  viewport: {
    panX: 320,
    panY: 160,
    zoom: 0.8,
  },
  activeTileId: null,
  tiles: [],
  outputs: new Map(),
  tileDomMap: new Map(),
  interaction: {
    type: null,
    tileId: null,
    dir: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
  },
};

let saveTimer = null;
let pollTimer = null;
let zoomIndicatorTimer = null;
let zoomSettleTimer = null;
let zoomAnimationFrame = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rubberBand(value, min, max, factor = 0.2) {
  if (value < min) {
    return min - (min - value) * factor;
  }
  if (value > max) {
    return max + (value - max) * factor;
  }
  return value;
}

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function getCanvasRect() {
  return canvasShell.getBoundingClientRect();
}

function worldFromClient(clientX, clientY) {
  const rect = getCanvasRect();
  return {
    x: (clientX - rect.left - state.viewport.panX) / state.viewport.zoom,
    y: (clientY - rect.top - state.viewport.panY) / state.viewport.zoom,
  };
}

function splitDisplayPath(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  if (parts.length === 0) {
    return { parent: "", name: "/" };
  }
  const name = parts.at(-1);
  const parent = filePath.slice(0, Math.max(0, filePath.length - name.length));
  return { parent, name };
}

function stripAnsi(text) {
  return String(text || "")
    .replaceAll("\r", "")
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "");
}

function estimateTerminalSize(tile) {
  return {
    cols: Math.max(80, Math.floor((tile.width - 16) / CHAR_WIDTH)),
    rows: Math.max(20, Math.floor((tile.height - 54) / CELL_HEIGHT)),
  };
}

function findTile(tileId) {
  return state.tiles.find((tile) => tile.id === tileId);
}

function getMaxZIndex() {
  return state.tiles.reduce((max, tile) => Math.max(max, tile.zIndex), 0);
}

function bringTileToFront(tileId) {
  const tile = findTile(tileId);
  if (!tile) {
    return;
  }
  tile.zIndex = getMaxZIndex() + 1;
}

function serializeCanvasState() {
  return {
    viewport: state.viewport,
    activeTileId: state.activeTileId,
    tiles: state.tiles.map((tile) => ({
      id: tile.id,
      sessionId: tile.sessionId,
      cwd: tile.cwd,
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      zIndex: tile.zIndex,
    })),
  };
}

function scheduleCanvasSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.canvas.saveState(serializeCanvasState());
  }, SAVE_DEBOUNCE_MS);
}

function showZoomIndicator() {
  zoomIndicator.textContent = `${Math.round(clamp(state.viewport.zoom, MIN_ZOOM, MAX_ZOOM) * 100)}%`;
  zoomIndicator.classList.add("is-visible");
  window.clearTimeout(zoomIndicatorTimer);
  zoomIndicatorTimer = window.setTimeout(() => {
    zoomIndicator.classList.remove("is-visible");
  }, 1200);
}

function setZoomAroundPoint(targetZoom, clientX, clientY, allowOvershoot = true) {
  const rect = getCanvasRect();
  const nextZoom = allowOvershoot
    ? rubberBand(targetZoom, MIN_ZOOM, MAX_ZOOM)
    : clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);

  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const worldX = (localX - state.viewport.panX) / state.viewport.zoom;
  const worldY = (localY - state.viewport.panY) / state.viewport.zoom;

  state.viewport.zoom = nextZoom;
  state.viewport.panX = localX - worldX * nextZoom;
  state.viewport.panY = localY - worldY * nextZoom;

  showZoomIndicator();
  drawGrid();
  positionAllTiles();
  scheduleCanvasSave();
}

function animateZoomTo(targetZoom) {
  window.cancelAnimationFrame(zoomAnimationFrame);

  const rect = getCanvasRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const startZoom = state.viewport.zoom;
  const nextZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);

  if (Math.abs(startZoom - nextZoom) < 0.001) {
    state.viewport.zoom = nextZoom;
    drawGrid();
    positionAllTiles();
    return;
  }

  const startTime = performance.now();
  const duration = 180;

  function step(now) {
    const t = clamp((now - startTime) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const zoom = startZoom + (nextZoom - startZoom) * eased;

    setZoomAroundPoint(zoom, centerX, centerY, false);

    if (t < 1) {
      zoomAnimationFrame = window.requestAnimationFrame(step);
    }
  }

  zoomAnimationFrame = window.requestAnimationFrame(step);
}

function queueZoomSettle() {
  window.clearTimeout(zoomSettleTimer);
  zoomSettleTimer = window.setTimeout(() => {
    animateZoomTo(clamp(state.viewport.zoom, MIN_ZOOM, MAX_ZOOM));
  }, 150);
}

function drawGrid() {
  const rect = getCanvasRect();
  const dpr = window.devicePixelRatio || 1;
  const context = gridLayer.getContext("2d");

  gridLayer.width = Math.floor(rect.width * dpr);
  gridLayer.height = Math.floor(rect.height * dpr);
  gridLayer.style.width = `${rect.width}px`;
  gridLayer.style.height = `${rect.height}px`;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const step = GRID_SIZE * state.viewport.zoom;
  const majorStep = step * GRID_GROUP;
  const offsetXMinor = ((state.viewport.panX % step) + step) % step;
  const offsetYMinor = ((state.viewport.panY % step) + step) % step;
  const offsetXMajor = ((state.viewport.panX % majorStep) + majorStep) % majorStep;
  const offsetYMajor = ((state.viewport.panY % majorStep) + majorStep) % majorStep;

  if (step >= 12) {
    const dotSize = Math.max(1, 1.5 * state.viewport.zoom);
    context.fillStyle = "rgba(255,255,255,0.15)";
    for (let x = offsetXMinor; x <= rect.width; x += step) {
      for (let y = offsetYMinor; y <= rect.height; y += step) {
        context.fillRect(Math.round(x), Math.round(y), dotSize, dotSize);
      }
    }
  }

  const majorDotSize = Math.max(1, 1.5 * state.viewport.zoom);
  context.fillStyle = "rgba(255,255,255,0.25)";
  for (let x = offsetXMajor; x <= rect.width; x += majorStep) {
    for (let y = offsetYMajor; y <= rect.height; y += majorStep) {
      context.fillRect(Math.round(x), Math.round(y), majorDotSize, majorDotSize);
    }
  }
}

function createResizeHandle(className, dir) {
  const handle = document.createElement("div");
  handle.className = `tile-resize-handle ${className}`;
  handle.dataset.resizeDir = dir;
  return handle;
}

function createTileDom(tile) {
  const container = document.createElement("div");
  container.className = "terminal-tile";
  container.dataset.tileId = tile.id;
  container.tabIndex = 0;

  const titleBar = document.createElement("div");
  titleBar.className = "tile-title-bar";
  titleBar.dataset.dragHandle = "true";

  const titleText = document.createElement("span");
  titleText.className = "tile-title-text";
  const parentSpan = document.createElement("span");
  parentSpan.className = "tile-title-parent";
  const nameSpan = document.createElement("span");
  nameSpan.className = "tile-title-name";
  titleText.append(parentSpan, nameSpan);

  const btnGroup = document.createElement("div");
  btnGroup.className = "tile-btn-group";
  const closeButton = document.createElement("button");
  closeButton.className = "tile-action-btn tile-close-btn";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close tile";
  btnGroup.append(closeButton);

  titleBar.append(titleText, btnGroup);

  const content = document.createElement("div");
  content.className = "tile-content";
  const output = document.createElement("pre");
  output.className = "terminal-output";
  output.tabIndex = -1;
  output.textContent = "Connecting...";
  content.append(output);

  container.append(titleBar, content);
  container.append(
    createResizeHandle("edge-n", "n"),
    createResizeHandle("edge-s", "s"),
    createResizeHandle("edge-e", "e"),
    createResizeHandle("edge-w", "w"),
    createResizeHandle("corner-nw", "nw"),
    createResizeHandle("corner-ne", "ne"),
    createResizeHandle("corner-sw", "sw"),
    createResizeHandle("corner-se", "se"),
  );

  const dom = {
    container,
    titleBar,
    titleText,
    parentSpan,
    nameSpan,
    closeButton,
    output,
    content,
  };

  wireTileEvents(tile, dom);
  updateTileDom(tile, dom);
  return dom;
}

function updateTileDom(tile, dom) {
  const label = splitDisplayPath(tile.cwd || state.workspaceRoot);
  dom.parentSpan.textContent = label.parent;
  dom.nameSpan.textContent = label.name;
  dom.titleText.title = tile.cwd || "";
  dom.container.classList.toggle("is-active", tile.id === state.activeTileId);
}

function positionTile(tile, dom) {
  const screenX = tile.x * state.viewport.zoom + state.viewport.panX;
  const screenY = tile.y * state.viewport.zoom + state.viewport.panY;
  dom.container.style.left = `${screenX}px`;
  dom.container.style.top = `${screenY}px`;
  dom.container.style.width = `${tile.width}px`;
  dom.container.style.height = `${tile.height}px`;
  dom.container.style.transform = `scale(${state.viewport.zoom})`;
  dom.container.style.zIndex = String(tile.zIndex);
}

function positionAllTiles() {
  state.tiles.forEach((tile) => {
    const dom = state.tileDomMap.get(tile.id);
    if (dom) {
      updateTileDom(tile, dom);
      positionTile(tile, dom);
    }
  });
}

function rebuildTiles() {
  canvasSurface.innerHTML = "";
  state.tileDomMap.clear();

  state.tiles
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .forEach((tile) => {
      const dom = createTileDom(tile);
      state.tileDomMap.set(tile.id, dom);
      canvasSurface.append(dom.container);
      positionTile(tile, dom);
    });
}

function renderOutput(sessionId, outputText) {
  const tile = state.tiles.find((entry) => entry.sessionId === sessionId);
  if (!tile) {
    return;
  }
  const dom = state.tileDomMap.get(tile.id);
  if (!dom) {
    return;
  }

  dom.output.textContent = stripAnsi(outputText);
  dom.output.scrollTop = dom.output.scrollHeight;
}

function showFatalError(prefix, error) {
  const overlay = document.createElement("pre");
  overlay.className = "fatal-error-overlay";
  overlay.textContent = `[${prefix}] ${String(error?.message || error)}`;
  canvasSurface.replaceChildren(overlay);
}

function renderTerminalError(tile, prefix, error) {
  const message = String(error?.message || error);
  renderOutput(tile.sessionId, `[${prefix}] ${message}`);
}

function terminalRequestFromKeyEvent(tile, event) {
  const ctrlKey = event.ctrlKey && !event.altKey && !event.metaKey;

  if (ctrlKey && /^[A-Za-z]$/u.test(event.key)) {
    return () => api.tmux.sendKeys(tile.sessionId, [`C-${event.key.toLowerCase()}`]);
  }

  const mapped = SPECIAL_KEY_MAP[event.key];
  if (mapped) {
    return () => api.tmux.sendKeys(tile.sessionId, [mapped]);
  }

  if (
    event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  ) {
    return () => api.tmux.typeText(tile.sessionId, event.key);
  }

  return null;
}

function wireTileEvents(tile, dom) {
  dom.closeButton.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });

  dom.closeButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await closeTile(tile.id);
  });

  dom.container.addEventListener("pointerdown", (event) => {
    const resizeHandle = event.target.closest("[data-resize-dir]");
    state.activeTileId = tile.id;
    bringTileToFront(tile.id);

    if (resizeHandle) {
      event.preventDefault();
      event.stopPropagation();
      beginResize(
        tile.id,
        resizeHandle.dataset.resizeDir,
        event.clientX,
        event.clientY,
      );
      return;
    }

    if (event.target.closest("[data-drag-handle]")) {
      event.preventDefault();
      event.stopPropagation();
      beginDrag(tile.id, event.clientX, event.clientY);
      return;
    }

    positionAllTiles();
  });

  dom.container.addEventListener("click", () => {
    dom.container.focus();
  });

  dom.container.addEventListener("keydown", (event) => {
    if (event.target === dom.closeButton) {
      return;
    }
    const request = terminalRequestFromKeyEvent(tile, event);
    if (!request) {
      return;
    }
    event.preventDefault();
    void request()
      .then(() => refreshTileOutput(tile))
      .catch((error) => renderTerminalError(tile, "input error", error));
  });

  dom.container.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) {
      return;
    }
    event.preventDefault();
    void api.tmux.typeText(tile.sessionId, text)
      .then(() => refreshTileOutput(tile))
      .catch((error) => renderTerminalError(tile, "paste error", error));
  });
}

function beginPan(clientX, clientY) {
  state.interaction = {
    type: "pan",
    tileId: null,
    dir: null,
    startClientX: clientX,
    startClientY: clientY,
    startPanX: state.viewport.panX,
    startPanY: state.viewport.panY,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
  };
  canvasShell.classList.add("is-grabbing");
}

function beginDrag(tileId, clientX, clientY) {
  const tile = findTile(tileId);
  if (!tile) {
    return;
  }

  state.interaction = {
    type: "drag",
    tileId,
    dir: null,
    startClientX: clientX,
    startClientY: clientY,
    startPanX: 0,
    startPanY: 0,
    startX: tile.x,
    startY: tile.y,
    startWidth: tile.width,
    startHeight: tile.height,
  };
  canvasShell.classList.add("is-dragging-tile");
}

function beginResize(tileId, dir, clientX, clientY) {
  const tile = findTile(tileId);
  if (!tile) {
    return;
  }

  state.interaction = {
    type: "resize",
    tileId,
    dir,
    startClientX: clientX,
    startClientY: clientY,
    startPanX: 0,
    startPanY: 0,
    startX: tile.x,
    startY: tile.y,
    startWidth: tile.width,
    startHeight: tile.height,
  };
  canvasShell.classList.add("is-resizing-tile");
}

function applyResize(tile, dir, deltaX, deltaY) {
  let nextX = state.interaction.startX;
  let nextY = state.interaction.startY;
  let nextWidth = state.interaction.startWidth;
  let nextHeight = state.interaction.startHeight;

  if (dir.includes("e")) {
    nextWidth = Math.max(MIN_TILE_WIDTH, state.interaction.startWidth + deltaX);
  }
  if (dir.includes("s")) {
    nextHeight = Math.max(MIN_TILE_HEIGHT, state.interaction.startHeight + deltaY);
  }
  if (dir.includes("w")) {
    const maxDelta = state.interaction.startWidth - MIN_TILE_WIDTH;
    const applied = clamp(deltaX, -Infinity, maxDelta);
    nextWidth = state.interaction.startWidth - applied;
    nextX = state.interaction.startX + applied;
  }
  if (dir.includes("n")) {
    const maxDelta = state.interaction.startHeight - MIN_TILE_HEIGHT;
    const applied = clamp(deltaY, -Infinity, maxDelta);
    nextHeight = state.interaction.startHeight - applied;
    nextY = state.interaction.startY + applied;
  }

  tile.x = nextX;
  tile.y = nextY;
  tile.width = nextWidth;
  tile.height = nextHeight;
}

async function endInteraction() {
  try {
    const { type, tileId } = state.interaction;
    if (type === "drag" || type === "resize") {
      const tile = findTile(tileId);
      if (tile) {
        tile.x = snap(tile.x);
        tile.y = snap(tile.y);
        tile.width = snap(tile.width);
        tile.height = snap(tile.height);

        const { cols, rows } = estimateTerminalSize(tile);
        await api.tmux.resizeSession(tile.sessionId, cols, rows);
        scheduleCanvasSave();
      }
    }
  } finally {
    canvasShell.classList.remove("is-grabbing", "is-dragging-tile", "is-resizing-tile");
    state.interaction = {
      type: null,
      tileId: null,
      dir: null,
      startClientX: 0,
      startClientY: 0,
      startPanX: 0,
      startPanY: 0,
      startX: 0,
      startY: 0,
      startWidth: 0,
      startHeight: 0,
    };

    positionAllTiles();
  }
}

async function closeTile(tileId) {
  const tile = findTile(tileId);
  if (!tile) {
    return;
  }

  await api.tmux.killSession(tile.sessionId);
  state.tiles = state.tiles.filter((entry) => entry.id !== tileId);
  state.outputs.delete(tile.sessionId);

  if (state.activeTileId === tileId) {
    state.activeTileId = state.tiles.at(-1)?.id || null;
  }

  rebuildTiles();
  scheduleCanvasSave();
}

async function reconcileTilesWithSessions() {
  const checks = await Promise.all(
    state.tiles.map(async (tile) => ({
      sessionId: tile.sessionId,
      tileId: tile.id,
      exists: await api.tmux.sessionExists(tile.sessionId),
    })),
  );
  const liveTileIds = new Set(
    checks.filter((entry) => entry.exists).map((entry) => entry.tileId),
  );
  const hadMissingTiles = liveTileIds.size !== state.tiles.length;
  if (!hadMissingTiles) {
    return;
  }

  await Promise.all(
    checks
      .filter((entry) => !entry.exists)
      .map((entry) => api.tmux.killSession(entry.sessionId)),
  );

  state.tiles = state.tiles.filter((tile) => liveTileIds.has(tile.id));
  state.activeTileId = liveTileIds.has(state.activeTileId)
    ? state.activeTileId
    : state.tiles[0]?.id || null;
  rebuildTiles();
  await api.canvas.saveState(serializeCanvasState());
}

function centerWorldPoint() {
  const rect = getCanvasRect();
  return {
    x: (rect.width / 2 - state.viewport.panX) / state.viewport.zoom,
    y: (rect.height / 2 - state.viewport.panY) / state.viewport.zoom,
  };
}

async function createTerminalTileAt(worldX, worldY) {
  const provisionalTile = {
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  };
  const { cols, rows } = estimateTerminalSize(provisionalTile);
  const session = await api.tmux.createSession({
    cwd: state.workspaceRoot,
    cols,
    rows,
  });

  const tile = {
    id: `tile-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`,
    sessionId: session.sessionId,
    cwd: session.cwd,
    x: snap(worldX - DEFAULT_TILE_WIDTH / 2),
    y: snap(worldY - DEFAULT_TILE_HEIGHT / 2),
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
    zIndex: getMaxZIndex() + 1,
  };

  state.tiles.push(tile);
  state.activeTileId = tile.id;
  bringTileToFront(tile.id);
  rebuildTiles();
  scheduleCanvasSave();
  void refreshTileOutput(tile);
}

async function createInitialTileIfNeeded() {
  if (state.tiles.length > 0) {
    return;
  }
  const center = centerWorldPoint();
  await createTerminalTileAt(center.x, center.y);
}

async function refreshTileOutput(tile) {
  try {
    const read = await api.tmux.readSession(tile.sessionId, {
      lines: DEFAULT_CAPTURE_LINES,
    });

    if (state.outputs.get(tile.sessionId) !== read.output) {
      state.outputs.set(tile.sessionId, read.output);
      renderOutput(tile.sessionId, read.output);
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (/session not found/u.test(message)) {
      renderOutput(tile.sessionId, "[session missing]");
      return;
    }
    renderOutput(tile.sessionId, `[read error] ${message}`);
  }
}

async function pollSessions() {
  await Promise.all(state.tiles.map((tile) => refreshTileOutput(tile)));
}

function startPolling() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    void pollSessions();
  }, POLL_INTERVAL_MS);
}

function hydrateState(saved) {
  state.viewport = {
    ...state.viewport,
    ...(saved.viewport || {}),
  };
  state.tiles = Array.isArray(saved.tiles)
    ? saved.tiles.map((tile) => ({
      ...tile,
      zIndex: tile.zIndex || 1,
    }))
    : [];
  state.activeTileId = saved.activeTileId || state.tiles[0]?.id || null;
}

canvasShell.addEventListener("wheel", (event) => {
  event.preventDefault();
  window.cancelAnimationFrame(zoomAnimationFrame);

  if (event.ctrlKey || event.metaKey) {
    const multiplier = event.deltaY < 0 ? 1.08 : 0.92;
    setZoomAroundPoint(state.viewport.zoom * multiplier, event.clientX, event.clientY, true);
    queueZoomSettle();
    return;
  }

  state.viewport.panX -= event.deltaX * 1.2;
  state.viewport.panY -= event.deltaY * 1.2;
  drawGrid();
  positionAllTiles();
  scheduleCanvasSave();
});

canvasShell.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return;
  }
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  event.preventDefault();
  beginPan(event.clientX, event.clientY);
});

canvasShell.addEventListener("dblclick", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return;
  }
  const world = worldFromClient(event.clientX, event.clientY);
  void createTerminalTileAt(world.x, world.y);
});

window.addEventListener("pointermove", (event) => {
  const { type, startClientX, startClientY } = state.interaction;
  if (!type) {
    return;
  }

  if (type === "pan") {
    state.viewport.panX = state.interaction.startPanX + (event.clientX - startClientX);
    state.viewport.panY = state.interaction.startPanY + (event.clientY - startClientY);
    drawGrid();
    positionAllTiles();
    return;
  }

  const tile = findTile(state.interaction.tileId);
  if (!tile) {
    return;
  }

  const deltaX = (event.clientX - startClientX) / state.viewport.zoom;
  const deltaY = (event.clientY - startClientY) / state.viewport.zoom;

  if (type === "drag") {
    tile.x = state.interaction.startX + deltaX;
    tile.y = state.interaction.startY + deltaY;
    positionAllTiles();
    return;
  }

  if (type === "resize") {
    applyResize(tile, state.interaction.dir, deltaX, deltaY);
    positionAllTiles();
  }
});

window.addEventListener("pointerup", () => {
  if (state.interaction.type) {
    void endInteraction();
  }
});

window.addEventListener("pointercancel", () => {
  if (state.interaction.type) {
    void endInteraction();
  }
});

window.addEventListener("resize", () => {
  drawGrid();
  positionAllTiles();
});

async function init() {
  state.workspaceRoot = await api.app.getWorkspaceRoot();
  const saved = await api.canvas.loadState();
  hydrateState(saved);
  await reconcileTilesWithSessions();
  rebuildTiles();
  drawGrid();
  positionAllTiles();
  await createInitialTileIfNeeded();
  await pollSessions();
  startPolling();
}

void init().catch((error) => {
  console.error("[SwarmTumx] startup failed", error);
  showFatalError("startup error", error);
});

const MIN_ZOOM = 0.33
const MAX_ZOOM = 1
const GRID_SIZE = 20
const GRID_GROUP = 4
const DEFAULT_TILE_WIDTH = 520
const DEFAULT_TILE_HEIGHT = 320
const MIN_TILE_WIDTH = 320
const MIN_TILE_HEIGHT = 180
const DEFAULT_TERMINAL_COLS = 100
const DEFAULT_TERMINAL_ROWS = 28
const SAVE_DEBOUNCE_MS = 200
const TERMINAL_FONT_FAMILY = "\"Geist Mono\", \"IBM Plex Mono\", \"SFMono-Regular\", Menlo, monospace"
const TERMINAL_THEME = {
  background: "#0a0a0a",
  black: "#1a1a1a",
  blue: "#7aa2f7",
  brightBlack: "#5f5f5f",
  brightBlue: "#8db4ff",
  brightCyan: "#7fe4d6",
  brightGreen: "#8ede94",
  brightMagenta: "#c8a5ff",
  brightRed: "#ff7a7a",
  brightWhite: "#f5f5f5",
  brightYellow: "#f7d46b",
  cursor: "#f2f2f2",
  cursorAccent: "#0a0a0a",
  cyan: "#5bc0be",
  foreground: "#d8d8d8",
  green: "#78c57e",
  magenta: "#b294ff",
  red: "#f27878",
  selectionBackground: "rgba(255, 255, 255, 0.18)",
  white: "#d8d8d8",
  yellow: "#d4bc63",
}

const api = window.swarmTumx
const XTermTerminal = window.Terminal
const FitAddonClass = window.FitAddon?.FitAddon

const canvasShell = document.querySelector("#canvas-shell")
const canvasSurface = document.querySelector("#canvas-surface")
const gridLayer = document.querySelector("#grid-layer")
const zoomIndicator = document.querySelector("#zoom-indicator")

const state = {
  workspaceRoot: "",
  viewport: {
    panX: 320,
    panY: 160,
    zoom: 0.8,
  },
  activeTileId: null,
  tiles: [],
  tileDomMap: new Map(),
  terminalBindings: new Map(),
  interaction: createEmptyInteraction(),
}

let saveTimer = null
let zoomIndicatorTimer = null
let zoomSettleTimer = null
let zoomAnimationFrame = null
let unsubscribeTerminalData = null
let unsubscribeTerminalExit = null

function createEmptyInteraction() {
  return {
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
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function rubberBand(value, min, max, factor = 0.2) {
  if (value < min) {
    return min - (min - value) * factor
  }
  if (value > max) {
    return max + (value - max) * factor
  }
  return value
}

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

function numberOrFallback(value, fallback) {
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : fallback
}

function nextTileId() {
  if (typeof window.crypto?.randomUUID === "function") {
    return `tile-${window.crypto.randomUUID()}`
  }
  return `tile-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
}

function getCanvasRect() {
  return canvasShell.getBoundingClientRect()
}

function worldFromClient(clientX, clientY) {
  const rect = getCanvasRect()
  return {
    x: (clientX - rect.left - state.viewport.panX) / state.viewport.zoom,
    y: (clientY - rect.top - state.viewport.panY) / state.viewport.zoom,
  }
}

function centerWorldPoint() {
  const rect = getCanvasRect()
  return {
    x: (rect.width / 2 - state.viewport.panX) / state.viewport.zoom,
    y: (rect.height / 2 - state.viewport.panY) / state.viewport.zoom,
  }
}

function splitDisplayPath(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean)
  if (parts.length === 0) {
    return { parent: "", name: "/" }
  }

  const name = parts.at(-1)
  const parent = filePath.slice(0, Math.max(0, filePath.length - name.length))
  return { parent, name }
}

function findTile(tileId) {
  return state.tiles.find((tile) => tile.id === tileId)
}

function getMaxZIndex() {
  return state.tiles.reduce((max, tile) => Math.max(max, tile.zIndex), 0)
}

function bringTileToFront(tileId) {
  const tile = findTile(tileId)
  if (!tile) {
    return
  }

  tile.zIndex = getMaxZIndex() + 1
}

function highestPriorityTileId() {
  return state.tiles
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .at(-1)?.id || null
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
  }
}

function scheduleCanvasSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void api.canvas.saveState(serializeCanvasState())
  }, SAVE_DEBOUNCE_MS)
}

function showZoomIndicator() {
  zoomIndicator.textContent = `${Math.round(clamp(state.viewport.zoom, MIN_ZOOM, MAX_ZOOM) * 100)}%`
  zoomIndicator.classList.add("is-visible")
  window.clearTimeout(zoomIndicatorTimer)
  zoomIndicatorTimer = window.setTimeout(() => {
    zoomIndicator.classList.remove("is-visible")
  }, 1200)
}

function setZoomAroundPoint(targetZoom, clientX, clientY, allowOvershoot = true) {
  const rect = getCanvasRect()
  const nextZoom = allowOvershoot
    ? rubberBand(targetZoom, MIN_ZOOM, MAX_ZOOM)
    : clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)

  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const worldX = (localX - state.viewport.panX) / state.viewport.zoom
  const worldY = (localY - state.viewport.panY) / state.viewport.zoom

  state.viewport.zoom = nextZoom
  state.viewport.panX = localX - worldX * nextZoom
  state.viewport.panY = localY - worldY * nextZoom

  showZoomIndicator()
  drawGrid()
  positionAllTiles()
  scheduleCanvasSave()
}

function animateZoomTo(targetZoom) {
  window.cancelAnimationFrame(zoomAnimationFrame)

  const rect = getCanvasRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const startZoom = state.viewport.zoom
  const nextZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)

  if (Math.abs(startZoom - nextZoom) < 0.001) {
    state.viewport.zoom = nextZoom
    drawGrid()
    positionAllTiles()
    return
  }

  const startTime = performance.now()
  const duration = 180

  function step(now) {
    const t = clamp((now - startTime) / duration, 0, 1)
    const eased = 1 - Math.pow(1 - t, 3)
    const zoom = startZoom + (nextZoom - startZoom) * eased

    setZoomAroundPoint(zoom, centerX, centerY, false)

    if (t < 1) {
      zoomAnimationFrame = window.requestAnimationFrame(step)
    }
  }

  zoomAnimationFrame = window.requestAnimationFrame(step)
}

function queueZoomSettle() {
  window.clearTimeout(zoomSettleTimer)
  zoomSettleTimer = window.setTimeout(() => {
    animateZoomTo(clamp(state.viewport.zoom, MIN_ZOOM, MAX_ZOOM))
  }, 150)
}

function drawGrid() {
  const rect = getCanvasRect()
  const dpr = window.devicePixelRatio || 1
  const context = gridLayer.getContext("2d")

  gridLayer.width = Math.floor(rect.width * dpr)
  gridLayer.height = Math.floor(rect.height * dpr)
  gridLayer.style.width = `${rect.width}px`
  gridLayer.style.height = `${rect.height}px`

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, rect.width, rect.height)

  const step = GRID_SIZE * state.viewport.zoom
  const majorStep = step * GRID_GROUP
  const offsetXMinor = ((state.viewport.panX % step) + step) % step
  const offsetYMinor = ((state.viewport.panY % step) + step) % step
  const offsetXMajor = ((state.viewport.panX % majorStep) + majorStep) % majorStep
  const offsetYMajor = ((state.viewport.panY % majorStep) + majorStep) % majorStep

  if (step >= 12) {
    const dotSize = Math.max(1, 1.5 * state.viewport.zoom)
    context.fillStyle = "rgba(255, 255, 255, 0.11)"
    for (let x = offsetXMinor; x <= rect.width; x += step) {
      for (let y = offsetYMinor; y <= rect.height; y += step) {
        context.fillRect(Math.round(x), Math.round(y), dotSize, dotSize)
      }
    }
  }

  const majorDotSize = Math.max(1, 1.7 * state.viewport.zoom)
  context.fillStyle = "rgba(255, 255, 255, 0.18)"
  for (let x = offsetXMajor; x <= rect.width; x += majorStep) {
    for (let y = offsetYMajor; y <= rect.height; y += majorStep) {
      context.fillRect(Math.round(x), Math.round(y), majorDotSize, majorDotSize)
    }
  }
}

function createResizeHandle(className, dir) {
  const handle = document.createElement("div")
  handle.className = `tile-resize-handle ${className}`
  handle.dataset.resizeDir = dir
  return handle
}

function updateTileDom(tile, dom) {
  const label = splitDisplayPath(tile.cwd || state.workspaceRoot)
  dom.parentSpan.textContent = label.parent
  dom.nameSpan.textContent = label.name
  dom.titleText.title = tile.cwd || ""
  dom.container.classList.toggle("is-active", tile.id === state.activeTileId)
}

function positionTile(tile, dom) {
  const screenX = tile.x * state.viewport.zoom + state.viewport.panX
  const screenY = tile.y * state.viewport.zoom + state.viewport.panY

  dom.container.style.left = `${screenX}px`
  dom.container.style.top = `${screenY}px`
  dom.container.style.width = `${tile.width}px`
  dom.container.style.height = `${tile.height}px`
  dom.container.style.transform = "none"
  dom.container.style.zIndex = String(tile.zIndex)
}

function positionAllTiles() {
  state.tiles.forEach((tile) => {
    const dom = state.tileDomMap.get(tile.id)
    if (!dom) {
      return
    }

    updateTileDom(tile, dom)
    positionTile(tile, dom)
  })
}

function activateTile(tileId, options = {}) {
  const tile = findTile(tileId)
  if (!tile) {
    return
  }

  const changedTile = tileId !== state.activeTileId
  const previousZIndex = tile.zIndex
  state.activeTileId = tileId
  bringTileToFront(tileId)
  positionAllTiles()

  if (options.focus) {
    focusTerminal(tile.sessionId)
  }

  if (options.save && (changedTile || tile.zIndex !== previousZIndex)) {
    scheduleCanvasSave()
  }
}

function getTerminalBinding(sessionId) {
  return state.terminalBindings.get(sessionId) || null
}

function fitTerminal(sessionId) {
  const binding = getTerminalBinding(sessionId)
  if (!binding || binding.disposed || !binding.terminal.element?.isConnected) {
    return null
  }

  try {
    binding.fitAddon.fit()
  } catch {
    return null
  }

  return {
    cols: binding.terminal.cols || DEFAULT_TERMINAL_COLS,
    rows: binding.terminal.rows || DEFAULT_TERMINAL_ROWS,
  }
}

function scheduleTerminalFit(sessionId) {
  const binding = getTerminalBinding(sessionId)
  if (!binding || binding.disposed || binding.fitFrame) {
    return
  }

  binding.fitFrame = window.requestAnimationFrame(() => {
    binding.fitFrame = 0
    fitTerminal(sessionId)
  })
}

function focusTerminal(sessionId) {
  const binding = getTerminalBinding(sessionId)
  if (!binding || binding.disposed) {
    return
  }

  binding.terminal.focus()
}

function writeTerminalNotice(sessionId, prefix, error) {
  const binding = getTerminalBinding(sessionId)
  if (!binding || binding.disposed) {
    return
  }

  const message = String(error?.message || error)
  binding.terminal.write(`\r\n[${prefix}] ${message}\r\n`)
}

async function flushPendingInput(sessionId, binding) {
  if (!binding || binding.disposed || binding.pendingInput.length === 0) {
    return
  }

  const data = binding.pendingInput.join("")
  binding.pendingInput.length = 0
  try {
    await api.terminal.write(sessionId, data)
  } catch (error) {
    binding.pendingInput.unshift(data)
    throw error
  }
}

async function disposeTerminal(sessionId) {
  const binding = getTerminalBinding(sessionId)
  if (!binding) {
    return
  }

  binding.disposed = true
  state.terminalBindings.delete(sessionId)

  if (binding.fitFrame) {
    window.cancelAnimationFrame(binding.fitFrame)
    binding.fitFrame = 0
  }

  binding.resizeObserver?.disconnect()
  binding.resizeDisposable?.dispose()
  binding.dataDisposable?.dispose()
  binding.binaryDisposable?.dispose()

  try {
    await api.terminal.detachSession(sessionId)
  } catch {
    // no-op
  }

  binding.terminal.dispose()
}

async function disposeAllTerminals() {
  const sessionIds = [...state.terminalBindings.keys()]
  await Promise.all(sessionIds.map((sessionId) => disposeTerminal(sessionId)))
}

function handleTerminalData(payload) {
  const binding = getTerminalBinding(payload.sessionId)
  if (!binding || binding.disposed) {
    return
  }

  binding.terminal.write(payload.data)
}

function handleTerminalExit(payload) {
  const binding = getTerminalBinding(payload.sessionId)
  if (!binding || binding.disposed) {
    return
  }

  binding.attached = false
  const suffix = payload.signal
    ? ` signal ${payload.signal}`
    : typeof payload.exitCode === "number"
      ? ` code ${payload.exitCode}`
      : ""
  binding.terminal.write(`\r\n[terminal exited${suffix}]\r\n`)
}

async function attachTerminal(tile, dom) {
  const terminal = new XTermTerminal({
    allowTransparency: false,
    cols: DEFAULT_TERMINAL_COLS,
    cursorBlink: true,
    cursorStyle: "block",
    drawBoldTextInBrightColors: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 1.3,
    macOptionIsMeta: true,
    minimumContrastRatio: 1,
    rows: DEFAULT_TERMINAL_ROWS,
    scrollback: 5000,
    theme: TERMINAL_THEME,
  })

  const fitAddon = new FitAddonClass()
  terminal.loadAddon(fitAddon)
  terminal.open(dom.terminalMount)
  terminal.textarea?.setAttribute("spellcheck", "false")
  terminal.textarea?.setAttribute("aria-label", `${tile.cwd || "terminal"}`)

  const binding = {
    attached: false,
    binaryDisposable: null,
    dataDisposable: null,
    disposed: false,
    fitAddon,
    fitFrame: 0,
    pendingInput: [],
    resizeDisposable: null,
    resizeObserver: null,
    terminal,
    tileId: tile.id,
  }

  binding.dataDisposable = terminal.onData((data) => {
    if (binding.disposed) {
      return
    }

    if (!binding.attached) {
      binding.pendingInput.push(data)
      return
    }

    void api.terminal.write(tile.sessionId, data).catch((error) => {
      writeTerminalNotice(tile.sessionId, "write error", error)
    })
  })

  binding.binaryDisposable = terminal.onBinary((data) => {
    if (binding.disposed) {
      return
    }

    if (!binding.attached) {
      binding.pendingInput.push(data)
      return
    }

    void api.terminal.write(tile.sessionId, data).catch((error) => {
      writeTerminalNotice(tile.sessionId, "binary write error", error)
    })
  })

  binding.resizeDisposable = terminal.onResize(({ cols, rows }) => {
    if (!binding.attached || binding.disposed) {
      return
    }

    void api.terminal.resizeSession(tile.sessionId, cols, rows).catch((error) => {
      writeTerminalNotice(tile.sessionId, "resize error", error)
    })
  })

  if (typeof window.ResizeObserver === "function") {
    binding.resizeObserver = new window.ResizeObserver(() => {
      scheduleTerminalFit(tile.sessionId)
    })
    binding.resizeObserver.observe(dom.terminalMount)
  }

  state.terminalBindings.set(tile.sessionId, binding)
  fitTerminal(tile.sessionId)
  scheduleTerminalFit(tile.sessionId)

  try {
    const size = fitTerminal(tile.sessionId) || {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    }

    await api.terminal.attachSession(tile.sessionId, {
      cols: size.cols,
      cwd: tile.cwd,
      rows: size.rows,
    })

    if (binding.disposed) {
      return
    }

    binding.attached = true
    await flushPendingInput(tile.sessionId, binding)
    window.setTimeout(() => {
      scheduleTerminalFit(tile.sessionId)
    }, 0)

    if (state.activeTileId === tile.id) {
      focusTerminal(tile.sessionId)
    }
  } catch (error) {
    writeTerminalNotice(tile.sessionId, "attach error", error)
  }
}

function createTileDom(tile) {
  const container = document.createElement("div")
  container.className = "terminal-tile"
  container.dataset.tileId = tile.id

  const titleBar = document.createElement("div")
  titleBar.className = "tile-title-bar"
  titleBar.dataset.dragHandle = "true"

  const titleText = document.createElement("span")
  titleText.className = "tile-title-text"
  const parentSpan = document.createElement("span")
  parentSpan.className = "tile-title-parent"
  const nameSpan = document.createElement("span")
  nameSpan.className = "tile-title-name"
  titleText.append(parentSpan, nameSpan)

  const btnGroup = document.createElement("div")
  btnGroup.className = "tile-btn-group"
  const closeButton = document.createElement("button")
  closeButton.className = "tile-action-btn tile-close-btn"
  closeButton.type = "button"
  closeButton.textContent = "×"
  closeButton.title = "Close terminal"
  btnGroup.append(closeButton)

  titleBar.append(titleText, btnGroup)

  const content = document.createElement("div")
  content.className = "tile-content"

  const terminalMount = document.createElement("div")
  terminalMount.className = "tile-terminal"
  content.append(terminalMount)

  container.append(
    titleBar,
    content,
    createResizeHandle("edge-n", "n"),
    createResizeHandle("edge-s", "s"),
    createResizeHandle("edge-e", "e"),
    createResizeHandle("edge-w", "w"),
    createResizeHandle("corner-nw", "nw"),
    createResizeHandle("corner-ne", "ne"),
    createResizeHandle("corner-sw", "sw"),
    createResizeHandle("corner-se", "se"),
  )

  const dom = {
    closeButton,
    container,
    content,
    nameSpan,
    parentSpan,
    terminalMount,
    titleBar,
    titleText,
  }

  wireTileEvents(tile, dom)
  updateTileDom(tile, dom)
  return dom
}

function appendTile(tile) {
  const dom = createTileDom(tile)
  state.tileDomMap.set(tile.id, dom)
  canvasSurface.append(dom.container)
  positionTile(tile, dom)
  void attachTerminal(tile, dom)
}

async function renderAllTiles() {
  await disposeAllTerminals()
  canvasSurface.innerHTML = ""
  state.tileDomMap.clear()

  state.tiles
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .forEach((tile) => appendTile(tile))

  positionAllTiles()
}

function removeTileDom(tileId) {
  const dom = state.tileDomMap.get(tileId)
  if (!dom) {
    return
  }

  dom.container.remove()
  state.tileDomMap.delete(tileId)
}

function showFatalError(prefix, error) {
  const overlay = document.createElement("pre")
  overlay.className = "fatal-error-overlay"
  overlay.textContent = `[${prefix}] ${String(error?.message || error)}`
  canvasSurface.replaceChildren(overlay)
}

function wireTileEvents(tile, dom) {
  dom.closeButton.addEventListener("pointerdown", (event) => {
    event.stopPropagation()
  })

  dom.closeButton.addEventListener("click", async (event) => {
    event.stopPropagation()
    await closeTile(tile.id)
  })

  dom.container.addEventListener("pointerdown", (event) => {
    const resizeHandle = event.target.closest("[data-resize-dir]")
    const terminalRegion = event.target.closest(".tile-terminal")

    if (resizeHandle) {
      activateTile(tile.id, { save: true })
      event.preventDefault()
      event.stopPropagation()
      beginResize(
        tile.id,
        resizeHandle.dataset.resizeDir,
        event.clientX,
        event.clientY,
      )
      return
    }

    if (event.target.closest("[data-drag-handle]")) {
      activateTile(tile.id, { save: true })
      event.preventDefault()
      event.stopPropagation()
      beginDrag(tile.id, event.clientX, event.clientY)
      return
    }

    if (terminalRegion) {
      activateTile(tile.id, { save: true })
      return
    }

    activateTile(tile.id, { focus: true, save: true })
  })
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
  }

  canvasShell.classList.add("is-grabbing")
}

function beginDrag(tileId, clientX, clientY) {
  const tile = findTile(tileId)
  if (!tile) {
    return
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
  }

  canvasShell.classList.add("is-dragging-tile")
}

function beginResize(tileId, dir, clientX, clientY) {
  const tile = findTile(tileId)
  if (!tile) {
    return
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
  }

  canvasShell.classList.add("is-resizing-tile")
}

function applyResize(tile, dir, deltaX, deltaY) {
  let nextX = state.interaction.startX
  let nextY = state.interaction.startY
  let nextWidth = state.interaction.startWidth
  let nextHeight = state.interaction.startHeight

  if (dir.includes("e")) {
    nextWidth = Math.max(MIN_TILE_WIDTH, state.interaction.startWidth + deltaX)
  }
  if (dir.includes("s")) {
    nextHeight = Math.max(MIN_TILE_HEIGHT, state.interaction.startHeight + deltaY)
  }
  if (dir.includes("w")) {
    const maxDelta = state.interaction.startWidth - MIN_TILE_WIDTH
    const applied = clamp(deltaX, -Infinity, maxDelta)
    nextWidth = state.interaction.startWidth - applied
    nextX = state.interaction.startX + applied
  }
  if (dir.includes("n")) {
    const maxDelta = state.interaction.startHeight - MIN_TILE_HEIGHT
    const applied = clamp(deltaY, -Infinity, maxDelta)
    nextHeight = state.interaction.startHeight - applied
    nextY = state.interaction.startY + applied
  }

  tile.x = nextX
  tile.y = nextY
  tile.width = nextWidth
  tile.height = nextHeight
}

async function endInteraction() {
  try {
    const { type, tileId } = state.interaction
    if (type !== "drag" && type !== "resize") {
      return
    }

    const tile = findTile(tileId)
    if (!tile) {
      return
    }

    tile.x = snap(tile.x)
    tile.y = snap(tile.y)
    tile.width = snap(tile.width)
    tile.height = snap(tile.height)
    positionAllTiles()
    scheduleTerminalFit(tile.sessionId)
    scheduleCanvasSave()
  } finally {
    canvasShell.classList.remove("is-grabbing", "is-dragging-tile", "is-resizing-tile")
    state.interaction = createEmptyInteraction()
  }
}

async function closeTile(tileId) {
  const tile = findTile(tileId)
  if (!tile) {
    return
  }

  await disposeTerminal(tile.sessionId)
  await api.tmux.killSession(tile.sessionId)

  state.tiles = state.tiles.filter((entry) => entry.id !== tileId)
  removeTileDom(tileId)

  if (state.activeTileId === tileId) {
    state.activeTileId = highestPriorityTileId()
  }

  positionAllTiles()
  if (state.activeTileId) {
    const nextTile = findTile(state.activeTileId)
    if (nextTile) {
      window.setTimeout(() => {
        focusTerminal(nextTile.sessionId)
      }, 0)
    }
  }
  scheduleCanvasSave()
}

async function reconcileTilesWithSessions() {
  const checks = await Promise.all(
    state.tiles.map(async (tile) => ({
      exists: await api.tmux.sessionExists(tile.sessionId),
      sessionId: tile.sessionId,
      tileId: tile.id,
    })),
  )

  const liveTileIds = new Set(
    checks.filter((entry) => entry.exists).map((entry) => entry.tileId),
  )

  if (liveTileIds.size === state.tiles.length) {
    return
  }

  await Promise.all(
    checks
      .filter((entry) => !entry.exists)
      .map((entry) => api.tmux.killSession(entry.sessionId)),
  )

  state.tiles = state.tiles.filter((tile) => liveTileIds.has(tile.id))
  state.activeTileId = liveTileIds.has(state.activeTileId)
    ? state.activeTileId
    : highestPriorityTileId()

  await api.canvas.saveState(serializeCanvasState())
}

async function createTerminalTileAt(worldX, worldY) {
  const session = await api.tmux.createSession({
    cwd: state.workspaceRoot,
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  })

  const tile = {
    id: nextTileId(),
    sessionId: session.sessionId,
    cwd: session.cwd,
    x: snap(worldX - DEFAULT_TILE_WIDTH / 2),
    y: snap(worldY - DEFAULT_TILE_HEIGHT / 2),
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
    zIndex: getMaxZIndex() + 1,
  }

  state.tiles.push(tile)
  state.activeTileId = tile.id
  appendTile(tile)
  activateTile(tile.id, { focus: true })
  scheduleCanvasSave()
}

async function createInitialTileIfNeeded() {
  if (state.tiles.length > 0) {
    return
  }

  const center = centerWorldPoint()
  await createTerminalTileAt(center.x, center.y)
}

function hydrateState(saved) {
  state.viewport = {
    ...state.viewport,
    ...(saved.viewport || {}),
  }

  state.tiles = Array.isArray(saved.tiles)
    ? saved.tiles
      .filter((tile) => tile?.sessionId)
      .map((tile) => ({
        id: String(tile.id || nextTileId()),
        sessionId: String(tile.sessionId),
        cwd: tile.cwd || "",
        x: numberOrFallback(tile.x, 0),
        y: numberOrFallback(tile.y, 0),
        width: Math.max(MIN_TILE_WIDTH, numberOrFallback(tile.width, DEFAULT_TILE_WIDTH)),
        height: Math.max(MIN_TILE_HEIGHT, numberOrFallback(tile.height, DEFAULT_TILE_HEIGHT)),
        zIndex: Math.max(1, numberOrFallback(tile.zIndex, 1)),
      }))
    : []

  state.activeTileId = saved.activeTileId || highestPriorityTileId()
}

canvasShell.addEventListener("wheel", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return
  }

  event.preventDefault()
  window.cancelAnimationFrame(zoomAnimationFrame)

  if (event.ctrlKey || event.metaKey) {
    const multiplier = event.deltaY < 0 ? 1.08 : 0.92
    setZoomAroundPoint(state.viewport.zoom * multiplier, event.clientX, event.clientY, true)
    queueZoomSettle()
    return
  }

  state.viewport.panX -= event.deltaX * 1.2
  state.viewport.panY -= event.deltaY * 1.2
  drawGrid()
  positionAllTiles()
  scheduleCanvasSave()
})

canvasShell.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return
  }
  if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
    return
  }
  if (event.button !== 0 && event.button !== 1) {
    return
  }

  event.preventDefault()
  beginPan(event.clientX, event.clientY)
})

canvasShell.addEventListener("dblclick", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return
  }

  const world = worldFromClient(event.clientX, event.clientY)
  void createTerminalTileAt(world.x, world.y)
})

canvasShell.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".terminal-tile")) {
    return
  }

  event.preventDefault()
  const world = worldFromClient(event.clientX, event.clientY)
  void createTerminalTileAt(world.x, world.y)
})

window.addEventListener("pointermove", (event) => {
  const { type, startClientX, startClientY } = state.interaction
  if (!type) {
    return
  }

  if (type === "pan") {
    state.viewport.panX = state.interaction.startPanX + (event.clientX - startClientX)
    state.viewport.panY = state.interaction.startPanY + (event.clientY - startClientY)
    drawGrid()
    positionAllTiles()
    return
  }

  const tile = findTile(state.interaction.tileId)
  if (!tile) {
    return
  }

  const rawDeltaX = event.clientX - startClientX
  const rawDeltaY = event.clientY - startClientY

  if (type === "drag") {
    tile.x = state.interaction.startX + rawDeltaX / state.viewport.zoom
    tile.y = state.interaction.startY + rawDeltaY / state.viewport.zoom
    positionAllTiles()
    return
  }

  if (type === "resize") {
    applyResize(tile, state.interaction.dir, rawDeltaX, rawDeltaY)
    positionAllTiles()
    scheduleTerminalFit(tile.sessionId)
  }
})

window.addEventListener("pointerup", () => {
  if (state.interaction.type) {
    void endInteraction()
  }
})

window.addEventListener("pointercancel", () => {
  if (state.interaction.type) {
    void endInteraction()
  }
})

window.addEventListener("resize", () => {
  drawGrid()
  positionAllTiles()
})

window.addEventListener("beforeunload", () => {
  unsubscribeTerminalData?.()
  unsubscribeTerminalExit?.()
  void disposeAllTerminals()
})

async function init() {
  if (!api) {
    throw new Error("SwarmTumx preload API is unavailable")
  }
  if (!XTermTerminal || !FitAddonClass) {
    throw new Error("xterm.js assets failed to load")
  }

  unsubscribeTerminalData = api.terminal.onData(handleTerminalData)
  unsubscribeTerminalExit = api.terminal.onExit(handleTerminalExit)

  state.workspaceRoot = await api.app.getWorkspaceRoot()
  const saved = await api.canvas.loadState()
  hydrateState(saved)
  await reconcileTilesWithSessions()
  await renderAllTiles()
  drawGrid()
  positionAllTiles()
  await createInitialTileIfNeeded()

  if (state.activeTileId) {
    const tile = findTile(state.activeTileId)
    if (tile) {
      window.setTimeout(() => {
        focusTerminal(tile.sessionId)
      }, 0)
    }
  }
}

void init().catch((error) => {
  console.error("[SwarmTumx] startup failed", error)
  showFatalError("startup error", error)
})

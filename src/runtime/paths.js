const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getElectronApp() {
  try {
    return require("electron").app;
  } catch {
    return null;
  }
}

function resolvePackagedResource(...segments) {
  const app = getElectronApp();
  if (!app?.isPackaged) {
    return null;
  }

  const candidate = path.join(process.resourcesPath, ...segments);
  return fs.existsSync(candidate) ? candidate : null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function legacyDataDir() {
  return path.join(os.homedir(), ".swarmtumx");
}

function defaultMacDataDir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "swarmtumx",
    "runtime",
  );
}

function migrateLegacyDataDir(targetDir) {
  const legacyDir = legacyDataDir();
  if (
    targetDir === legacyDir
    || !fs.existsSync(legacyDir)
    || fs.existsSync(targetDir)
  ) {
    return;
  }

  ensureDir(targetDir);
  fs.cpSync(legacyDir, targetDir, {
    errorOnExist: false,
    force: false,
    recursive: true,
  });
}

function getDataDir() {
  if (process.env.SWARMTUMX_DATA_DIR) {
    return ensureDir(process.env.SWARMTUMX_DATA_DIR);
  }

  const app = getElectronApp();
  if (app) {
    return ensureDir(path.join(app.getPath("userData"), "runtime"));
  }

  if (process.platform === "darwin") {
    const dataDir = defaultMacDataDir();
    migrateLegacyDataDir(dataDir);
    return ensureDir(dataDir);
  }

  return ensureDir(legacyDataDir());
}

function getWorkspaceRoot() {
  if (process.env.SWARMTUMX_WORKSPACE_ROOT) {
    return path.resolve(process.env.SWARMTUMX_WORKSPACE_ROOT);
  }

  const app = getElectronApp();
  if (app && !app.isPackaged) {
    return app.getAppPath();
  }

  return process.cwd();
}

module.exports = {
  ensureDir,
  getDataDir,
  getWorkspaceRoot,
  resolvePackagedResource,
};

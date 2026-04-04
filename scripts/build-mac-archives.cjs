const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const packageJson = require(path.join(PROJECT_ROOT, "package.json"));
const PRODUCT_NAME = packageJson.build?.productName || "SwarmTumx";
const VERSION = packageJson.version;
const ARCH = process.arch;
const APP_PATH = path.join(DIST_DIR, `mac-${ARCH}`, `${PRODUCT_NAME}.app`);
const ZIP_PATH = path.join(DIST_DIR, `${PRODUCT_NAME}-${VERSION}-${ARCH}.zip`);
const DMG_PATH = path.join(DIST_DIR, `${PRODUCT_NAME}-${VERSION}-${ARCH}.dmg`);

function run(bin, args, options = {}) {
  execFileSync(bin, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    ...options,
  });
}

function ensureAppExists() {
  if (!fs.existsSync(APP_PATH)) {
    throw new Error(`Packaged app not found at ${APP_PATH}. Run npm run pack:mac first.`);
  }
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { force: true, recursive: true });
}

function removeBuilderExtras() {
  removeIfExists(path.join(DIST_DIR, "builder-debug.yml"));
  removeIfExists(`${ZIP_PATH}.blockmap`);
  removeIfExists(`${DMG_PATH}.blockmap`);
}

function buildZip() {
  removeIfExists(ZIP_PATH);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", APP_PATH, ZIP_PATH]);
  run("unzip", ["-tqq", ZIP_PATH]);
}

function buildDmg() {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-dmg-"));

  try {
    const stagedAppPath = path.join(stageDir, `${PRODUCT_NAME}.app`);
    run("ditto", [APP_PATH, stagedAppPath]);
    fs.symlinkSync("/Applications", path.join(stageDir, "Applications"));

    removeIfExists(DMG_PATH);
    run("hdiutil", [
      "create",
      "-volname",
      PRODUCT_NAME,
      "-srcfolder",
      stageDir,
      "-ov",
      "-format",
      "UDZO",
      DMG_PATH,
    ]);
  } finally {
    fs.rmSync(stageDir, { force: true, recursive: true });
  }
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("mac archives can only be built on darwin.");
  }

  ensureAppExists();
  buildZip();
  buildDmg();
  removeBuilderExtras();
}

main();

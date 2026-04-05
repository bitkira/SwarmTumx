const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_ICON_PATH = path.join(PROJECT_ROOT, "swarm.png");
const BUILD_DIR = path.join(PROJECT_ROOT, "build");
const OUTPUT_ICON_PATH = path.join(BUILD_DIR, "icon.icns");

const ICON_VARIANTS = [
  { filename: "icon_16x16.png", size: 16 },
  { filename: "icon_16x16@2x.png", size: 32 },
  { filename: "icon_32x32.png", size: 32 },
  { filename: "icon_32x32@2x.png", size: 64 },
  { filename: "icon_128x128.png", size: 128 },
  { filename: "icon_128x128@2x.png", size: 256 },
  { filename: "icon_256x256.png", size: 256 },
  { filename: "icon_256x256@2x.png", size: 512 },
  { filename: "icon_512x512.png", size: 512 },
  { filename: "icon_512x512@2x.png", size: 1024 },
];

function run(bin, args) {
  execFileSync(bin, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

function ensureSourceIcon() {
  if (!fs.existsSync(SOURCE_ICON_PATH)) {
    throw new Error(`Source icon not found at ${SOURCE_ICON_PATH}.`);
  }
}

function resizeVariant(iconsetDir, variant) {
  run("sips", [
    "-z",
    String(variant.size),
    String(variant.size),
    SOURCE_ICON_PATH,
    "--out",
    path.join(iconsetDir, variant.filename),
  ]);
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("App icon generation is only supported on darwin.");
  }

  ensureSourceIcon();
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmtumx-icon-"));
  const iconsetDir = path.join(tempDir, "icon.iconset");
  fs.mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const variant of ICON_VARIANTS) {
      resizeVariant(iconsetDir, variant);
    }

    run("iconutil", [
      "-c",
      "icns",
      iconsetDir,
      "-o",
      OUTPUT_ICON_PATH,
    ]);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

main();

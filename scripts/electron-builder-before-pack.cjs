const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BUNDLE_RUNTIME_DIR = path.join(PROJECT_ROOT, ".bundle-runtime");
const BUNDLE_LIB_DIR = path.join(BUNDLE_RUNTIME_DIR, "lib");
const BUNDLE_TERMINFO_DIR = path.join(BUNDLE_RUNTIME_DIR, "terminfo");
const BUNDLED_TERM_NAMES = [
  "tmux-256color",
  "xterm-256color",
  "screen-256color",
  "screen",
];

function run(bin, args, options = {}) {
  return execFileSync(bin, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function resolveTmuxPath() {
  if (process.env.SWARMTUMX_TMUX_BIN && fs.existsSync(process.env.SWARMTUMX_TMUX_BIN)) {
    return fs.realpathSync(process.env.SWARMTUMX_TMUX_BIN);
  }

  return fs.realpathSync(run("which", ["tmux"]));
}

function ensureCleanRuntimeDir() {
  fs.rmSync(BUNDLE_RUNTIME_DIR, { force: true, recursive: true });
  fs.mkdirSync(BUNDLE_LIB_DIR, { recursive: true });
  fs.mkdirSync(BUNDLE_TERMINFO_DIR, { recursive: true });
}

function parseLinkedLibraries(binaryPath) {
  const output = run("otool", ["-L", binaryPath]);
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(" (compatibility version")[0].trim())
    .filter((linkedPath) =>
      linkedPath
      && !linkedPath.startsWith("/usr/lib/")
      && !linkedPath.startsWith("/System/Library/"));
}

function collectLinkedLibraries(binaryPath) {
  const queue = [binaryPath];
  const seen = new Set();
  const libraries = new Map();

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (seen.has(currentPath)) {
      continue;
    }
    seen.add(currentPath);

    for (const linkedLibraryPath of parseLinkedLibraries(currentPath)) {
      if (!path.isAbsolute(linkedLibraryPath) || !fs.existsSync(linkedLibraryPath)) {
        continue;
      }

      const filename = path.basename(linkedLibraryPath);
      const existingPath = libraries.get(filename);
      if (existingPath && existingPath !== linkedLibraryPath) {
        throw new Error(`Conflicting library names for ${filename}: ${existingPath} vs ${linkedLibraryPath}`);
      }

      if (!libraries.has(filename)) {
        libraries.set(filename, linkedLibraryPath);
        queue.push(linkedLibraryPath);
      }
    }
  }

  return libraries;
}

function copyFilePreserveMode(fromPath, toPath) {
  fs.copyFileSync(fromPath, toPath);
  fs.chmodSync(toPath, fs.statSync(fromPath).mode);
}

function codesignBinary(targetPath) {
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", targetPath]);
}

function bundleTmuxBinary(tmuxPath) {
  const bundledTmuxPath = path.join(BUNDLE_RUNTIME_DIR, "tmux");
  copyFilePreserveMode(tmuxPath, bundledTmuxPath);

  const directLibraries = parseLinkedLibraries(tmuxPath);
  const linkedLibraries = collectLinkedLibraries(tmuxPath);
  for (const [filename, linkedLibraryPath] of linkedLibraries.entries()) {
    copyFilePreserveMode(linkedLibraryPath, path.join(BUNDLE_LIB_DIR, filename));
  }

  for (const [filename, linkedLibraryPath] of linkedLibraries.entries()) {
    const bundledLibraryPath = path.join(BUNDLE_LIB_DIR, filename);
    run("install_name_tool", ["-id", `@loader_path/${filename}`, bundledLibraryPath]);

    for (const nestedLibraryPath of parseLinkedLibraries(bundledLibraryPath)) {
      const nestedFilename = path.basename(nestedLibraryPath);
      if (!linkedLibraries.has(nestedFilename)) {
        continue;
      }

      run("install_name_tool", [
        "-change",
        nestedLibraryPath,
        `@loader_path/${nestedFilename}`,
        bundledLibraryPath,
      ]);
    }

    if (directLibraries.includes(linkedLibraryPath)) {
      run("install_name_tool", [
        "-change",
        linkedLibraryPath,
        `@executable_path/lib/${filename}`,
        bundledTmuxPath,
      ]);
    }

    codesignBinary(bundledLibraryPath);
  }

  fs.chmodSync(bundledTmuxPath, 0o755);
  codesignBinary(bundledTmuxPath);
}

function bundleTmuxConfig() {
  const sourcePath = path.join(PROJECT_ROOT, "tmux.conf");
  const targetPath = path.join(BUNDLE_RUNTIME_DIR, "tmux.conf");
  copyFilePreserveMode(sourcePath, targetPath);
}

function bundleTerminfo() {
  const sourcePath = path.join(os.tmpdir(), `swarmtumx-terminfo-${process.pid}.src`);
  const sourceText = `${BUNDLED_TERM_NAMES.map((termName) => run("infocmp", ["-x", termName])).join("\n\n")}\n`;

  fs.writeFileSync(sourcePath, sourceText);
  try {
    run("tic", ["-x", "-o", BUNDLE_TERMINFO_DIR, sourcePath]);
  } finally {
    fs.rmSync(sourcePath, { force: true });
  }
}

function writeRuntimeManifest(tmuxPath) {
  const manifestPath = path.join(BUNDLE_RUNTIME_DIR, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        arch: process.arch,
        platform: process.platform,
        preparedAt: new Date().toISOString(),
        tmuxPath,
      },
      null,
      2,
    ),
  );
}

exports.default = async function beforePack() {
  if (process.platform !== "darwin") {
    return;
  }

  const tmuxPath = resolveTmuxPath();
  ensureCleanRuntimeDir();
  bundleTmuxBinary(tmuxPath);
  bundleTmuxConfig();
  bundleTerminfo();
  writeRuntimeManifest(tmuxPath);
};

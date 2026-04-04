const https = require("node:https");
const { app, dialog, Menu, shell } = require("electron");

const RELEASES_API_URL = "https://api.github.com/repos/bitkira/SwarmTumx/releases?per_page=10";
const STARTUP_CHECK_DELAY_MS = 15_000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function parseVersion(value) {
  const normalized = normalizeVersion(value);
  const [mainPart, preReleasePart = ""] = normalized.split("-");
  const main = mainPart
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

  return {
    main,
    normalized,
    preRelease: preReleasePart,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.main.length, b.main.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = a.main[index] || 0;
    const rightPart = b.main[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (!a.preRelease && b.preRelease) {
    return 1;
  }
  if (a.preRelease && !b.preRelease) {
    return -1;
  }

  return a.preRelease.localeCompare(b.preRelease);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `SwarmTumx/${app.getVersion()}`,
      },
      timeout: 10_000,
    }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`GitHub release check failed (${response.statusCode}).`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("GitHub release check timed out."));
    });
    request.on("error", reject);
  });
}

function findPreferredAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const arch = process.arch;
  const preferredExtensions = process.platform === "darwin"
    ? [".dmg", ".zip"]
    : [".zip"];

  for (const extension of preferredExtensions) {
    const directMatch = assets.find((asset) =>
      asset?.name?.includes(arch) && asset.name.endsWith(extension));
    if (directMatch?.browser_download_url) {
      return directMatch.browser_download_url;
    }

    const fallback = assets.find((asset) => asset?.name?.endsWith(extension));
    if (fallback?.browser_download_url) {
      return fallback.browser_download_url;
    }
  }

  return release?.html_url || null;
}

function describeRelease(release) {
  return {
    downloadUrl: findPreferredAsset(release),
    htmlUrl: release?.html_url || null,
    publishedAt: release?.published_at || null,
    title: release?.name || release?.tag_name || "New Release",
    version: normalizeVersion(release?.tag_name || release?.name),
  };
}

class UpdateManager {
  constructor() {
    this.initialized = false;
    this.menuBound = false;
    this.currentCheck = null;
    this.notifiedVersion = null;
    this.periodicTimer = null;
  }

  installMenu() {
    if (this.menuBound) {
      return;
    }

    const template = [
      {
        label: app.name,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates…",
            click: () => {
              void this.checkForUpdates({ manual: true });
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.menuBound = true;
  }

  initialize() {
    this.installMenu();

    if (this.initialized || !app.isPackaged) {
      return;
    }

    this.initialized = true;
    setTimeout(() => {
      void this.checkForUpdates({ manual: false });
    }, STARTUP_CHECK_DELAY_MS);

    this.periodicTimer = setInterval(() => {
      void this.checkForUpdates({ manual: false });
    }, PERIODIC_CHECK_MS);
  }

  async fetchLatestRelease() {
    const releases = await requestJson(RELEASES_API_URL);
    const latest = (Array.isArray(releases) ? releases : []).find((release) => !release?.draft);
    return latest ? describeRelease(latest) : null;
  }

  async showUpdateAvailable(info) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update Available",
      message: `${info.title} is available.`,
      detail: "SwarmTumx found a newer release on GitHub. Download the new build to update.",
    });

    if (response === 0) {
      await shell.openExternal(info.downloadUrl || info.htmlUrl);
    }
  }

  async showUpToDate() {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["OK"],
      title: "Up to Date",
      message: `SwarmTumx ${app.getVersion()} is up to date.`,
    });
  }

  async showCheckFailed(error) {
    await dialog.showMessageBox({
      type: "error",
      buttons: ["OK"],
      title: "Update Check Failed",
      message: "SwarmTumx could not check for updates.",
      detail: String(error?.message || error),
    });
  }

  async checkForUpdates({ manual = false } = {}) {
    if (!app.isPackaged) {
      if (manual) {
        await dialog.showMessageBox({
          type: "info",
          buttons: ["OK"],
          title: "Updates Unavailable",
          message: "Update checks run only in packaged builds.",
        });
      }
      return null;
    }

    if (this.currentCheck) {
      return this.currentCheck;
    }

    this.currentCheck = (async () => {
      try {
        const latest = await this.fetchLatestRelease();
        if (!latest?.version) {
          if (manual) {
            await this.showCheckFailed("No GitHub release metadata was available.");
          }
          return null;
        }

        const currentVersion = normalizeVersion(app.getVersion());
        const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

        if (hasUpdate) {
          if (manual || this.notifiedVersion !== latest.version) {
            this.notifiedVersion = latest.version;
            await this.showUpdateAvailable(latest);
          }
          return latest;
        }

        if (manual) {
          await this.showUpToDate();
        }

        return null;
      } catch (error) {
        if (manual) {
          await this.showCheckFailed(error);
        }
        return null;
      } finally {
        this.currentCheck = null;
      }
    })();

    return this.currentCheck;
  }
}

module.exports = {
  UpdateManager,
};

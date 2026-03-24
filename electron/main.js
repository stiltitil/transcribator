const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");

const desktopPort = Number(process.env.PORT || 3100);
const baseUrl = `http://127.0.0.1:${desktopPort}`;

let mainWindow = null;
let serverInstance = null;

app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");

app.whenReady().then(async () => {
  try {
    process.env.PORT = String(desktopPort);
    process.env.TRANSCRIBATOR_UPLOAD_DIR = path.join(app.getPath("userData"), "uploads");
    process.env.TRANSCRIBATOR_SETTINGS_PATH = path.join(
      app.getPath("userData"),
      "transcribator-settings.json"
    );
    process.env.TRANSCRIBATOR_ENV_PATH =
      process.env.PORTABLE_EXECUTABLE_DIR
        ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, ".env")
        : path.join(process.cwd(), ".env");
    const { startServer } = require(path.join(__dirname, "..", "server.js"));
    serverInstance = startServer(desktopPort);
    await waitForHealthcheck();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Transcribator failed to start",
      error?.message || "Unknown startup error."
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: "#0f0d12",
    title: "Transcribator",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(baseUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function waitForHealthcheck() {
  let lastError = null;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }

      lastError = new Error(`Healthcheck failed with status ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw lastError || new Error("Timed out waiting for local server startup.");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

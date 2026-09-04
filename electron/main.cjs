const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const APP_NAME = "LeRobot Dataset Visualizer";
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.ELECTRON_INTERNAL_PORT ?? "3210");
const SMOKE_TEST =
  process.env.DESKTOP_SMOKE_TEST === "1" ||
  process.argv.includes("--desktop-smoke-test");
const READY_TIMEOUT_MS = Number(
  process.env.ELECTRON_SERVER_READY_TIMEOUT_MS ??
    (SMOKE_TEST ? "90000" : "30000"),
);

let mainWindow = null;
let nextServer = null;

function appBaseUrl() {
  return DEV_SERVER_URL ?? `http://${SERVER_HOST}:${SERVER_PORT}`;
}

function standaloneDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "next")
    : path.join(app.getAppPath(), ".next", "standalone");
}

async function startBundledServer() {
  if (DEV_SERVER_URL || nextServer) return;
  const directory = standaloneDirectory();
  const entry = path.join(directory, "server.js");
  await fs.access(entry);

  nextServer = fork(entry, [], {
    cwd: directory,
    env: {
      ...process.env,
      HOSTNAME: SERVER_HOST,
      PORT: String(SERVER_PORT),
    },
    stdio: "inherit",
  });
  nextServer.once("exit", (code) => {
    nextServer = null;
    if (!app.isQuitting && code && code !== 0) {
      dialog.showErrorBox(
        "Application server stopped",
        `The embedded server exited with code ${code}.`,
      );
      app.quit();
    }
  });
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    try {
      const response = await fetch(appBaseUrl(), { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The bundled server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${appBaseUrl()}`);
}

async function selectDatasetDirectory() {
  const result = await dialog.showOpenDialog({
    title: "Choose a LeRobot dataset directory",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const selected = result.filePaths[0];
  const stats = await fs.stat(selected);
  if (!stats.isDirectory())
    throw new Error("Selected path is not a directory.");
  try {
    await fs.access(path.join(selected, "meta", "info.json"));
  } catch {
    throw new Error("The selected directory does not contain meta/info.json.");
  }
  return selected;
}

async function createWindow() {
  await startBundledServer();
  await waitForServer();

  if (SMOKE_TEST) {
    console.log(`Desktop smoke test ready at ${appBaseUrl()}`);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#0a0e17",
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  await mainWindow.loadURL(appBaseUrl());
  if (DEV_SERVER_URL) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("desktop:select-dataset-directory", selectDatasetDirectory);

app.on("before-quit", () => {
  app.isQuitting = true;
  nextServer?.kill("SIGTERM");
});

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  try {
    await createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (!SMOKE_TEST) dialog.showErrorBox("Failed to launch", message);
    app.exit(1);
  }

  app.on("activate", () => {
    if (!SMOKE_TEST && BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

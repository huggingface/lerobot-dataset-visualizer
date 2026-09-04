const fs = require("node:fs/promises");
const path = require("node:path");
const electronDist = require("./scripts/electron-builder-electron-dist.cjs");
const electronPackage = require("electron/package.json");

const PRODUCT_NAME = "LeRobot Dataset Visualizer";

function resourcesDirectory(appOutDir, platform) {
  return platform === "darwin"
    ? path.join(appOutDir, `${PRODUCT_NAME}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
}

module.exports = {
  appId: "io.github.saltedfisssh.lerobot-dataset-visualizer",
  productName: PRODUCT_NAME,
  electronVersion: electronPackage.version,
  artifactName: `lerobot-dataset-visualizer-\${version}-\${os}-\${arch}.\${ext}`,
  compression: "normal",
  npmRebuild: false,
  electronDist: electronDist.default,
  directories: { output: path.join(__dirname, "dist-electron") },
  files: ["**/*"],
  afterPack: async (context) => {
    const destination = path.join(
      resourcesDirectory(context.appOutDir, context.electronPlatformName),
      "next",
    );
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(path.join(__dirname, ".next", "standalone"), destination, {
      recursive: true,
      force: true,
    });
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Science",
    maintainer: "saltedfisssh",
    executableName: "lerobot-dataset-visualizer",
    syncDesktopName: true,
  },
  win: { target: ["nsis"] },
  mac: { target: ["dmg"], category: "public.app-category.education" },
};

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const appDir = path.join(
  os.tmpdir(),
  "lerobot-dataset-visualizer-electron-app",
);
const sourcePackage = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const packageJson = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  description: sourcePackage.description,
  homepage: sourcePackage.homepage,
  repository: sourcePackage.repository,
  desktopName: "lerobot-dataset-visualizer",
  main: "electron/main.cjs",
};

await fs.rm(appDir, { recursive: true, force: true });
await fs.mkdir(path.join(appDir, "electron"), { recursive: true });
await fs.cp(path.join(root, "electron"), path.join(appDir, "electron"), {
  recursive: true,
  force: true,
});
await fs.writeFile(
  path.join(appDir, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
);

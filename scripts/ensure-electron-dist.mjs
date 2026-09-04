import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const custom = process.env.ELECTRON_BUILDER_ELECTRON_DIST;
const electronDist = custom
  ? path.resolve(custom)
  : path.join(root, "node_modules", "electron", "dist");

try {
  await fs.access(electronDist);
  process.exit(0);
} catch {
  if (custom) throw new Error(`Electron dist does not exist: ${electronDist}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [path.join(root, "node_modules", "electron", "install.js")],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Electron install exited ${code}`)),
  );
});

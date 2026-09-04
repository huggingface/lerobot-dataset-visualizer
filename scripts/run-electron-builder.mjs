import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const appDir = path.join(
  os.tmpdir(),
  "lerobot-dataset-visualizer-electron-app",
);
const builder = path.join(root, "node_modules", "electron-builder", "cli.js");
const args = process.argv.slice(2);
const configIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
if (configIndex >= 0 && args[configIndex + 1]) {
  args[configIndex + 1] = path.resolve(root, args[configIndex + 1]);
}

const child = spawn(
  process.execPath,
  [builder, "--projectDir", appDir, ...args],
  { cwd: root, stdio: "inherit", env: process.env },
);
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

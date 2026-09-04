import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const port = process.env.NEXT_DEV_PORT ?? "3000";
const rendererUrl = `http://127.0.0.1:${port}`;
const binary = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

const next = spawn(
  "bun",
  ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", port],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  },
);
let electron;

async function waitForRenderer() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(rendererUrl)).ok) return;
    } catch {
      // Next.js is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Next.js development server.");
}

function stop(code = 0) {
  electron?.kill("SIGTERM");
  next.kill("SIGTERM");
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());

try {
  await waitForRenderer();
  electron = spawn(binary, ["electron/main.cjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  });
  electron.once("exit", (code) => stop(code ?? 0));
} catch (error) {
  console.error(error);
  stop(1);
}

import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A packaged application command is required.");

const port = process.env.ELECTRON_INTERNAL_PORT ?? "3210";
const timeout = Number(process.env.SMOKE_TEST_TIMEOUT_MS ?? "90000");
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_SMOKE_TEST: "1",
    ELECTRON_INTERNAL_PORT: port,
    ELECTRON_SERVER_READY_TIMEOUT_MS: String(timeout),
  },
});
let exited = false;
child.once("exit", () => {
  exited = true;
});

const started = Date.now();
while (Date.now() - started < timeout && !exited) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (response.ok) {
      console.log("Packaged desktop smoke test passed.");
      child.kill("SIGTERM");
      process.exit(0);
    }
  } catch {
    // The packaged app is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

child.kill("SIGTERM");
throw new Error("Packaged desktop application did not become ready.");

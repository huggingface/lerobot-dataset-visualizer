#!/usr/bin/env node
// One-liner launcher for viewing LOCAL datasets:
//
//   bun run local <datasets-dir> [--port N] [...next-dev-args]
//   LEROBOT_DATASET_ROOT=<dir> bun run local
//
// <datasets-dir> is a LeRobot dataset directory (has meta/info.json) or a folder
// of them. It sets NEXT_PUBLIC_DATASET_URL=/local-data + LEROBOT_LOCAL_DATASET_ROOTS,
// keeps the listen port and the server self-fetch origin in sync, installs deps on
// first run, and starts `next dev`. Ctrl-C stops it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
process.chdir(repoRoot);

const argv = process.argv.slice(2);
const root =
  argv[0] && !argv[0].startsWith("-")
    ? argv.shift()
    : process.env.LEROBOT_DATASET_ROOT;

if (!root) {
  console.error(
    "Usage: bun run local <datasets-dir> [--port N] [...next-dev-args]",
  );
  console.error("   or: LEROBOT_DATASET_ROOT=<dir> bun run local");
  process.exit(1);
}
const datasetsRoot = path.resolve(root);
if (!existsSync(datasetsRoot) || !statSync(datasetsRoot).isDirectory()) {
  console.error(`Not a directory: ${datasetsRoot}`);
  process.exit(1);
}

// Extract the port from the forwarded args (or PORT env) so the listen port and the
// server self-fetch origin (src/utils/dataUrl.ts) always agree — the one thing a bare
// `--port` flag would otherwise get wrong.
let port = process.env.PORT;
for (let i = 0; i < argv.length; i++) {
  const eq = /^(?:--port|-p)=(\d+)$/.exec(argv[i]);
  if (eq) port = eq[1];
  else if ((argv[i] === "--port" || argv[i] === "-p") && argv[i + 1])
    port = argv[i + 1];
}
port = port || "3000";

if (!existsSync(path.join(repoRoot, "node_modules"))) {
  console.log("Installing dependencies (first run)…");
  if (spawnSync("bun", ["install"], { stdio: "inherit" }).status !== 0)
    process.exit(1);
}

const env = {
  ...process.env,
  PORT: port,
  NEXT_PUBLIC_DATASET_URL: "/local-data",
  LEROBOT_LOCAL_DATASET_ROOTS: datasetsRoot,
};

// List the datasets that will be registered, so the terminal is the picker.
const isDataset = (d) => {
  try {
    return statSync(path.join(d, "meta", "info.json")).isFile();
  } catch {
    return false;
  }
};
let found;
try {
  found = isDataset(datasetsRoot)
    ? [path.basename(datasetsRoot)]
    : readdirSync(datasetsRoot).filter((n) =>
        isDataset(path.join(datasetsRoot, n)),
      );
} catch {
  found = [];
}
console.log(`\n  datasets root : ${datasetsRoot}`);
if (found.length === 1) {
  // Single dataset: let the bare "/" land straight on it. The landing page already
  // redirects to /$REPO_ID/episode_0 when REPO_ID is set.
  env.REPO_ID = `local/${found[0]}`;
  console.log(`  open http://localhost:${port}/   → ${env.REPO_ID}/episode_0`);
} else if (found.length > 1) {
  console.log("  open one in your browser:");
  for (const name of found.sort())
    console.log(`    http://localhost:${port}/local/${name}/0`);
} else {
  console.log("  (no dataset with meta/info.json found under this path)");
}
console.log();

const child = spawn("next", ["dev", ...argv], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

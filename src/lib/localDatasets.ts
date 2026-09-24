import fs from "node:fs";
import path from "node:path";

/**
 * Registry of local LeRobot datasets: repo id -> absolute directory.
 *
 * Opt-in via `LEROBOT_LOCAL_DATASET_ROOTS` (colon-separated dirs); each child — or the
 * dir itself — with `meta/info.json` is registered as `local/<basename>`. Empty on the
 * hosted deployment, so the local-data route handler is inert there (returns 404). Read
 * fresh on each call so newly added datasets appear without a restart.
 */
function isDatasetDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "meta", "info.json")).isFile();
  } catch {
    return false;
  }
}

function getLocalDatasets(): Record<string, string> {
  const out: Record<string, string> = {};
  const roots = (process.env.LEROBOT_LOCAL_DATASET_ROOTS || "")
    .split(":")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const root of roots) {
    const absRoot = path.resolve(root);
    if (isDatasetDir(absRoot)) {
      out[`local/${path.basename(absRoot)}`] = absRoot;
      continue;
    }
    try {
      for (const name of fs.readdirSync(absRoot)) {
        const child = path.join(absRoot, name);
        if (isDatasetDir(child)) out[`local/${name}`] = child;
      }
    } catch {
      // ignore an unreadable root
    }
  }
  return out;
}

/**
 * Resolve a repo-relative path to an absolute file inside the dataset dir, or
 * null if the repo is unknown or the path escapes the dir (traversal guard).
 */
export function resolveLocalFile(
  repoId: string,
  relPath: string,
): string | null {
  const base = getLocalDatasets()[repoId.toLowerCase()];
  if (!base) return null;
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

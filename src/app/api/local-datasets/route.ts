import { NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import { join, resolve, relative } from "path";

const LOCAL_DATASET_PATH = process.env.LOCAL_DATASET_PATH;

export type LocalDatasetEntry = {
  name: string;
  robotType: string | null;
  totalEpisodes: number;
  totalFrames: number;
  fps: number;
  codebaseVersion: string;
};

const MAX_DEPTH = 5;

/**
 * Recursively discover dataset directories (those containing meta/info.json).
 */
async function discoverDatasets(
  base: string,
  dir: string,
  depth: number,
): Promise<LocalDatasetEntry[]> {
  if (depth > MAX_DEPTH) return [];

  let dirents: import("fs").Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: LocalDatasetEntry[] = [];

  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const childDir = join(dir, d.name);
    const infoPath = join(childDir, "meta", "info.json");

    try {
      const raw = await readFile(infoPath, "utf-8");
      const info = JSON.parse(raw) as Record<string, unknown>;
      if (!info.features) {
        // Not a valid dataset — recurse deeper
        results.push(...(await discoverDatasets(base, childDir, depth + 1)));
        continue;
      }

      results.push({
        name: relative(base, childDir),
        robotType: (info.robot_type as string) ?? null,
        totalEpisodes: (info.total_episodes as number) ?? 0,
        totalFrames: (info.total_frames as number) ?? 0,
        fps: (info.fps as number) ?? 0,
        codebaseVersion: (info.codebase_version as string) ?? "unknown",
      });
    } catch {
      // No info.json — recurse deeper to find nested datasets
      results.push(...(await discoverDatasets(base, childDir, depth + 1)));
    }
  }

  return results;
}

export async function GET(): Promise<NextResponse> {
  if (!LOCAL_DATASET_PATH) {
    return NextResponse.json(
      { error: "Local dataset mode not enabled" },
      { status: 404 },
    );
  }

  const base = resolve(process.cwd(), LOCAL_DATASET_PATH);
  const datasets = await discoverDatasets(base, base, 0);
  datasets.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ datasets });
}

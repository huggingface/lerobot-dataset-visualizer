import { NextResponse } from "next/server";
import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";

const LOCAL_DATASET_PATH = process.env.LOCAL_DATASET_PATH;

export type LocalDatasetEntry = {
  name: string;
  robotType: string | null;
  totalEpisodes: number;
  totalFrames: number;
  fps: number;
  codebaseVersion: string;
};

export async function GET(): Promise<NextResponse> {
  if (!LOCAL_DATASET_PATH) {
    return NextResponse.json(
      { error: "Local dataset mode not enabled" },
      { status: 404 },
    );
  }

  const base = resolve(process.cwd(), LOCAL_DATASET_PATH);
  const dirents = await readdir(base, { withFileTypes: true });
  const datasets: LocalDatasetEntry[] = [];

  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const infoPath = join(base, d.name, "meta", "info.json");
    try {
      const raw = await readFile(infoPath, "utf-8");
      const info = JSON.parse(raw) as Record<string, unknown>;
      if (!info.features) continue;
      datasets.push({
        name: d.name,
        robotType: (info.robot_type as string) ?? null,
        totalEpisodes: (info.total_episodes as number) ?? 0,
        totalFrames: (info.total_frames as number) ?? 0,
        fps: (info.fps as number) ?? 0,
        codebaseVersion: (info.codebase_version as string) ?? "unknown",
      });
    } catch {
      // No info.json or invalid — skip
    }
  }

  datasets.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ datasets });
}

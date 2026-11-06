import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SubpathLeRobotDataset,
  normalizeDatasetPath,
  datasetSourceKey,
  episodeHref,
  spaceRedirect,
} from "../datasetSource";
import {
  buildVersionedUrl,
  getDatasetInfo,
  getDatasetStats,
} from "../versionUtils";
import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const frames = readFileSync(
  new URL("./fixtures/subpath-frames.parquet", import.meta.url),
);
const episodes = readFileSync(
  new URL("./fixtures/subpath-episodes.parquet", import.meta.url),
);
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

/** A local origin with real parquet and byte ranges; no Hub/network dependency. */
function origin(
  files: Record<string, Uint8Array>,
  seen: string[],
): typeof fetch {
  return (async (input, init) => {
    const path = decodeURIComponent(String(input).split("/resolve/main/")[1]);
    seen.push(path);
    const body = files[path];
    if (!body) return new Response(null, { status: 404 });
    const range = new Headers(init?.headers)
      .get("range")
      ?.match(/^bytes=(-?\d+)-?(\d*)$/);
    if (!range) return new Response(Uint8Array.from(body), { status: 200 });
    const start =
      Number(range[1]) < 0
        ? Math.max(0, body.length + Number(range[1]))
        : Number(range[1]);
    if (start >= body.length) return new Response(null, { status: 416 });
    const end = range[2]
      ? Math.min(Number(range[2]), body.length - 1)
      : body.length - 1;
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
    });
  }) as typeof fetch;
}

function info(version: string, totalEpisodes = 1) {
  const v3 = version === "v3.0";
  return {
    codebase_version: version,
    fps: 1,
    total_episodes: totalEpisodes,
    total_frames: 2,
    chunks_size: 1000,
    data_path: v3
      ? "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
      : "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
    video_path: v3
      ? "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"
      : "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
    features: {
      cam: { dtype: "video", shape: [16, 16, 3], names: null },
      action: { dtype: "float32", shape: [1], names: ["joint"] },
    },
  };
}

describe("dataset directories", () => {
  test("normalizes root and relative paths without accepting traversal", () => {
    expect(normalizeDatasetPath("./datasets//one/")).toBe("datasets/one");
    expect(normalizeDatasetPath("/")).toBe("");
    for (const path of ["../two", "one/../two", "one\\two", "one\0two"])
      expect(() => normalizeDatasetPath(path)).toThrow();
    expect(datasetSourceKey("org/repo")).toBe(
      datasetSourceKey({ repoId: "org/repo", path: "./" }),
    );
    expect(
      datasetSourceKey({ repoId: "org/repo", path: "datasets/one" }),
    ).not.toBe(datasetSourceKey({ repoId: "org/repo", path: "datasets/two" }));
  });

  test("encodes directories and filenames exactly once for library and viewer URLs", () => {
    const source = { repoId: "org/repo", path: "./datasets/robot #1%/" };
    const dataset = new SubpathLeRobotDataset(source);
    const expected =
      "https://huggingface.co/datasets/org/repo/resolve/main/datasets/robot%20%231%25/meta/info.json";
    expect(dataset.fileUrl("meta/info.json")).toBe(expected);
    expect(buildVersionedUrl(source, "v3.0", "meta/info.json")).toBe(expected);
    expect(
      new SubpathLeRobotDataset("org/repo").fileUrl("meta/info.json"),
    ).toBe(
      "https://huggingface.co/datasets/org/repo/resolve/main/meta/info.json",
    );
    expect(() => dataset.fileUrl("../meta/info.json")).toThrow();
  });

  for (const version of ["v2.0", "v2.1", "v3.0"]) {
    test(`${version}: the actual episode loader reads nested metadata, frames and video URLs`, async () => {
      const path = "datasets/robot one";
      const seen: string[] = [];
      const v3 = version === "v3.0";
      const dataPath = v3
        ? "data/chunk-000/file-000.parquet"
        : "data/chunk-000/episode_000000.parquet";
      globalThis.fetch = origin(
        {
          [`${path}/meta/info.json`]: encode(info(version)),
          [`${path}/meta/episodes/chunk-000/file-000.parquet`]: episodes,
          [`${path}/meta/episodes.jsonl`]: new TextEncoder().encode(
            JSON.stringify({ episode_index: 0, length: 2, tasks: ["pick"] }) +
              "\n",
          ),
          [`${path}/${dataPath}`]: frames,
        },
        seen,
      );
      const result = await getEpisodeDataSafe(
        "test",
        `subpath-${version}`,
        0,
        path,
      );
      expect(result.error).toBeUndefined();
      expect(result.data?.datasetInfo.repoId).toBe(`test/subpath-${version}`);
      expect(result.data?.datasetInfo.path).toBe(path);
      expect(result.data?.flatChartData.length).toBe(2);
      expect(result.data?.videosInfo[0].url).toContain(
        "/datasets/robot%20one/videos/cam/",
      );
      if (v3) expect(result.data?.videosInfo[0].segmentStart).toBe(3);
      expect(seen.some((file) => file === `${path}/${dataPath}`)).toBe(true);
      expect(seen.every((file) => file.startsWith(`${path}/`))).toBe(true);
    });
  }

  test("metadata and stats caches isolate two datasets inside the same repository", async () => {
    const seen: string[] = [];
    globalThis.fetch = origin(
      {
        "meta/info.json": encode(info("v3.0", 3)),
        "datasets/one/meta/info.json": encode(info("v3.0", 1)),
        "datasets/two/meta/info.json": encode(info("v2.1", 2)),
        "datasets/one/meta/stats.json": encode({ action: { min: [1] } }),
        "datasets/two/meta/stats.json": encode({ action: { min: [2] } }),
      },
      seen,
    );
    const one = { repoId: "test/cache-isolation", path: "datasets/one" };
    const two = { repoId: one.repoId, path: "datasets/two" };
    expect((await getDatasetInfo(one)).total_episodes).toBe(1);
    expect((await getDatasetInfo(two)).total_episodes).toBe(2);
    expect((await getDatasetInfo(one.repoId)).total_episodes).toBe(3);
    expect(await getDatasetStats(one)).toEqual({ action: { min: [1] } });
    expect(await getDatasetStats(two)).toEqual({ action: { min: [2] } });
    await getDatasetInfo({ ...one, path: "./datasets/one/" });
    await getDatasetStats(one);
    expect(seen).toHaveLength(5);
  });
});

describe("viewer links", () => {
  test("preserves the directory when selecting another episode", () => {
    expect(
      new URL(
        episodeHref(5, "datasets/robot #1"),
        "https://viewer.invalid/org/repo/episode_0",
      ).searchParams.get("path"),
    ).toBe("datasets/robot #1");
    expect(episodeHref(5)).toBe("./episode_5");
  });
  test("opens old Space links and nested query-string links", () => {
    expect(
      spaceRedirect(new URLSearchParams({ path: "/org/repo/episode_0" })),
    ).toBe("/org/repo/episode_0");
    expect(
      spaceRedirect(
        new URLSearchParams({
          path: "/org/repo/episode_0?path=datasets%2Fone&t=4",
        }),
      ),
    ).toBe("/org/repo/episode_0?path=datasets%2Fone&t=4");
    expect(
      spaceRedirect(
        new URLSearchParams({
          path: "/org/repo/episode_0",
          datasetPath: "datasets/two",
          t: "6",
        }),
      ),
    ).toBe("/org/repo/episode_0?t=6&path=datasets%2Ftwo");
    expect(
      spaceRedirect(
        new URLSearchParams({
          dataset: "org/repo",
          episode: "2",
          datasetPath: "datasets/one",
        }),
      ),
    ).toBe("/org/repo/episode_2?path=datasets%2Fone");
    for (const path of [
      "https://evil.example/org/repo",
      "//evil.example/org/repo",
      "javascript:alert(1)",
    ])
      expect(spaceRedirect(new URLSearchParams({ path }))).toBeNull();
  });
});

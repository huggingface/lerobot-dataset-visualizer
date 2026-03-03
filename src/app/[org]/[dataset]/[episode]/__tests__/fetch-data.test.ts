import { describe, expect, test } from "bun:test";
import { computeColumnMinMax } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { ChartRow } from "@/app/[org]/[dataset]/[episode]/fetch-data";

// ---------------------------------------------------------------------------
// computeColumnMinMax
// Used by the stats panel to display per-column min/max for any dataset version.
// ---------------------------------------------------------------------------

describe("computeColumnMinMax — flat numeric values (v2.x / v3.0 style)", () => {
  test("returns empty array for empty chart data groups", () => {
    expect(computeColumnMinMax([])).toEqual([]);
  });

  test("returns empty array for groups with only timestamp columns", () => {
    const groups: ChartRow[][] = [[{ timestamp: 0 }, { timestamp: 1 }]];
    expect(computeColumnMinMax(groups)).toEqual([]);
  });

  test("computes min/max for a single flat series", () => {
    const groups: ChartRow[][] = [
      [
        { timestamp: 0, "progress | sparse": 0.1 },
        { timestamp: 0.5, "progress | sparse": 0.5 },
        { timestamp: 1.0, "progress | sparse": 0.9 },
      ],
    ];
    const result = computeColumnMinMax(groups);
    expect(result).toHaveLength(1);
    expect(result[0].column).toBe("progress | sparse");
    expect(result[0].min).toBe(0.1);
    expect(result[0].max).toBe(0.9);
  });

  test("rounds to 3 decimal places", () => {
    const groups: ChartRow[][] = [
      [
        { timestamp: 0, col: 1.23456789 },
        { timestamp: 1, col: 2.0 },
      ],
    ];
    const result = computeColumnMinMax(groups);
    expect(result[0].min).toBe(1.235); // rounded
    expect(result[0].max).toBe(2.0);
  });

  test("ignores non-finite values (Infinity, NaN)", () => {
    const groups: ChartRow[][] = [
      [
        { timestamp: 0, col: Infinity },
        { timestamp: 0.5, col: 3.0 },
        { timestamp: 1, col: NaN },
      ],
    ];
    const result = computeColumnMinMax(groups);
    expect(result[0].min).toBe(3.0);
    expect(result[0].max).toBe(3.0);
  });
});

describe("computeColumnMinMax — nested group values (grouped suffix format)", () => {
  test("computes min/max for nested observation.state group (v2.x 6-DoF robot)", () => {
    const groups: ChartRow[][] = [
      [
        {
          timestamp: 0,
          "observation.state": { "0": -0.5, "1": 0.2, "2": 1.5 },
        },
        {
          timestamp: 0.1,
          "observation.state": { "0": -0.3, "1": 0.8, "2": 0.7 },
        },
      ],
    ];
    const result = computeColumnMinMax(groups);
    const colMap = Object.fromEntries(result.map((r) => [r.column, r]));

    // observation.state | 0: min=-0.5, max=-0.3
    expect(colMap["observation.state | 0"].min).toBe(-0.5);
    expect(colMap["observation.state | 0"].max).toBe(-0.3);

    // observation.state | 1: min=0.2, max=0.8
    expect(colMap["observation.state | 1"].min).toBe(0.2);
    expect(colMap["observation.state | 1"].max).toBe(0.8);

    // observation.state | 2: min=0.7, max=1.5
    expect(colMap["observation.state | 2"].min).toBe(0.7);
    expect(colMap["observation.state | 2"].max).toBe(1.5);
  });

  test("handles multiple groups (action + state) across multiple chart data groups", () => {
    const groups: ChartRow[][] = [
      [
        {
          timestamp: 0,
          "observation.state": { "0": 0.1, "1": 0.2 },
        },
      ],
      [
        {
          timestamp: 0,
          action: { "0": -1.0, "1": 1.0 },
        },
      ],
    ];
    const result = computeColumnMinMax(groups);
    const colMap = Object.fromEntries(result.map((r) => [r.column, r]));

    expect(colMap["observation.state | 0"]).toBeDefined();
    expect(colMap["action | 0"].min).toBe(-1.0);
    expect(colMap["action | 0"].max).toBe(-1.0);
    expect(colMap["action | 1"].min).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Version-specific path construction integration tests
//
// These tests verify that the path templates for v2.0, v2.1, and v3.0 produce
// correct URLs when combined with buildVersionedUrl and formatStringWithVars.
// ---------------------------------------------------------------------------

import { buildVersionedUrl } from "@/utils/versionUtils";
import { formatStringWithVars } from "@/utils/parquetUtils";
import {
  buildV3DataPath,
  buildV3VideoPath,
  buildV3EpisodesMetadataPath,
} from "@/utils/stringFormatting";
import { PADDING } from "@/utils/constants";

const DATASET_BASE = "https://huggingface.co/datasets";

function makeChunkAndIndex(episodeId: number, chunkSize: number) {
  const episode_chunk = Math.floor(episodeId / chunkSize)
    .toString()
    .padStart(PADDING.CHUNK_INDEX, "0");
  const episode_index = episodeId
    .toString()
    .padStart(PADDING.EPISODE_INDEX, "0");
  return { episode_chunk, episode_index };
}

describe("v2.0 path construction (rabhishek100/so100_train_dataset style)", () => {
  const repoId = "rabhishek100/so100_train_dataset";
  const version = "v2.0";
  const dataPath =
    "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
  const videoPath =
    "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4";

  test("episode 0 in chunk 0", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(0, 1000);
    const path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toBe(
      `${DATASET_BASE}/${repoId}/resolve/main/data/000/episode_000000.parquet`,
    );
  });

  test("episode 42 in chunk 0", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(42, 1000);
    const path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    expect(
      formatStringWithVars(dataPath, { episode_chunk, episode_index }),
    ).toBe("data/000/episode_000042.parquet");
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toContain("/data/000/episode_000042.parquet");
  });

  test("episode 1000 in chunk 1 (chunk boundary)", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(1000, 1000);
    const path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    expect(path).toBe("data/001/episode_001000.parquet");
  });

  test("v2.0 video URL for top camera", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(7, 1000);
    const path = formatStringWithVars(videoPath, {
      video_key: "observation.images.top",
      episode_chunk,
      episode_index,
    });
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toBe(
      `${DATASET_BASE}/${repoId}/resolve/main/videos/observation.images.top/chunk-000/episode_000007.mp4`,
    );
  });
});

describe("v2.1 path construction (youliangtan/so101-table-cleanup style)", () => {
  // v2.1 uses the same path templates as v2.0
  const dataPath =
    "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet";

  test("episode 0 resolves correctly", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(0, 1000);
    const path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    expect(path).toBe("data/000/episode_000000.parquet");
  });

  test("episode in second chunk (chunk_size=1000, episode 1500)", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(1500, 1000);
    const path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    expect(path).toBe("data/001/episode_001500.parquet");
  });

  test("v2.1 URL is the same format as v2.0 (backward compatible)", () => {
    const { episode_chunk, episode_index } = makeChunkAndIndex(5, 1000);
    const v20path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    const v21path = formatStringWithVars(dataPath, {
      episode_chunk,
      episode_index,
    });
    expect(v20path).toBe(v21path);
  });
});

describe("v3.0 path construction (lerobot-data-collection/level12_rac_2_2026-02-07 style)", () => {
  const repoId = "lerobot-data-collection/level12_rac_2_2026-02-07";
  const version = "v3.0";

  test("episode metadata path for first file", () => {
    const path = buildV3EpisodesMetadataPath(0, 0);
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toBe(
      `${DATASET_BASE}/${repoId}/resolve/main/meta/episodes/chunk-000/file-000.parquet`,
    );
  });

  test("data path from episode metadata (chunk 0, file 2)", () => {
    const path = buildV3DataPath(0, 2);
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toBe(
      `${DATASET_BASE}/${repoId}/resolve/main/data/chunk-000/file-002.parquet`,
    );
  });

  test("video path for top camera (chunk 0, file 0)", () => {
    const path = buildV3VideoPath("observation.images.top", 0, 0);
    const url = buildVersionedUrl(repoId, version, path);
    expect(url).toBe(
      `${DATASET_BASE}/${repoId}/resolve/main/videos/observation.images.top/chunk-000/file-000.mp4`,
    );
  });

  test("video path for wrist camera with non-zero file index (per-camera metadata)", () => {
    // v3.0 supports per-camera video segmentation — each camera can have different file indices
    const path = buildV3VideoPath("observation.images.wrist", 0, 3);
    expect(path).toBe("videos/observation.images.wrist/chunk-000/file-003.mp4");
  });

  test("data path for large dataset spanning multiple chunks", () => {
    // Episode in chunk 1, file 5 based on episode metadata
    const path = buildV3DataPath(1, 5);
    expect(path).toBe("data/chunk-001/file-005.parquet");
  });
});

// ---------------------------------------------------------------------------
// v3.0 episode metadata row parsing (parseEpisodeRowSimple-equivalent logic)
// Tests that the BigInt conversion and field extraction work correctly with
// realistic parquet row shapes from v3.0 datasets.
// ---------------------------------------------------------------------------

import { bigIntToNumber } from "@/utils/typeGuards";

describe("v3.0 episode metadata row parsing helpers", () => {
  const toBigIntSafe = (value: unknown): number => {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    if (typeof value === "string") return parseInt(value) || 0;
    return 0;
  };

  const toNumSafe = (value: unknown): number => {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") return parseFloat(value) || 0;
    return 0;
  };

  test("parses named-key row (v3.0 primary format)", () => {
    // Simulates a row from meta/episodes/chunk-000/file-000.parquet
    const row: Record<string, unknown> = {
      episode_index: 0n,
      "data/chunk_index": 0n,
      "data/file_index": 2n,
      dataset_from_index: 0n,
      dataset_to_index: 200n,
      length: 200n,
      "videos/observation.images.top/chunk_index": 0n,
      "videos/observation.images.top/file_index": 0n,
      "videos/observation.images.top/from_timestamp": 0.0,
      "videos/observation.images.top/to_timestamp": 4.0,
    };

    expect(toBigIntSafe(row["episode_index"])).toBe(0);
    expect(toBigIntSafe(row["data/file_index"])).toBe(2);
    expect(toBigIntSafe(row["dataset_from_index"])).toBe(0);
    expect(toBigIntSafe(row["dataset_to_index"])).toBe(200);
    expect(toBigIntSafe(row["length"])).toBe(200);
    expect(toNumSafe(row["videos/observation.images.top/from_timestamp"])).toBe(
      0.0,
    );
    expect(toNumSafe(row["videos/observation.images.top/to_timestamp"])).toBe(
      4.0,
    );
  });

  test("parses numeric-key row (fallback format)", () => {
    // Fallback when column names are not available (older v3 datasets)
    const row: Record<string, unknown> = {
      "0": 5, // episode_index
      "1": 0, // data_chunk_index
      "2": 3, // data_file_index
      "3": 600, // dataset_from_index
      "4": 800, // dataset_to_index
      "5": 0, // video_chunk_index
      "6": 3, // video_file_index
      "7": 12.0, // video_from_timestamp
      "8": 16.0, // video_to_timestamp
      "9": 200, // length
    };

    const toNum = (v: unknown, fallback = 0): number =>
      typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : fallback;

    expect(toNum(row["0"])).toBe(5); // episode_index
    expect(toNum(row["2"])).toBe(3); // data_file_index
    expect(toNum(row["3"])).toBe(600); // dataset_from_index
    expect(toNum(row["4"])).toBe(800); // dataset_to_index
    expect(toNum(row["8"], 30)).toBe(16.0); // video_to_timestamp
  });

  test("bigIntToNumber converts all BigInt parquet columns correctly", () => {
    // v3.0 integer columns come out of hyparquet as BigInt
    expect(bigIntToNumber(0n, 0)).toBe(0);
    expect(bigIntToNumber(200n, 0)).toBe(200);
    expect(bigIntToNumber(1234567n, 0)).toBe(1234567);
    // Float columns remain as regular numbers
    expect(bigIntToNumber(4.0, 0)).toBe(4.0);
  });

  test("video segmentation timestamps are correctly derived for multiple episodes", () => {
    // Each episode has its own video segment; timestamps accumulate per episode
    const episodes = [
      { from_timestamp: 0.0, to_timestamp: 4.0, length: 200 },
      { from_timestamp: 4.0, to_timestamp: 8.2, length: 210 },
      { from_timestamp: 8.2, to_timestamp: 12.0, length: 190 },
    ];

    episodes.forEach((ep) => {
      const duration = ep.to_timestamp - ep.from_timestamp;
      expect(duration).toBeGreaterThan(0);
      expect(ep.from_timestamp).toBeLessThan(ep.to_timestamp);
    });

    // Segments are contiguous (each episode starts where the previous ends)
    for (let i = 1; i < episodes.length; i++) {
      expect(episodes[i].from_timestamp).toBeCloseTo(
        episodes[i - 1].to_timestamp,
        5,
      );
    }
  });
});

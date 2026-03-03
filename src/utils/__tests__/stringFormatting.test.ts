import { describe, expect, test } from "bun:test";
import {
  padNumber,
  formatEpisodeChunk,
  formatEpisodeIndex,
  formatFileIndex,
  formatChunkIndex,
  buildV3VideoPath,
  buildV3DataPath,
  buildV3EpisodesMetadataPath,
} from "@/utils/stringFormatting";

// These utilities are the foundation of v3.0 path construction.
// v2.x uses formatStringWithVars + manual padStart instead.

describe("padNumber", () => {
  test("pads single digit to 3", () => {
    expect(padNumber(1, 3)).toBe("001");
  });
  test("pads zero to 6", () => {
    expect(padNumber(0, 6)).toBe("000000");
  });
  test("does not truncate numbers longer than length", () => {
    expect(padNumber(1234, 3)).toBe("1234");
  });
  test("pads to exact length when already equal", () => {
    expect(padNumber(42, 2)).toBe("42");
  });
});

describe("formatEpisodeChunk — 3-digit padding (v2.x chunk_index, v3 chunk_index)", () => {
  test("chunk 0 → '000'", () => {
    expect(formatEpisodeChunk(0)).toBe("000");
  });
  test("chunk 1 → '001'", () => {
    expect(formatEpisodeChunk(1)).toBe("001");
  });
  test("chunk 42 → '042'", () => {
    expect(formatEpisodeChunk(42)).toBe("042");
  });
  test("chunk 999 → '999'", () => {
    expect(formatEpisodeChunk(999)).toBe("999");
  });
});

describe("formatEpisodeIndex — 6-digit padding (v2.x episode_index)", () => {
  test("index 0 → '000000'", () => {
    expect(formatEpisodeIndex(0)).toBe("000000");
  });
  test("index 42 → '000042'", () => {
    expect(formatEpisodeIndex(42)).toBe("000042");
  });
  test("index 999999 → '999999'", () => {
    expect(formatEpisodeIndex(999999)).toBe("999999");
  });
});

describe("formatFileIndex — 3-digit padding (v3.0 file_index)", () => {
  test("file 0 → '000'", () => {
    expect(formatFileIndex(0)).toBe("000");
  });
  test("file 5 → '005'", () => {
    expect(formatFileIndex(5)).toBe("005");
  });
  test("file 100 → '100'", () => {
    expect(formatFileIndex(100)).toBe("100");
  });
});

describe("formatChunkIndex — 3-digit padding (v3.0 chunk_index)", () => {
  test("chunk 0 → '000'", () => {
    expect(formatChunkIndex(0)).toBe("000");
  });
  test("chunk 12 → '012'", () => {
    expect(formatChunkIndex(12)).toBe("012");
  });
});

// v3.0 specific path builders
describe("buildV3VideoPath", () => {
  test("single camera, chunk 0, file 0", () => {
    expect(buildV3VideoPath("observation.image", 0, 0)).toBe(
      "videos/observation.image/chunk-000/file-000.mp4",
    );
  });

  test("nested camera key, non-zero chunk and file", () => {
    expect(buildV3VideoPath("observation.images.wrist", 2, 5)).toBe(
      "videos/observation.images.wrist/chunk-002/file-005.mp4",
    );
  });

  test("two-camera SO101 dataset style", () => {
    expect(buildV3VideoPath("observation.images.top", 0, 1)).toBe(
      "videos/observation.images.top/chunk-000/file-001.mp4",
    );
  });
});

describe("buildV3DataPath", () => {
  test("chunk 0, file 0", () => {
    expect(buildV3DataPath(0, 0)).toBe("data/chunk-000/file-000.parquet");
  });
  test("chunk 1, file 3", () => {
    expect(buildV3DataPath(1, 3)).toBe("data/chunk-001/file-003.parquet");
  });
  test("large indices", () => {
    expect(buildV3DataPath(10, 99)).toBe("data/chunk-010/file-099.parquet");
  });
});

describe("buildV3EpisodesMetadataPath", () => {
  test("chunk 0, file 0 (default for most datasets)", () => {
    expect(buildV3EpisodesMetadataPath(0, 0)).toBe(
      "meta/episodes/chunk-000/file-000.parquet",
    );
  });
  test("chunk 0, file 2 (multiple metadata files)", () => {
    expect(buildV3EpisodesMetadataPath(0, 2)).toBe(
      "meta/episodes/chunk-000/file-002.parquet",
    );
  });
});

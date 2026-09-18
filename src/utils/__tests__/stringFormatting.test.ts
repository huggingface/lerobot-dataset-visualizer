import { describe, expect, test } from "bun:test";
import {
  padNumber,
  formatEpisodeChunk,
  formatEpisodeIndex,
  formatFileIndex,
  formatChunkIndex,
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

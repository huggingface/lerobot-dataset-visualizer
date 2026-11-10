import { describe, expect, test } from "bun:test";
import {
  dimensionStats,
  episodesInBin,
  summarizeEpisodes,
} from "@/utils/episodeStats";

const episodes = (lengths: number[], tasks?: (i: number) => string[]) =>
  lengths.map((length, index) => ({ index, length, tasks: tasks?.(index) }));

describe("summarizeEpisodes", () => {
  test("an empty listing has no summary", () => {
    expect(summarizeEpisodes([], 30)).toBeNull();
  });

  test("lengths are reported in seconds", () => {
    const stats = summarizeEpisodes(episodes([30, 60, 90, 120]), 30)!;

    expect(stats.allEpisodeLengths.map((e) => e.lengthSeconds)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(stats.meanEpisodeLength).toBe(2.5);
    expect(stats.medianEpisodeLength).toBe(2.5);
    expect(stats.stdEpisodeLength).toBeCloseTo(1.12, 2);
    expect(stats.shortestEpisodes[0]).toEqual({
      episodeIndex: 0,
      lengthSeconds: 1,
      frames: 30,
    });
    // Longest first.
    expect(stats.longestEpisodes.map((e) => e.episodeIndex)).toEqual([
      3, 2, 1, 0,
    ]);
  });

  test("every episode lands in exactly one histogram bin", () => {
    const lengths = Array.from(
      { length: 200 },
      (_, i) => 150 + ((i * 37) % 120),
    );
    lengths[7] = 20; // an aborted recording
    lengths[42] = 2400; // an operator who walked away
    const stats = summarizeEpisodes(episodes(lengths), 30)!;
    const bins = stats.episodeLengthHistogram;

    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(200);
    const listed = bins.flatMap((_, i) =>
      episodesInBin(stats.allEpisodeLengths, bins, i),
    );
    expect(listed.length).toBe(200);
    expect(new Set(listed.map((e) => e.episodeIndex)).size).toBe(200);
    bins.forEach((bin, i) => {
      expect(episodesInBin(stats.allEpisodeLengths, bins, i).length).toBe(
        bin.count,
      );
    });
  });

  test("outliers fall into the first and last bins instead of stretching the axis", () => {
    const lengths = Array.from({ length: 300 }, (_, i) => 180 + (i % 60));
    lengths[0] = 3;
    lengths[1] = 30000;
    const stats = summarizeEpisodes(episodes(lengths), 30)!;
    const bins = stats.episodeLengthHistogram;

    // The axis covers the bulk (6 to 8 seconds), not the 1000-second outlier.
    expect(bins[bins.length - 1].hi).toBeLessThan(20);
    expect(
      episodesInBin(stats.allEpisodeLengths, bins, 0).map(
        (e) => e.episodeIndex,
      ),
    ).toContain(0);
    expect(
      episodesInBin(stats.allEpisodeLengths, bins, bins.length - 1).map(
        (e) => e.episodeIndex,
      ),
    ).toContain(1);
  });

  test("bin edges are contiguous round numbers", () => {
    const lengths = Array.from({ length: 80 }, (_, i) => 100 + i * 3);
    const bins = summarizeEpisodes(
      episodes(lengths),
      30,
    )!.episodeLengthHistogram;

    for (let i = 1; i < bins.length; i++) {
      expect(bins[i].lo).toBeCloseTo(bins[i - 1].hi, 9);
    }
    const width = bins[0].hi - bins[0].lo;
    // 1, 2, 2.5 or 5 times a power of ten.
    const mantissa = width / Math.pow(10, Math.floor(Math.log10(width)));
    expect([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9)).toBe(
      true,
    );
  });

  test("episodes of one length make a single bin", () => {
    const stats = summarizeEpisodes(episodes([400, 400, 400]), 50)!;
    const bins = stats.episodeLengthHistogram;

    expect(bins).toEqual([{ binLabel: "8.0s", count: 3, lo: 8, hi: 8 }]);
    expect(episodesInBin(stats.allEpisodeLengths, bins, 0).length).toBe(3);
    expect(stats.stdEpisodeLength).toBe(0);
  });

  test("counts episodes and frames per task, most episodes first", () => {
    const stats = summarizeEpisodes(
      episodes([100, 200, 300, 400, 500], (i) =>
        i === 4 ? ["pick", "place"] : i % 2 ? ["place"] : ["pick"],
      ),
      10,
    )!;

    expect(stats.tasks).toEqual([
      // Episodes 0, 2 and 4.
      { task: "pick", episodes: 3, frames: 900 },
      // Episodes 1, 3 and 4: an episode with two tasks counts under both.
      { task: "place", episodes: 3, frames: 1100 },
    ]);
  });

  test("a listing that names no task has no task counts", () => {
    expect(summarizeEpisodes(episodes([10, 20]), 10)!.tasks).toEqual([]);
  });
});

describe("dimensionStats", () => {
  const entry = {
    min: [-1, 0],
    max: [1, 100],
    mean: [0.1, 55],
    std: [0.5, 40],
    count: [1000],
  };

  test("pairs each component with its name", () => {
    expect(dimensionStats(entry, ["pan", "gripper"])).toEqual([
      { name: "pan", min: -1, max: 1, mean: 0.1, std: 0.5 },
      { name: "gripper", min: 0, max: 100, mean: 55, std: 40 },
    ]);
  });

  test("numbers the components when the names do not line up", () => {
    expect(dimensionStats(entry, null)!.map((s) => s.name)).toEqual(["0", "1"]);
    expect(dimensionStats(entry, ["actions"])!.map((s) => s.name)).toEqual([
      "0",
      "1",
    ]);
  });

  test("returns null for image statistics, nested by channel", () => {
    const image = {
      min: [[[0]], [[0]], [[0]]],
      max: [[[1]], [[1]], [[1]]],
      mean: [[[0.4]], [[0.4]], [[0.4]]],
      std: [[[0.2]], [[0.2]], [[0.2]]],
    };
    expect(dimensionStats(image, null)).toBeNull();
  });

  test("returns null for a missing or partial entry", () => {
    expect(dimensionStats(undefined, null)).toBeNull();
    expect(dimensionStats({ min: [0], max: [1] }, null)).toBeNull();
    expect(
      dimensionStats({ min: [0], max: [1, 2], mean: [0], std: [0] }, null),
    ).toBeNull();
    expect(
      dimensionStats({ min: [NaN], max: [1], mean: [0], std: [0] }, null),
    ).toBeNull();
  });
});

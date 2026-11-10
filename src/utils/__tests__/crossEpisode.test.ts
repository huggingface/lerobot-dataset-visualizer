import { describe, expect, test } from "bun:test";
import {
  LAG_WINDOW_FRAMES,
  computeCrossEpisodeStats,
  computeCrossEpisodeStatsInSteps,
  planEpisodeSample,
  type EpisodeSeries,
} from "@/utils/crossEpisode";

/** A deterministic stand-in for random noise. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

/**
 * Episodes of `dims` action dimensions. Each state follows its action `delay` frames later, as a
 * real arm follows its command.
 */
function makeEpisodes(options: {
  count: number;
  length: number | ((episode: number) => number);
  dims: number;
  delay?: number;
  signal: (t: number, d: number, episode: number) => number;
}): EpisodeSeries[] {
  const { count, dims, delay = 0, signal } = options;
  return Array.from({ length: count }, (_, e) => {
    const length =
      typeof options.length === "number" ? options.length : options.length(e);
    const actions = new Float32Array(length * dims);
    const states = new Float32Array(length * dims);
    for (let t = 0; t < length; t++) {
      for (let d = 0; d < dims; d++) {
        actions[t * dims + d] = signal(t, d, e);
        states[t * dims + d] = signal(Math.max(0, t - delay), d, e);
      }
    }
    return { index: e, length, actions, states };
  });
}

const names = (dims: number) => Array.from({ length: dims }, (_, d) => `j${d}`);
const input = (episodes: EpisodeSeries[], dims: number) => ({
  episodes,
  actionDim: dims,
  stateDim: dims,
  actionNames: names(dims).map((n) => `action | ${n}`),
  stateNames: names(dims),
  fps: 30,
});

/** A smooth trajectory with enough texture for a cross-correlation to lock onto. */
const wobble = (t: number, d: number, e: number) =>
  Math.sin(0.05 * t * (d + 1) + e) + 0.3 * Math.sin(0.31 * t + d + 2 * e);

describe("planEpisodeSample", () => {
  const dataset = (files: number, perFile: number, rowsPerEpisode: number) =>
    Array.from({ length: files * perFile }, (_, i) => {
      const inFile = i % perFile;
      return {
        index: i,
        file: `file-${Math.floor(i / perFile)}`,
        fromRow: inFile * rowsPerEpisode,
        toRow: (inFile + 1) * rowsPerEpisode,
      };
    });

  test("takes every episode of a dataset within both limits", () => {
    const episodes = dataset(3, 24, 200);
    expect(planEpisodeSample(episodes, 120, 1e9)).toEqual(episodes);
  });

  test("spreads the sample over every file when the budget allows", () => {
    const sample = planEpisodeSample(dataset(6, 100, 500), 120, 1e9);

    expect(sample.length).toBe(120);
    expect(new Set(sample.map((e) => e.file)).size).toBe(6);
    // Evenly within a file too: first and last episode of the first file are both in.
    expect(sample[0].index).toBe(0);
    expect(sample.some((e) => e.index === 99)).toBe(true);
  });

  test("reads only as many files as the row budget allows", () => {
    // 100 files of 50,000 rows; room for 4 of them.
    const sample = planEpisodeSample(dataset(100, 100, 500), 120, 200_000);
    const files = [...new Set(sample.map((e) => e.file))];

    expect(files.length).toBe(4);
    expect(sample.length).toBe(120);
    // Still from across the dataset, not its first four files.
    expect(files[0]).toBe("file-0");
    expect(files[files.length - 1]).toBe("file-99");
  });

  test("a file's unused share of the episodes goes to the later files", () => {
    const episodes = [
      ...dataset(1, 2, 100),
      ...dataset(1, 200, 100).map((e) => ({ ...e, file: "big" })),
    ];
    const sample = planEpisodeSample(episodes, 120, 1e9);

    expect(sample.filter((e) => e.file === "file-0").length).toBe(2);
    expect(sample.length).toBe(120);
  });

  test("never returns a single episode when the dataset has more", () => {
    // One episode per file, and a budget smaller than any file.
    const sample = planEpisodeSample(dataset(50, 1, 10_000), 120, 1);
    expect(sample.length).toBe(2);
  });

  test("an empty dataset gives an empty sample", () => {
    expect(planEpisodeSample([], 120, 1e9)).toEqual([]);
  });
});

describe("computeCrossEpisodeStats", () => {
  test("needs at least two episodes", () => {
    const [only] = makeEpisodes({
      count: 1,
      length: 300,
      dims: 2,
      signal: wobble,
    });
    expect(computeCrossEpisodeStats(input([only], 2))).toBeNull();
  });

  test("finds the delay between command and state, in frames", () => {
    for (const delay of [0, 2, 5]) {
      const episodes = makeEpisodes({
        count: 6,
        length: 400,
        dims: 3,
        delay,
        signal: wobble,
      });
      const stats = computeCrossEpisodeStats(input(episodes, 3))!;

      expect(stats.aggAlignment!.meanPeakLag).toBe(delay);
      expect(stats.aggAlignment!.meanPeakCorr).toBeGreaterThan(0.95);
      expect(stats.aggAlignment!.numPairs).toBe(3);
    }
  });

  test("keeps lags in frames on episodes longer than the lag window", () => {
    // Subsampling these episodes used to stretch every lag by the subsampling factor.
    const length = LAG_WINDOW_FRAMES * 3;
    const episodes = makeEpisodes({
      count: 3,
      length,
      dims: 2,
      delay: 4,
      signal: wobble,
    });
    const stats = computeCrossEpisodeStats(input(episodes, 2))!;

    expect(stats.aggAlignment!.meanPeakLag).toBe(4);
    // sin(0.05 t) falls to half its autocorrelation at about a sixth of its 126-frame period.
    const acf = stats.aggAutocorrelation!;
    const firstBelowHalf = acf.chartData.find((row) => row.j0 < 0.5)!.lag;
    expect(firstBelowHalf).toBeGreaterThan(15);
    expect(firstBelowHalf).toBeLessThan(26);
  });

  test("one aborted episode does not shorten the autocorrelation horizon", () => {
    const episodes = makeEpisodes({
      count: 8,
      length: (e) => (e === 3 ? 30 : 400),
      dims: 2,
      signal: wobble,
    });
    const acf = computeCrossEpisodeStats(
      input(episodes, 2),
    )!.aggAutocorrelation!;

    // The shortest episode allows 15 lags; the typical one allows the full 100.
    expect(acf.chartData.length).toBe(100);
    expect(acf.chartData[0].lag).toBe(1);
    expect(acf.chartData[0].time).toBeCloseTo(1 / 30, 10);
  });

  test("motors at rest are reported inactive and kept out of the chunk suggestion", () => {
    const episodes = makeEpisodes({
      count: 6,
      length: 400,
      dims: 3,
      // j0 moves; j1 and j2 hold one value in every episode.
      signal: (t, d, e) => (d === 0 ? wobble(t, 0, e) : 0.25 * d),
    });
    const stats = computeCrossEpisodeStats(input(episodes, 3))!;

    expect(stats.aggVelocity.map((v) => v.inactive)).toEqual([
      false,
      true,
      true,
    ]);
    expect(stats.aggAutocorrelation!.shortKeys).toEqual(["j0"]);
    // Counted in, each resting motor "decorrelates" at lag 1; two of them against one moving
    // motor made the median, and so the suggested chunk length, 1.
    expect(stats.aggAutocorrelation!.suggestedChunk).toBeGreaterThan(10);
    // And they have no command–state correlation to average in.
    expect(stats.aggAlignment!.numPairs).toBe(1);
  });

  test("a two-valued motor is reported discrete", () => {
    const episodes = makeEpisodes({
      count: 4,
      length: 300,
      dims: 2,
      signal: (t, d, e) =>
        d === 0 ? wobble(t, 0, e) : Math.floor(t / 60) % 2 ? 1 : 0,
    });
    const stats = computeCrossEpisodeStats(input(episodes, 2))!;

    expect(stats.aggVelocity[0].discrete).toBe(false);
    expect(stats.aggVelocity[1].discrete).toBe(true);
  });

  test("ranks episodes by movement and by jerkiness", () => {
    const rand = noise(11);
    const episodes = makeEpisodes({
      count: 5,
      length: 300,
      dims: 2,
      signal: (t, d, e) => {
        if (e === 1) return 0.001 * Math.sin(0.05 * t); // barely moves
        if (e === 4) return wobble(t, d, e) + 0.4 * rand(); // shaky
        return wobble(t, d, e);
      },
    });
    const stats = computeCrossEpisodeStats(input(episodes, 2))!;

    expect(stats.lowMovementEpisodes[0].episodeIndex).toBe(1);
    expect(stats.jerkyEpisodes[0].episodeIndex).toBe(4);
    expect(stats.speedDistribution.length).toBe(5);
    expect(stats.numEpisodes).toBe(5);
  });

  test("variance is zero where every episode agrees and positive where they differ", () => {
    const episodes = makeEpisodes({
      count: 4,
      length: 200,
      dims: 2,
      // j0 is the same in every episode; j1 depends on the episode.
      signal: (t, d, e) => (d === 0 ? Math.sin(0.05 * t) : e * 0.5),
    });
    const { variance, timeBins } = computeCrossEpisodeStats(
      input(episodes, 2),
    )!;

    expect(variance.length).toBe(timeBins.length);
    for (const row of variance) {
      expect(row[0]).toBeCloseTo(0, 6);
      // Values 0, 0.5, 1, 1.5: population variance 0.3125.
      expect(row[1]).toBeCloseTo(0.3125, 6);
    }
  });

  test("episodes without state still give everything but the alignment", () => {
    const episodes = makeEpisodes({
      count: 3,
      length: 300,
      dims: 2,
      signal: wobble,
    }).map((episode) => ({ ...episode, states: null }));
    const stats = computeCrossEpisodeStats(input(episodes, 2))!;

    expect(stats.aggAlignment).toBeNull();
    expect(stats.aggAutocorrelation).not.toBeNull();
    expect(stats.aggVelocity.length).toBe(2);
  });

  test("the stepped version gives the same statistics", async () => {
    const episodes = makeEpisodes({
      count: 5,
      length: 350,
      dims: 3,
      delay: 3,
      signal: wobble,
    });
    let pauses = 0;
    const stepped = await computeCrossEpisodeStatsInSteps(
      input(episodes, 3),
      async () => {
        pauses++;
      },
    );

    expect(stepped).toEqual(computeCrossEpisodeStats(input(episodes, 3)));
    expect(pauses).toBe(2);
  });
});

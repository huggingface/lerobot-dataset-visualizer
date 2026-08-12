import { describe, expect, test } from "bun:test";

import { episodeMovementScore, speedVarianceStats } from "../speedStats";

describe("speedVarianceStats", () => {
  test("clean input: plain stats, nothing dropped", () => {
    const s = speedVarianceStats([0.2, 0.4, 0.3]);
    expect(s.dropped).toBe(0);
    expect(s.speeds).toEqual([0.2, 0.3, 0.4]);
    expect(s.mean).toBeCloseTo(0.3, 10);
    expect(s.median).toBeCloseTo(0.3, 10);
    expect(s.cv).toBeGreaterThan(0);
  });

  test("NaN entries are dropped and counted — stats come from what remains", () => {
    const s = speedVarianceStats([0.2, NaN, 0.4, NaN, 0.3]);
    expect(s.dropped).toBe(2);
    expect(s.speeds).toEqual([0.2, 0.3, 0.4]);
    expect(s.mean).toBeCloseTo(0.3, 10);
    expect(Number.isFinite(s.cv)).toBe(true);
  });

  test("THE BUG THIS EXISTS FOR: one NaN must not yield cv=0 (the false green verdict)", () => {
    // Before: mean=NaN -> (NaN > 0) is false -> cv fell through to 0 -> "Consistent".
    // Identical speeds except one NaN: cv must reflect the real (finite) spread, and a
    // genuinely varied set must never come back 0 because a NaN poisoned the mean.
    const varied = speedVarianceStats([0.1, NaN, 0.9]);
    expect(varied.cv).toBeGreaterThan(0.2); // would have been 0 before the fix
  });

  test("Infinity is dropped like NaN — it is a broken reading, not a fast demonstrator", () => {
    const s = speedVarianceStats([0.2, Infinity, 0.3]);
    expect(s.dropped).toBe(1);
    expect(s.speeds).toEqual([0.2, 0.3]);
  });

  test("nothing finite: every stat is NaN, never a fabricated 0", () => {
    const s = speedVarianceStats([NaN, NaN]);
    expect(s.dropped).toBe(2);
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.cv)).toBe(true);
  });

  test("empty input behaves like all-dropped", () => {
    const s = speedVarianceStats([]);
    expect(s.speeds).toEqual([]);
    expect(Number.isNaN(s.median)).toBe(true);
  });
});

describe("episodeMovementScore", () => {
  const step = (vals: number[][]) => episodeMovementScore(vals, vals[0].length);

  test("clean episode matches the plain per-frame mean of ‖Δa‖", () => {
    // Δ = (3,4) each pair -> ‖Δ‖ = 5 per pair
    expect(
      step([
        [0, 0],
        [3, 4],
        [6, 8],
      ]),
    ).toBeCloseTo(5, 4);
  });

  test("a NaN dimension is excluded from that pair, not zeroed", () => {
    // Pair 1: only dim 1 finite (Δ=4) -> 4. Pair 2 clean -> 5. Mean 4.5.
    // Zero-substitution (the old `?? 0`) would have invented a huge Δ from the NaN dim.
    expect(
      step([
        [NaN, 0],
        [3, 4],
        [6, 8],
      ]),
    ).toBeCloseTo(4.5, 4);
  });

  test("a pair with nothing finite is skipped, not averaged as zero motion", () => {
    // Pairs touching the all-NaN frame are skipped; only (0,0)->(3,4) counts -> 5, not 5/3.
    expect(
      step([
        [0, 0],
        [NaN, NaN],
        [0, 0],
        [3, 4],
      ]),
    ).toBeCloseTo(5, 4);
  });

  test("an episode with no measurable pair returns NaN so callers can exclude it", () => {
    expect(
      Number.isNaN(
        step([
          [NaN, NaN],
          [NaN, NaN],
        ]),
      ),
    ).toBe(true);
  });

  test("short episodes keep the existing 0 contract", () => {
    expect(episodeMovementScore([[1, 2]], 2)).toBe(0);
    expect(episodeMovementScore([], 2)).toBe(0);
  });
});

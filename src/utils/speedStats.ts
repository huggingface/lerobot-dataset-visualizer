/**
 * NaN-safe statistics for the Action Insights speed sections.
 *
 * WHY: datasets with partial tracking (common for real-world captures — marker-based
 * UMI rigs, mocap dropouts, SLAM losses) carry NaN in some action frames. `??` does not
 * catch NaN, so one NaN frame made an episode's movement score NaN; one NaN score made
 * mean/std/median NaN — and then `NaN > 0` is `false`, so the CV guard fell through to
 * `0` and the Speed Variance verdict rendered a green "Consistent" computed from no data
 * at all. A false pass is worse than a blank: the more NaN in the dataset, the more
 * confidently the panel said everything was fine.
 */

export type SpeedVarianceStats = {
  /** Finite speeds, ascending. */
  speeds: number[];
  /** Entries excluded because their speed was not finite (NaN/±Infinity). */
  dropped: number;
  mean: number;
  std: number;
  cv: number;
  median: number;
};

/** Mean/std/CV/median over the FINITE entries only, reporting how many were dropped. */
export function speedVarianceStats(raw: number[]): SpeedVarianceStats {
  const speeds = raw.filter(Number.isFinite).sort((a, b) => a - b);
  const dropped = raw.length - speeds.length;
  if (speeds.length === 0) {
    return { speeds, dropped, mean: NaN, std: NaN, cv: NaN, median: NaN };
  }
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const std = Math.sqrt(
    speeds.reduce((a, v) => a + (v - mean) ** 2, 0) / speeds.length,
  );
  const cv = mean > 0 ? std / mean : 0;
  const median = speeds[Math.floor(speeds.length / 2)];
  return { speeds, dropped, mean, std, cv, median };
}

/**
 * Per-episode average movement (mean ‖Δa‖ per frame) over the frame pairs and
 * dimensions that are actually finite.
 *
 * A non-finite value in either frame of a pair excludes that DIMENSION from the pair's
 * norm (a missing reading is not a zero-length motion); a pair with no finite dimension
 * is skipped entirely. Returns NaN when nothing at all was measurable — the caller can
 * then exclude the episode rather than average in an invented number.
 */
export function episodeMovementScore(
  ep: number[][],
  actionDim: number,
): number {
  if (ep.length < 2) return 0;
  let total = 0;
  let pairsUsed = 0;
  for (let t = 1; t < ep.length; t++) {
    let sumSq = 0;
    let dimsUsed = 0;
    for (let d = 0; d < actionDim; d++) {
      const a = ep[t][d];
      const b = ep[t - 1][d];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const delta = a - b;
      sumSq += delta * delta;
      dimsUsed++;
    }
    if (dimsUsed === 0) continue;
    total += Math.sqrt(sumSq);
    pairsUsed++;
  }
  if (pairsUsed === 0) return NaN;
  return Math.round((total / pairsUsed) * 10000) / 10000;
}

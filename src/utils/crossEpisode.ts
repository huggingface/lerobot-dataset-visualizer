/**
 * Statistics across a sample of episodes, for the Action Insights and Filtering tabs: which
 * episodes to read, and what is computed from them. Nothing here fetches; the loader in
 * fetch-data.ts reads the episodes and hands them over as flat typed arrays.
 */
import { CHART_CONFIG } from "@/utils/constants";

export type LowMovementEpisode = {
  episodeIndex: number;
  totalMovement: number;
};

export type AggVelocityStat = {
  name: string;
  std: number; // normalized by motor range
  maxAbs: number; // normalized by motor range
  bins: number[];
  lo: number; // normalized by motor range
  hi: number; // normalized by motor range
  motorRange: number;
  inactive?: boolean; // true if p95(|Δa|) < 0.1% of motor range in every episode
  discrete?: boolean; // true if motor has very few unique values (e.g. open/close gripper)
};

export type AggAutocorrelation = {
  chartData: Record<string, number>[];
  suggestedChunk: number | null;
  shortKeys: string[];
};

export type SpeedDistEntry = {
  episodeIndex: number;
  speed: number;
};

export type AggAlignment = {
  ccData: { lag: number; max: number; mean: number; min: number }[];
  meanPeakLag: number;
  meanPeakCorr: number;
  maxPeakLag: number;
  maxPeakCorr: number;
  minPeakLag: number;
  minPeakCorr: number;
  lagRangeMin: number;
  lagRangeMax: number;
  numPairs: number;
};

export type JerkyEpisode = {
  episodeIndex: number;
  meanAbsDelta: number;
};

export type CrossEpisodeVarianceData = {
  actionNames: string[];
  timeBins: number[];
  variance: number[][];
  numEpisodes: number;
  lowMovementEpisodes: LowMovementEpisode[];
  aggVelocity: AggVelocityStat[];
  aggAutocorrelation: AggAutocorrelation | null;
  speedDistribution: SpeedDistEntry[];
  jerkyEpisodes: JerkyEpisode[];
  aggAlignment: AggAlignment | null;
};

/** One sampled episode, every frame of it. */
export type EpisodeSeries = {
  index: number;
  /** Frames in the episode. */
  length: number;
  /** Row-major: frame `t`, dimension `d` at `[t * actionDim + d]`. */
  actions: Float32Array;
  /** Same layout with `stateDim`; null when the episode has no usable state. */
  states: Float32Array | null;
};

const DISCRETE_THRESHOLD = 4; // ≤ this many unique values → discrete motor
const ACTIVITY_THRESHOLD = 0.001; // 0.1% of motor range
const VELOCITY_BINS = 30;
const MAX_ACF_LAG = 100;
const ALIGNMENT_MAX_LAG = 30;
/**
 * Frames of one episode that the lag statistics (autocorrelation, alignment) run over. They cost
 * frames × lags × dimensions, so a longer episode contributes this many consecutive frames from
 * its middle: plenty for lags of up to 100 steps. Consecutive, not every n-th: a lag or a
 * frame-to-frame change measured across skipped frames is no longer in frames, which is what
 * subsampling long episodes used to do to these numbers.
 */
export const LAG_WINDOW_FRAMES = 1000;

function shortName(key: string): string {
  const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
  return parts.length > 1 ? parts[parts.length - 1] : key;
}

function evenIndices(length: number, count: number): number[] {
  if (count >= length) return Array.from({ length }, (_, i) => i);
  if (count <= 1) return length > 0 ? [0] : [];
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) {
    picked.add(Math.round((i * (length - 1)) / (count - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

export type SampleCandidate = {
  /** The data file holding the episode. */
  file: string;
  /** Row offsets inside that file; `toRow` is exclusive. */
  fromRow: number;
  toRow: number;
};

/**
 * Picks the episodes the analysis reads: at most `maxEpisodes`, spread over the dataset, from files
 * that together hold at most `rowBudget` rows.
 *
 * A v3.0 data file is read a whole row group at a time, so an episode costs its file, not its own
 * rows. Spreading 120 episodes evenly over a dataset of 100 files used to download all 100. Here the
 * files are chosen first (evenly spaced, as many as the budget allows) and the episodes are drawn
 * from those, so the download is bounded whatever the dataset's size.
 */
export function planEpisodeSample<T extends SampleCandidate>(
  episodes: T[],
  maxEpisodes: number,
  rowBudget: number,
): T[] {
  const files = new Map<string, { episodes: T[]; rows: number }>();
  for (const episode of episodes) {
    let file = files.get(episode.file);
    if (!file) files.set(episode.file, (file = { episodes: [], rows: 0 }));
    file.episodes.push(episode);
    file.rows = Math.max(file.rows, episode.toRow);
  }
  const all = [...files.values()];
  const rowsOf = (indices: number[]) =>
    indices.reduce((sum, i) => sum + all[i].rows, 0);

  // As many evenly spaced files as fit the budget; never fewer than one.
  let chosen = evenIndices(all.length, Math.min(all.length, maxEpisodes));
  while (chosen.length > 1 && rowsOf(chosen) > rowBudget) {
    chosen = evenIndices(all.length, chosen.length - 1);
  }
  // One file holding a single episode is not a sample: the analysis compares episodes.
  if (
    chosen.length === 1 &&
    all.length > 1 &&
    all[chosen[0]].episodes.length < 2
  ) {
    chosen = evenIndices(all.length, 2);
  }

  const sample: T[] = [];
  chosen.forEach((fileIndex, position) => {
    const file = all[fileIndex];
    // The episode quota is shared out over the files still to come, so one short file's unused
    // share goes to the later ones.
    const quota = Math.ceil(
      (maxEpisodes - sample.length) / (chosen.length - position),
    );
    for (const i of evenIndices(file.episodes.length, quota)) {
      sample.push(file.episodes[i]);
    }
  });
  return sample;
}

/** The consecutive frames `[start, end)` of an episode that the lag statistics use. */
function lagWindow(length: number): [number, number] {
  if (length <= LAG_WINDOW_FRAMES) return [0, length];
  const start = Math.floor((length - LAG_WINDOW_FRAMES) / 2);
  return [start, start + LAG_WINDOW_FRAMES];
}

function median(sorted: number[]): number {
  return sorted[Math.floor(sorted.length / 2)];
}

export type CrossEpisodeInput = {
  episodes: EpisodeSeries[];
  actionDim: number;
  stateDim: number;
  /** One per action dimension, `feature | name`. */
  actionNames: string[];
  /** One per state dimension, the bare name. */
  stateNames: string[];
  fps: number;
  numTimeBins?: number;
};

/** What the lag statistics need from the first pass. */
type Activity = {
  /** `[e * actionDim + d]`: 1 where dimension d moves in episode e. */
  active: Uint8Array;
  /** The consecutive frames of each episode that the lag statistics use. */
  windows: [number, number][];
};

type BaseStats = Omit<
  CrossEpisodeVarianceData,
  "aggAutocorrelation" | "aggAlignment"
>;

/** Everything but the lag statistics: one pass each over the frames. */
function baseStats(input: CrossEpisodeInput): {
  stats: BaseStats;
  activity: Activity;
} {
  const { episodes, actionDim: D, actionNames } = input;
  const numTimeBins = input.numTimeBins ?? 50;
  const E = episodes.length;

  // ── Variance of each dimension across episodes, at matching points of episode progress ──
  const timeBins = Array.from(
    { length: numTimeBins },
    (_, i) => i / (numTimeBins - 1),
  );
  const sums = new Float64Array(numTimeBins * D);
  const sumsSq = new Float64Array(numTimeBins * D);
  for (const { actions, length: T } of episodes) {
    for (let b = 0; b < numTimeBins; b++) {
      const src = Math.min(Math.round(timeBins[b] * (T - 1)), T - 1) * D;
      const out = b * D;
      for (let d = 0; d < D; d++) {
        const v = actions[src + d];
        sums[out + d] += v;
        sumsSq[out + d] += v * v;
      }
    }
  }
  const variance: number[][] = [];
  for (let b = 0; b < numTimeBins; b++) {
    const row: number[] = [];
    for (let d = 0; d < D; d++) {
      const mean = sums[b * D + d] / E;
      // Rounding can leave a constant dimension a hair below zero.
      row.push(Math.max(0, sumsSq[b * D + d] / E - mean * mean));
    }
    variance.push(row);
  }

  // ── Movement per episode: mean L2 norm of the frame-to-frame action change ──
  const movementScores: LowMovementEpisode[] = episodes.map(
    ({ index, actions, length: T }) => {
      if (T < 2) return { episodeIndex: index, totalMovement: 0 };
      let total = 0;
      for (let t = 1; t < T; t++) {
        let sumSq = 0;
        for (let d = 0; d < D; d++) {
          const delta = actions[t * D + d] - actions[(t - 1) * D + d];
          sumSq += delta * delta;
        }
        total += Math.sqrt(sumSq);
      }
      return {
        episodeIndex: index,
        totalMovement: Math.round((total / (T - 1)) * 10000) / 10000,
      };
    },
  );
  movementScores.sort((a, b) => a.totalMovement - b.totalMovement);

  // ── Per dimension: range over the whole sample, and whether it only takes a few values ──
  const lo = new Float64Array(D).fill(Infinity);
  const hi = new Float64Array(D).fill(-Infinity);
  const uniques = Array.from({ length: D }, () => new Set<number>());
  for (const { actions, length: T } of episodes) {
    for (let t = 0; t < T; t++) {
      for (let d = 0; d < D; d++) {
        const v = actions[t * D + d];
        if (v < lo[d]) lo[d] = v;
        if (v > hi[d]) hi[d] = v;
        if (uniques[d].size <= DISCRETE_THRESHOLD) uniques[d].add(v);
      }
    }
  }
  const motorRanges = new Float64Array(D);
  for (let d = 0; d < D; d++) motorRanges[d] = hi[d] - lo[d] || 1;

  // ── Is dimension d moving in episode e? p95(|Δa|) against 0.1% of its range ──
  const active = new Uint8Array(E * D);
  for (let e = 0; e < E; e++) {
    const { actions, length: T } = episodes[e];
    if (T < 2) continue;
    const absDeltas = new Float64Array(T - 1);
    for (let d = 0; d < D; d++) {
      for (let t = 1; t < T; t++) {
        absDeltas[t - 1] = Math.abs(
          actions[t * D + d] - actions[(t - 1) * D + d],
        );
      }
      absDeltas.sort();
      const p95 = absDeltas[Math.floor(absDeltas.length * 0.95)];
      if (p95 >= motorRanges[d] * ACTIVITY_THRESHOLD) active[e * D + d] = 1;
    }
  }
  const globallyActive = new Uint8Array(D);
  for (let e = 0; e < E; e++) {
    for (let d = 0; d < D; d++) if (active[e * D + d]) globallyActive[d] = 1;
  }

  // ── Velocity: the distribution of Δa per dimension, pooled over the episodes where it moves ──
  const aggVelocity: AggVelocityStat[] = [];
  for (let d = 0; d < D; d++) {
    const motorRange = motorRanges[d];
    const base = {
      name: shortName(actionNames[d]),
      motorRange,
      inactive: !globallyActive[d],
      discrete: uniques[d].size <= DISCRETE_THRESHOLD,
    };
    // A dimension that never moves has no "active" episodes: describe all of them instead.
    const counts = (e: number) => !globallyActive[d] || active[e * D + d] === 1;

    let count = 0;
    let sum = 0;
    let maxAbsRaw = 0;
    let loRaw = Infinity;
    let hiRaw = -Infinity;
    for (let e = 0; e < E; e++) {
      if (!counts(e)) continue;
      const { actions, length: T } = episodes[e];
      for (let t = 1; t < T; t++) {
        const v = actions[t * D + d] - actions[(t - 1) * D + d];
        count++;
        sum += v;
        const a = Math.abs(v);
        if (a > maxAbsRaw) maxAbsRaw = a;
        if (v < loRaw) loRaw = v;
        if (v > hiRaw) hiRaw = v;
      }
    }
    if (count === 0) {
      aggVelocity.push({
        ...base,
        std: 0,
        maxAbs: 0,
        bins: new Array(VELOCITY_BINS).fill(0),
        lo: 0,
        hi: 0,
      });
      continue;
    }
    const mean = sum / count;
    const loNorm = loRaw / motorRange;
    const hiNorm = hiRaw / motorRange;
    const binW = (hiNorm - loNorm || 1) / VELOCITY_BINS;
    const bins = new Array(VELOCITY_BINS).fill(0);
    let varSum = 0;
    for (let e = 0; e < E; e++) {
      if (!counts(e)) continue;
      const { actions, length: T } = episodes[e];
      for (let t = 1; t < T; t++) {
        const v = actions[t * D + d] - actions[(t - 1) * D + d];
        varSum += (v - mean) ** 2;
        let b = Math.floor((v / motorRange - loNorm) / binW);
        if (b >= VELOCITY_BINS) b = VELOCITY_BINS - 1;
        bins[b]++;
      }
    }
    aggVelocity.push({
      ...base,
      std: Math.sqrt(varSum / count) / motorRange,
      maxAbs: maxAbsRaw / motorRange,
      bins,
      lo: loNorm,
      hi: hiNorm,
    });
  }

  // ── Jerkiness per episode: mean |Δa| over its moving dimensions, in units of motor range ──
  const jerkyEpisodes: JerkyEpisode[] = episodes
    .map(({ index, actions, length: T }, e) => {
      let sum = 0;
      let count = 0;
      for (let d = 0; d < D; d++) {
        if (!active[e * D + d]) continue;
        for (let t = 1; t < T; t++) {
          sum +=
            Math.abs(actions[t * D + d] - actions[(t - 1) * D + d]) /
            motorRanges[d];
          count++;
        }
      }
      return { episodeIndex: index, meanAbsDelta: count > 0 ? sum / count : 0 };
    })
    .sort((a, b) => b.meanAbsDelta - a.meanAbsDelta);

  return {
    stats: {
      actionNames,
      timeBins,
      variance,
      numEpisodes: E,
      lowMovementEpisodes: movementScores.slice(0, 10),
      aggVelocity,
      speedDistribution: movementScores.map((s) => ({
        episodeIndex: s.episodeIndex,
        speed: s.totalMovement,
      })),
      jerkyEpisodes,
    },
    activity: {
      active,
      windows: episodes.map(({ length }) => lagWindow(length)),
    },
  };
}

/** Autocorrelation per dimension, averaged over the episodes where it moves. */
function autocorrelation(
  input: CrossEpisodeInput,
  { active, windows }: Activity,
): AggAutocorrelation | null {
  const { episodes, actionDim: D, actionNames, fps } = input;
  const E = episodes.length;
  // The horizon follows the typical episode, not the shortest: one aborted recording used to
  // cut the chart short for the whole dataset. Episodes too short for it are left out.
  const spans = windows.map(([from, to]) => to - from).sort((a, b) => a - b);
  const maxLag = Math.min(MAX_ACF_LAG, Math.floor(median(spans) / 2));
  if (maxLag < 2) return null;

  const acf = new Float64Array(D * maxLag);
  const used = new Uint32Array(D);
  for (let e = 0; e < E; e++) {
    const [from, to] = windows[e];
    const n = to - from;
    if (n < maxLag * 2) continue;
    const { actions } = episodes[e];
    const centered = new Float64Array(n);
    for (let d = 0; d < D; d++) {
      // A motor at rest is noise around a constant: it decorrelates at once, and would drag
      // both the average and the suggested chunk length down.
      if (!active[e * D + d]) continue;
      let mean = 0;
      for (let t = 0; t < n; t++) mean += actions[(from + t) * D + d];
      mean /= n;
      let vari = 0;
      for (let t = 0; t < n; t++) {
        const c = actions[(from + t) * D + d] - mean;
        centered[t] = c;
        vari += c * c;
      }
      if (vari === 0) continue;
      for (let lag = 1; lag <= maxLag; lag++) {
        let s = 0;
        for (let t = 0; t < n - lag; t++) s += centered[t] * centered[t + lag];
        acf[d * maxLag + lag - 1] += s / vari;
      }
      used[d]++;
    }
  }

  const dims: number[] = [];
  for (let d = 0; d < D; d++) if (used[d] > 0) dims.push(d);
  if (dims.length === 0) return null;
  for (const d of dims) {
    for (let l = 0; l < maxLag; l++) acf[d * maxLag + l] /= used[d];
  }

  const shortKeys = dims.map((d) => shortName(actionNames[d]));
  const chartData = Array.from({ length: maxLag }, (_, lag) => {
    const row: Record<string, number> = {
      lag: lag + 1,
      time: (lag + 1) / fps,
    };
    dims.forEach((d, i) => {
      row[shortKeys[i]] = acf[d * maxLag + lag];
    });
    return row;
  });

  // Suggested chunk: the median, over dimensions, of the first lag where the ACF is below 0.5.
  const crossings: number[] = [];
  for (const d of dims) {
    for (let l = 0; l < maxLag; l++) {
      if (acf[d * maxLag + l] < 0.5) {
        crossings.push(l + 1);
        break;
      }
    }
  }
  crossings.sort((a, b) => a - b);
  return {
    chartData,
    suggestedChunk: crossings.length > 0 ? median(crossings) : null,
    shortKeys,
  };
}

/** State–action alignment: cross-correlation of Δaction(t) and Δstate(t + lag). */
function alignment(
  input: CrossEpisodeInput,
  { windows }: Activity,
): AggAlignment | null {
  const { episodes, actionDim: D, stateDim, actionNames, stateNames } = input;
  const E = episodes.length;
  if (stateDim === 0) return null;

  // Pair each action with the state of the same name, else by position.
  const pairs: [number, number][] = [];
  for (let ai = 0; ai < D; ai++) {
    const si = stateNames.indexOf(shortName(actionNames[ai]));
    if (si >= 0) pairs.push([ai, si]);
  }
  if (pairs.length === 0) {
    const count = Math.min(D, stateDim);
    for (let i = 0; i < count; i++) pairs.push([i, i]);
  }
  if (pairs.length === 0) return null;

  const maxLag = ALIGNMENT_MAX_LAG;
  const numLags = 2 * maxLag + 1;
  const corrSums = new Float64Array(pairs.length * numLags);
  const corrCounts = new Uint32Array(pairs.length * numLags);

  for (let e = 0; e < E; e++) {
    const { actions, states } = episodes[e];
    if (!states) continue;
    const [from, to] = windows[e];
    const n = to - from;
    if (n < 10) continue;
    const effN = n - 1;
    // Centered changes, and running sums of their squares: a lag's variances are then two
    // subtractions, which leaves one multiply-add per frame in the loop that dominates.
    const aCentered = new Float64Array(effN);
    const sCentered = new Float64Array(effN);
    const aSquares = new Float64Array(effN + 1);
    const sSquares = new Float64Array(effN + 1);

    for (let p = 0; p < pairs.length; p++) {
      const [ai, si] = pairs[p];
      let aMean = 0;
      let sMean = 0;
      for (let t = 0; t < effN; t++) {
        const row = from + t;
        aCentered[t] = actions[(row + 1) * D + ai] - actions[row * D + ai];
        sCentered[t] =
          states[(row + 1) * stateDim + si] - states[row * stateDim + si];
        aMean += aCentered[t];
        sMean += sCentered[t];
      }
      aMean /= effN;
      sMean /= effN;
      for (let t = 0; t < effN; t++) {
        aCentered[t] -= aMean;
        sCentered[t] -= sMean;
        aSquares[t + 1] = aSquares[t] + aCentered[t] * aCentered[t];
        sSquares[t + 1] = sSquares[t] + sCentered[t] * sCentered[t];
      }

      for (let li = 0; li < numLags; li++) {
        const lag = li - maxLag;
        // Frames t where both Δaction(t) and Δstate(t + lag) exist.
        const tFrom = Math.max(0, -lag);
        const tTo = Math.min(effN, effN - lag);
        if (tTo <= tFrom) continue;
        let sum = 0;
        for (let t = tFrom; t < tTo; t++) {
          sum += aCentered[t] * sCentered[t + lag];
        }
        const aVar = aSquares[tTo] - aSquares[tFrom];
        const sVar = sSquares[tTo + lag] - sSquares[tFrom + lag];
        const denom = Math.sqrt(aVar * sVar);
        if (denom > 0) {
          corrSums[p * numLags + li] += sum / denom;
          corrCounts[p * numLags + li]++;
        }
      }
    }
  }

  // A pair that never moved (a motor at rest in every episode) has no correlation to report;
  // counted as a flat zero it would pull the mean and the minimum toward zero.
  const avgCorrs: number[][] = [];
  for (let p = 0; p < pairs.length; p++) {
    const row: number[] = [];
    let any = false;
    for (let li = 0; li < numLags; li++) {
      const c = corrCounts[p * numLags + li];
      if (c > 0) any = true;
      row.push(c > 0 ? corrSums[p * numLags + li] / c : 0);
    }
    if (any) avgCorrs.push(row);
  }
  if (avgCorrs.length === 0) return null;

  const ccData = Array.from({ length: numLags }, (_, li) => {
    const vals = avgCorrs.map((pc) => pc[li]);
    return {
      lag: li - maxLag,
      max: Math.max(...vals),
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      min: Math.min(...vals),
    };
  });

  const peak = (key: "max" | "mean" | "min") => {
    let best = ccData[0];
    for (const row of ccData) if (row[key] > best[key]) best = row;
    return { lag: best.lag, corr: best[key] };
  };
  const maxPeak = peak("max");
  const meanPeak = peak("mean");
  const minPeak = peak("min");

  const perPairPeakLags = avgCorrs.map((pc) => {
    let bestLag = 0;
    let best = -Infinity;
    for (let li = 0; li < pc.length; li++) {
      if (pc[li] > best) {
        best = pc[li];
        bestLag = li - maxLag;
      }
    }
    return bestLag;
  });

  return {
    ccData,
    meanPeakLag: meanPeak.lag,
    meanPeakCorr: meanPeak.corr,
    maxPeakLag: maxPeak.lag,
    maxPeakCorr: maxPeak.corr,
    minPeakLag: minPeak.lag,
    minPeakCorr: minPeak.corr,
    lagRangeMin: Math.min(...perPairPeakLags),
    lagRangeMax: Math.max(...perPairPeakLags),
    numPairs: avgCorrs.length,
  };
}

export function computeCrossEpisodeStats(
  input: CrossEpisodeInput,
): CrossEpisodeVarianceData | null {
  if (input.episodes.length < 2 || input.actionDim === 0) return null;
  const { stats, activity } = baseStats(input);
  return {
    ...stats,
    aggAutocorrelation: autocorrelation(input, activity),
    aggAlignment: alignment(input, activity),
  };
}

/**
 * The same statistics with a pause between the three stages. Each is a tight loop of tens to
 * hundreds of milliseconds; run back to back on the main thread they freeze the page for their sum.
 */
export async function computeCrossEpisodeStatsInSteps(
  input: CrossEpisodeInput,
  pause: () => Promise<void>,
): Promise<CrossEpisodeVarianceData | null> {
  if (input.episodes.length < 2 || input.actionDim === 0) return null;
  const { stats, activity } = baseStats(input);
  await pause();
  const aggAutocorrelation = autocorrelation(input, activity);
  await pause();
  return {
    ...stats,
    aggAutocorrelation,
    aggAlignment: alignment(input, activity),
  };
}

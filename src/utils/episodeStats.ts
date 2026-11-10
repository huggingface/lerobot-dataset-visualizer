/**
 * What the episode index says about a dataset as a whole: how long its episodes are, how those
 * lengths are distributed, and how the episodes split over tasks. Nothing here fetches.
 */

export type EpisodeLengthInfo = {
  episodeIndex: number;
  lengthSeconds: number;
  frames: number;
};

export type LengthBin = {
  binLabel: string;
  count: number;
  /** Seconds. The first bin also holds anything shorter than `lo`, the last anything longer than `hi`. */
  lo: number;
  hi: number;
};

export type TaskCount = {
  task: string;
  episodes: number;
  frames: number;
};

export type EpisodeLengthStats = {
  shortestEpisodes: EpisodeLengthInfo[];
  longestEpisodes: EpisodeLengthInfo[];
  allEpisodeLengths: EpisodeLengthInfo[];
  meanEpisodeLength: number;
  medianEpisodeLength: number;
  stdEpisodeLength: number;
  episodeLengthHistogram: LengthBin[];
  /** Episodes and frames per task, most episodes first. Empty when the index names no task. */
  tasks: TaskCount[];
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Bins for a histogram of episode lengths. The range follows the 1st to 99th percentile, so one
 * extreme episode does not flatten everything else into a single bar; the outliers land in the
 * first and last bins. Bin edges are round numbers.
 */
function lengthHistogram(lengths: number[], sorted: number[]): LengthBin[] {
  const histMin = sorted[0];
  const histMax = sorted[sorted.length - 1];
  if (histMax === histMin) {
    return [
      {
        binLabel: `${histMin.toFixed(1)}s`,
        count: lengths.length,
        lo: histMin,
        hi: histMin,
      },
    ];
  }

  const p1 = sorted[Math.floor(sorted.length * 0.01)];
  const p99 = sorted[Math.ceil(sorted.length * 0.99) - 1];
  const range = p99 - p1 || 1;

  const targetBins = Math.max(
    10,
    Math.min(50, Math.ceil(Math.log2(lengths.length) + 1)),
  );
  const rawBinWidth = range / targetBins;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawBinWidth)));
  const niceBinWidth =
    [1, 2, 2.5, 5, 10]
      .map((s) => s * magnitude)
      .find((w) => w >= rawBinWidth) ?? rawBinWidth;

  const niceMin = Math.floor(p1 / niceBinWidth) * niceBinWidth;
  const niceMax = Math.ceil(p99 / niceBinWidth) * niceBinWidth;
  const binCount = Math.max(1, Math.round((niceMax - niceMin) / niceBinWidth));
  const counts = Array.from({ length: binCount }, () => 0);
  for (const length of lengths) {
    counts[binIndex(length, niceMin, niceBinWidth, binCount)]++;
  }

  return counts.map((count, i) => {
    const lo = niceMin + i * niceBinWidth;
    const hi = lo + niceBinWidth;
    return { binLabel: `${lo.toFixed(1)}–${hi.toFixed(1)}s`, count, lo, hi };
  });
}

function binIndex(
  length: number,
  min: number,
  width: number,
  count: number,
): number {
  const index = Math.floor((length - min) / width);
  return Math.max(0, Math.min(count - 1, index));
}

/** The episodes counted in bin `index` of `bins`, shortest first. */
export function episodesInBin(
  episodes: EpisodeLengthInfo[],
  bins: LengthBin[],
  index: number,
): EpisodeLengthInfo[] {
  if (bins.length === 0) return [];
  const { lo, hi } = bins[0];
  const inBin =
    hi === lo
      ? episodes
      : episodes.filter(
          (e) => binIndex(e.lengthSeconds, lo, hi - lo, bins.length) === index,
        );
  return [...inBin].sort(
    (a, b) =>
      a.lengthSeconds - b.lengthSeconds || a.episodeIndex - b.episodeIndex,
  );
}

export function summarizeEpisodes(
  episodes: { index: number; length: number; tasks?: string[] }[],
  fps: number,
): EpisodeLengthStats | null {
  if (episodes.length === 0) return null;

  const withSeconds: EpisodeLengthInfo[] = episodes.map((ep) => ({
    episodeIndex: ep.index,
    frames: ep.length,
    lengthSeconds: round2(ep.length / fps),
  }));

  const sortedByLength = [...withSeconds].sort(
    (a, b) => a.lengthSeconds - b.lengthSeconds,
  );
  const lengths = withSeconds.map((e) => e.lengthSeconds);
  const sorted = sortedByLength.map((e) => e.lengthSeconds);

  const mean = round2(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? round2((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  const variance =
    lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length;

  // An episode recorded for several tasks counts under each of them.
  const byTask = new Map<string, TaskCount>();
  for (const episode of episodes) {
    for (const task of episode.tasks ?? []) {
      const entry = byTask.get(task) ?? { task, episodes: 0, frames: 0 };
      entry.episodes++;
      entry.frames += episode.length;
      byTask.set(task, entry);
    }
  }

  return {
    shortestEpisodes: sortedByLength.slice(0, 5),
    // Longest first.
    longestEpisodes: sortedByLength.slice(-5).reverse(),
    allEpisodeLengths: withSeconds,
    meanEpisodeLength: mean,
    medianEpisodeLength: median,
    stdEpisodeLength: round2(Math.sqrt(variance)),
    episodeLengthHistogram: lengthHistogram(lengths, sorted),
    tasks: [...byTask.values()].sort(
      (a, b) => b.episodes - a.episodes || a.task.localeCompare(b.task),
    ),
  };
}

/** One component of a vector feature, as `meta/stats.json` describes it. */
export type DimensionStats = {
  name: string;
  min: number;
  max: number;
  mean: number;
  std: number;
};

/**
 * Per-component statistics of a vector feature from its `meta/stats.json` entry, or null when the
 * entry is missing or is not one flat list per statistic (image features nest theirs by channel).
 */
export function dimensionStats(
  entry: unknown,
  names: string[] | null,
): DimensionStats[] | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const flat = (value: unknown): number[] | null =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
      ? (value as number[])
      : null;
  const min = flat(record.min);
  const max = flat(record.max);
  const mean = flat(record.mean);
  const std = flat(record.std);
  if (!min || !max || !mean || !std) return null;
  const dim = min.length;
  if (max.length !== dim || mean.length !== dim || std.length !== dim)
    return null;
  return min.map((_, i) => ({
    name: names && names.length === dim ? names[i] : `${i}`,
    min: min[i],
    max: max[i],
    mean: mean[i],
    std: std[i],
  }));
}

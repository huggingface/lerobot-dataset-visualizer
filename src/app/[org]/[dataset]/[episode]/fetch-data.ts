import {
  DatasetMetadata,
  fetchParquetFile,
  formatStringWithVars,
  nestedColumnValues,
  openParquetFile,
  readParquetAsObjects,
  readParquetColumnChunks,
} from "@/utils/parquetUtils";
import {
  computeCrossEpisodeStatsInSteps,
  planEpisodeSample,
  type CrossEpisodeVarianceData,
  type EpisodeSeries,
} from "@/utils/crossEpisode";
import { parquetMetadataAsync } from "hyparquet";
import { pick } from "@/utils/pick";
import {
  getDatasetVersionAndInfo,
  buildVersionedUrl,
  getDatasetStats,
} from "@/utils/versionUtils";
import { AsyncCache } from "@/utils/asyncCache";
import { CHART_CONFIG, EXCLUDED_COLUMNS } from "@/utils/constants";
import {
  processChartDataGroups,
  groupRowBySuffix,
} from "@/utils/dataProcessing";
import { bigIntToNumber } from "@/utils/typeGuards";
import {
  isGrayscaleShape,
  depthColormapRange,
  depthEncodingFromFeature,
} from "@/utils/colormaps";
import type { VideoInfo } from "@/types";
import {
  LeRobotDataset,
  HttpError,
  fetchRange,
  formatPathTemplate,
  parseInfo,
} from "@huggingface/lerobot";
import type { LeRobotEpisode, LeRobotFrames } from "@huggingface/lerobot";
import { authHeaders, getAuthToken } from "@/utils/auth";
import {
  hasHandTracking,
  handProjectionMetadata,
  isHandGeometryColumn,
  readHandTracking,
  type HandTracking,
} from "@/lib/hand-tracking";

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;

/** `DATASET_URL` points at `<endpoint>/datasets`; the package wants the endpoint. */
const HUB_ENDPOINT = (
  process.env.DATASET_URL || "https://huggingface.co/datasets"
).replace(/\/datasets\/?$/, "");

type RangeEntry =
  | { ok: true; body: ArrayBuffer; status: number; contentRange: string | null }
  | { ok: false; status: number; statusText: string };

const RANGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const rangeCache = new Map<string, Promise<RangeEntry>>();
/** Sizes of the settled entries in `rangeCache`; in-flight ones have none yet. */
const rangeSizes = new Map<string, number>();
let rangeCacheBytes = 0;

/**
 * Memoizes the package's range reads, least recently used out first past `RANGE_CACHE_MAX_BYTES`.
 * Every package call opens its files afresh, and a v3 file is a single row group with no page index,
 * so every episode in it requests byte-identical ranges. The browser cache never helps: the /resolve/
 * 302 is `no-store` and points at a URL that is signed anew each time.
 */
const rangeCachedFetch = (async (input, init) => {
  const headers = new Headers(init?.headers);
  const range = headers.get("range");
  if (!range) return fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  // The request's own token, not getAuthToken(): a dataset instance keeps the headers it was built with.
  const key = `${headers.get("authorization") ?? ""}\n${url}\n${range}`;
  let pending = rangeCache.get(key);
  if (pending) {
    rangeCache.delete(key);
    rangeCache.set(key, pending);
  } else {
    // Stored before it settles, so concurrent identical reads share one download.
    pending = fetch(input, init)
      .then(async (res): Promise<RangeEntry> => {
        if (!res.ok) {
          // Never cached: the package needs the 404 that ends its walk over the index shards.
          rangeCache.delete(key);
          return { ok: false, status: res.status, statusText: res.statusText };
        }
        const body = await res.arrayBuffer();
        if (body.byteLength > RANGE_CACHE_MAX_BYTES / 2) {
          rangeCache.delete(key);
        } else {
          rangeSizes.set(key, body.byteLength);
          rangeCacheBytes += body.byteLength;
          for (const k of rangeCache.keys()) {
            if (rangeCacheBytes <= RANGE_CACHE_MAX_BYTES) break;
            const size = rangeSizes.get(k);
            if (size === undefined) continue;
            rangeCache.delete(k);
            rangeSizes.delete(k);
            rangeCacheBytes -= size;
          }
        }
        return {
          ok: true,
          body,
          status: res.status,
          contentRange: res.headers.get("content-range"),
        };
      })
      .catch((err) => {
        rangeCache.delete(key);
        throw err;
      });
    rangeCache.set(key, pending);
  }
  const entry = await pending;
  if (!entry.ok) {
    return new Response(null, {
      status: entry.status,
      statusText: entry.statusText,
    });
  }
  // The package reads the file size from content-range.
  return new Response(entry.body, {
    status: entry.status,
    headers: entry.contentRange ? { "content-range": entry.contentRange } : {},
  });
}) as typeof fetch; // Bun's types add `fetch.preconnect`, which the package never calls.

const leRobotDatasets = new Map<string, LeRobotDataset>();

/**
 * One instance per repo and token: the package memoizes `info()` per instance, so building a new one
 * for every lookup refetched `meta/info.json` each time. Keyed on the token too, because the headers
 * are fixed at construction and signing in must take effect.
 */
function leRobotDataset(repoId: string): LeRobotDataset {
  const key = `${repoId}\n${getAuthToken() ?? ""}`;
  let dataset = leRobotDatasets.get(key);
  if (!dataset) {
    dataset = new LeRobotDataset(repoId, {
      endpoint: HUB_ENDPOINT,
      additionalFetchHeaders: authHeaders(),
      fetch: rangeCachedFetch,
    });
    leRobotDatasets.set(key, dataset);
  }
  return dataset;
}

/**
 * Locates a single episode: which video files hold it, where inside them, and which parquet rows
 * are its frames. `@huggingface/lerobot` normalizes the v2.x and v3.0 layouts behind one shape, and
 * reads the v3 index by row range instead of scanning every shard for a matching episode_index.
 */
async function loadLeRobotEpisode(
  repoId: string,
  episodeId: number,
): Promise<LeRobotEpisode> {
  const [episode] = await leRobotDataset(repoId).episodes({
    offset: episodeId,
    limit: 1,
  });
  if (!episode) {
    throw new Error(`Episode ${episodeId} not found in ${repoId}`);
  }
  return episode;
}

/**
 * v3.0 concatenates episodes into shared files, so each camera carries a time range; v2.x gives every
 * episode its own file and the range simply spans it.
 */
/** Every episode, normalized. v3 only: v2 needs no index read to locate an episode. */
async function loadLeRobotEpisodes(
  repoId: string,
  totalEpisodes: number,
): Promise<LeRobotEpisode[]> {
  const dataset = leRobotDataset(repoId);
  let listing = allEpisodes.get(dataset);
  if (!listing) {
    listing = dataset.episodes({ offset: 0, limit: totalEpisodes });
    const started = listing;
    // A failed listing is not kept, so the next tab that needs it tries again.
    started.catch(() => {
      if (allEpisodes.get(dataset) === started) allEpisodes.delete(dataset);
    });
    allEpisodes.set(dataset, listing);
  }
  return listing;
}

/**
 * The whole episode listing, per dataset instance (so per repo and token). Statistics, Frames and
 * the cross-episode analysis each need it; they used to read and decode the index once each.
 */
const allEpisodes = new WeakMap<LeRobotDataset, Promise<LeRobotEpisode[]>>();

/**
 * Dataset-wide results, kept across episode changes: none of them depends on the episode on screen.
 * Keyed by `datasetCacheKey`, which includes the token, since signing in can change what is readable.
 */
export const episodeLengthsCache = new AsyncCache<EpisodeLengthStats | null>(4);
export const episodeFramesCache = new AsyncCache<EpisodeFramesData>(4);
export const crossEpisodeCache =
  new AsyncCache<CrossEpisodeVarianceData | null>(4);

export function datasetCacheKey(repoId: string): string {
  return `${repoId}\n${getAuthToken() ?? ""}`;
}

function toVideosInfo(
  episode: LeRobotEpisode,
  info: DatasetMetadata,
  segmented: boolean,
): VideoInfo[] {
  return episode.videos.map((video) => ({
    filename: video.cameraKey,
    url: video.url,
    isGrayscale: isGrayscaleShape(info.features[video.cameraKey]?.shape ?? []),
    ...(segmented
      ? {
          isSegmented: true,
          segmentStart: video.fromSec,
          segmentEnd: video.toSec,
          segmentDuration: video.toSec - video.fromSec,
        }
      : {}),
  }));
}

/** Adapts the package's episode onto the shape the chart loader already consumes. */
function toEpisodeMetadataV3(episode: LeRobotEpisode): EpisodeMetadataV3 {
  const primary = episode.videos[0];
  return {
    episode_index: episode.index,
    data_chunk_index: 0,
    data_file_index: 0,
    /// Unused downstream: the package resolves the video URL itself.
    video_chunk_index: 0,
    video_file_index: 0,
    video_from_timestamp: primary?.fromSec ?? 0,
    video_to_timestamp: primary?.toSec ?? episode.durationSec,
    length: episode.length,
    tasks: episode.tasks,
  };
}

export type CameraInfo = { name: string; width: number; height: number };

export type DatasetDisplayInfo = {
  repoId: string;
  total_frames: number;
  total_episodes: number;
  fps: number;
  robot_type: string | null;
  codebase_version: string;
  total_tasks: number;
  cameras: CameraInfo[];
};

export type ChartRow = Record<string, number | Record<string, number>>;

export type ColumnMinMax = {
  column: string;
  min: number;
  max: number;
};

export type EpisodeLengthInfo = {
  episodeIndex: number;
  lengthSeconds: number;
  frames: number;
};

export type EpisodeLengthStats = {
  shortestEpisodes: EpisodeLengthInfo[];
  longestEpisodes: EpisodeLengthInfo[];
  allEpisodeLengths: EpisodeLengthInfo[];
  meanEpisodeLength: number;
  medianEpisodeLength: number;
  stdEpisodeLength: number;
  episodeLengthHistogram: { binLabel: string; count: number }[];
};

export type EpisodeFrameInfo = {
  episodeIndex: number;
  videoUrl: string;
  /** Seconds into `videoUrl`, half a frame past the episode's start: inside its first frame. */
  firstFrameTime: number;
  /** Inside the episode's last frame; null = half a frame before the file's end (v2.x). */
  lastFrameTime: number | null;
  /** Episode length in seconds, where the index gives it (v3.0). */
  durationSec?: number;
};

export type EpisodeFramesData = {
  cameras: string[];
  framesByCamera: Record<string, EpisodeFrameInfo[]>;
  /** Episodes in the dataset; more than are listed when the listing is sampled. */
  totalEpisodes: number;
  /** Half a frame, in seconds: how far before a file's end its last frame is sought. */
  halfFrameSec: number;
};

export type EpisodeData = {
  datasetInfo: DatasetDisplayInfo;
  episodeId: number;
  videosInfo: VideoInfo[];
  chartDataGroups: ChartRow[][];
  flatChartData: Record<string, number>[];
  episodes: number[];
  ignoredColumns: string[];
  duration: number;
  task?: string;
  /**
   * v3.1 language atoms read from `language_persistent` and `language_events`
   * (lerobot#3467). Empty when the dataset hasn't been annotated yet.
   * The annotations panel uses this to seed its editor state when no
   * annotation backend is running.
   */
  languageAtoms?: import("@/types/language.types").LanguageAtom[];
  /**
   * Sorted source-frame timestamps from the data parquet, in seconds. Used by
   * the annotations editor to snap atom timestamps to exact frame times —
   * avoiding sub-frame drift from a throttled `currentTime` and keeping
   * events compatible with the writer in lerobot#3471.
   */
  frameTimestamps?: number[];
  /** Full-resolution native hand geometry, independent of sampled chart rows. */
  handTracking?: HandTracking;
};

type EpisodeMetadataV3 = {
  episode_index: number;
  data_chunk_index: number;
  data_file_index: number;
  video_chunk_index: number;
  video_file_index: number;
  video_from_timestamp: number;
  video_to_timestamp: number;
  length: number;
  tasks?: string[];
  [key: string]: string | number | string[] | undefined;
};

function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
  min = 1,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const MAX_EPISODE_POINTS = parsePositiveIntEnv(
  process.env.MAX_EPISODE_POINTS,
  4000,
  100,
);
const MAX_FRAMES_OVERVIEW_EPISODES = parsePositiveIntEnv(
  process.env.MAX_FRAMES_OVERVIEW_EPISODES,
  3000,
  100,
);
const MAX_CROSS_EPISODE_SAMPLE = parsePositiveIntEnv(
  process.env.MAX_CROSS_EPISODE_SAMPLE,
  120,
  10,
);
/**
 * Action and state bytes the cross-episode analysis may read. A data file comes a whole row group
 * at a time, so this bounds how many files the sample is drawn from on a large dataset.
 */
const MAX_CROSS_EPISODE_BYTES = parsePositiveIntEnv(
  process.env.MAX_CROSS_EPISODE_BYTES,
  48 * 1024 * 1024,
  1024 * 1024,
);
const PROGRESS_PARQUET_CANDIDATES = [
  "sarm_progress.parquet",
  "srm_progress.parquet",
] as const;
/**
 * Progress files the Hub answered 404 for. With the range cache serving a same-file switch, probing
 * them again would be most of what the switch costs.
 */
const missingProgressFiles = new Set<string>();
const PREFERRED_PROGRESS_COLUMNS = [
  "progress_sparse",
  "progress_dense",
  "progress",
] as const;

function evenlySampleIndices(length: number, target: number): number[] {
  if (length <= 0) return [];
  if (target >= length) return Array.from({ length }, (_, i) => i);
  if (target <= 1) return [0];

  const sampled = new Set<number>();
  for (let i = 0; i < target; i++) {
    sampled.add(Math.round((i * (length - 1)) / (target - 1)));
  }

  // Fill potential gaps caused by rounding collisions.
  if (sampled.size < target) {
    for (let i = 0; i < length && sampled.size < target; i++) {
      sampled.add(i);
    }
  }

  return Array.from(sampled).sort((a, b) => a - b);
}

function evenlySampleArray<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  return evenlySampleIndices(items.length, maxCount).map((idx) => items[idx]);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildProgressSeriesKey(progressColumn: string): string {
  if (progressColumn === "progress_sparse") {
    return `progress${SERIES_NAME_DELIMITER}sparse`;
  }
  if (progressColumn === "progress_dense") {
    return `progress${SERIES_NAME_DELIMITER}dense`;
  }
  return "progress";
}

function pickProgressColumn(rows: Record<string, unknown>[]): string | null {
  if (rows.length === 0) return null;

  const columnNames = Object.keys(rows[0] ?? {});
  const preferred = PREFERRED_PROGRESS_COLUMNS.filter((column) =>
    columnNames.includes(column),
  );
  const preferredSet = new Set<string>(preferred);
  const additionalProgressColumns = columnNames
    .filter(
      (column) => column.startsWith("progress_") && !preferredSet.has(column),
    )
    .sort();
  const candidates = [...preferred, ...additionalProgressColumns];

  for (const column of candidates) {
    const hasFiniteValue = rows.some(
      (row) => toFiniteNumber(row[column]) !== null,
    );
    if (hasFiniteValue) {
      return column;
    }
  }

  return null;
}

// Returns a builder that, given the episode's final duration, produces the
// scaled progress chart group. Splitting "fetch the parquet" from "scale by
// duration" lets the caller kick off the fetch in parallel with the main
// episode-data fetch instead of waiting on a sequential await.
async function loadEpisodeProgressGroup(
  repoId: string,
  version: string,
  episodeId: number,
): Promise<((episodeDuration: number) => ChartRow[]) | null> {
  for (const progressPath of PROGRESS_PARQUET_CANDIDATES) {
    const progressUrl = buildVersionedUrl(repoId, version, progressPath);
    if (missingProgressFiles.has(progressUrl)) continue;
    try {
      const progressBuffer = await fetchParquetFile(progressUrl);
      const progressRows = await readParquetAsObjects(progressBuffer, []);
      if (progressRows.length === 0) continue;

      const hasEpisodeIndex = progressRows.some(
        (row) => toFiniteNumber(row["episode_index"]) !== null,
      );
      const targetRows = hasEpisodeIndex
        ? progressRows.filter(
            (row) => toFiniteNumber(row["episode_index"]) === episodeId,
          )
        : progressRows;
      if (targetRows.length === 0) continue;

      const progressColumn = pickProgressColumn(targetRows);
      if (!progressColumn) continue;

      const orderedPoints: Array<{ order: number; progress: number }> = [];
      for (let i = 0; i < targetRows.length; i++) {
        const row = targetRows[i];
        const progressValue = toFiniteNumber(row[progressColumn]);
        if (progressValue === null) continue;

        const order =
          toFiniteNumber(row["index"]) ??
          toFiniteNumber(row["frame_index"]) ??
          i;
        orderedPoints.push({ order, progress: progressValue });
      }

      if (orderedPoints.length === 0) continue;
      orderedPoints.sort((a, b) => a.order - b.order);

      const sampledPoints = evenlySampleArray(
        orderedPoints,
        MAX_EPISODE_POINTS,
      );
      const progressKey = buildProgressSeriesKey(progressColumn);
      const denominator = Math.max(sampledPoints.length - 1, 1);

      return (episodeDuration: number) => {
        const duration = Math.max(episodeDuration, 0);
        return sampledPoints.map((point, idx) => ({
          timestamp:
            sampledPoints.length === 1 ? 0 : (idx / denominator) * duration,
          [progressKey]: point.progress,
        }));
      };
    } catch (err) {
      // Optional file: ignore and try next candidate. hyparquet reports a missing file as
      // "fetch head failed 404"; any other failure is retried next time.
      if (err instanceof Error && /\b404$/.test(err.message)) {
        missingProgressFiles.add(progressUrl);
      }
    }
  }

  return null;
}

function buildSampledEpisodeSet(
  totalEpisodes: number,
  maxEpisodes: number,
): Set<number> | null {
  if (totalEpisodes <= maxEpisodes) return null;
  return new Set(evenlySampleIndices(totalEpisodes, maxEpisodes));
}

/** `meta/info.json` lists no episodes: the recording was pushed before any episode was saved. */
export class NoEpisodesError extends Error {}

export async function getEpisodeData(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<EpisodeData> {
  const repoId = `${org}/${dataset}`;
  try {
    // episodes() awaits the package's own meta/info.json read, which would otherwise start only after ours.
    // Forget the instance if that read fails, so the next load retries instead of reusing the memoized rejection.
    const leRobot = leRobotDataset(repoId);
    const forgetLeRobot = () => {
      for (const [key, cached] of leRobotDatasets) {
        if (cached === leRobot) leRobotDatasets.delete(key);
      }
    };
    void leRobot.info().catch(forgetLeRobot);

    console.time(`[perf] getDatasetVersionAndInfo`);
    const { version, info: rawInfo } = await getDatasetVersionAndInfo(repoId);
    console.timeEnd(`[perf] getDatasetVersionAndInfo`);
    const info = rawInfo as unknown as DatasetMetadata;

    if (info.total_episodes === 0) {
      // The package memoizes info() with no TTL: keeping it would pin totalEpisodes at 0 after episodes are pushed.
      forgetLeRobot();
      throw new NoEpisodesError(`${repoId} has no episodes`);
    }

    if (info.video_path === null) {
      throw new Error(
        "Only videos datasets are supported in this visualizer.\nPlease use Rerun visualizer for images datasets.",
      );
    }

    // Run the main episode-data fetch and the optional progress parquet
    // in parallel. Previously they ran serially: the progress fetch was
    // gated on result.duration even though it only used duration to scale
    // timestamps at the end. Now loadEpisodeProgressGroup returns a
    // builder we apply once both promises settle.
    // Vercel rule: async-parallel.
    // Only single-channel feeds are recolored, so only they need q10/q90 from
    // stats.json — skip the extra fetch entirely for ordinary RGB datasets.
    const hasGrayscaleFeed = Object.values(rawInfo.features).some(
      (f) => f.dtype === "video" && isGrayscaleShape(f.shape),
    );

    console.time(`[perf] getEpisodeData (${version})`);
    const [result, progressBuilder, stats] = await Promise.all([
      version === "v3.0"
        ? getEpisodeDataV3(repoId, version, info, episodeId)
        : getEpisodeDataV2(repoId, version, info, episodeId),
      loadEpisodeProgressGroup(repoId, version, episodeId),
      hasGrayscaleFeed ? getDatasetStats(repoId) : Promise.resolve(null),
    ]);
    console.timeEnd(`[perf] getEpisodeData (${version})`);

    // Stretch each grayscale feed's colormap to its q10/q90 band so outliers
    // don't wash out the visualization. Single-channel depth feeds map the
    // quantiles through their quantization params; plain grayscale feeds use
    // the already-normalized quantiles directly.
    if (stats) {
      for (const v of result.videosInfo) {
        if (!v.isGrayscale) continue;
        const encoding = depthEncodingFromFeature(rawInfo.features[v.filename]);
        const range = depthColormapRange(stats[v.filename], encoding);
        if (range) v.colormapRange = range;
      }
    }

    // The package reads sizes from video info first, so channel-first shapes ([3, H, W]) resolve too.
    const cameras: CameraInfo[] = parseInfo(
      JSON.stringify(rawInfo),
    ).cameras.map(({ key, width, height }) => ({ name: key, width, height }));

    result.datasetInfo = {
      ...result.datasetInfo,
      robot_type: rawInfo.robot_type ?? null,
      codebase_version: rawInfo.codebase_version,
      total_tasks: rawInfo.total_tasks ?? 0,
      cameras,
    };

    if (progressBuilder) {
      const progressGroup = progressBuilder(result.duration);
      if (progressGroup.length > 0) {
        result.chartDataGroups = [...result.chartDataGroups, progressGroup];
      }
    }

    return result;
  } catch (err) {
    if (!(err instanceof NoEpisodesError)) {
      console.error("Error loading episode data:", err);
    }
    throw err;
  }
}

const v2ContiguousIndexes = new Map<string, Promise<boolean>>();
/// The package's first 8 KB read of episodes.jsonl already holds the first few dozen episodes, so
/// probing for those would only add a round trip.
const V2_PROBE_FROM_EPISODE = 32;

/**
 * Whether line N of `meta/episodes.jsonl` is episode N, judged from its first and last lines.
 *
 * The package finds line N by re-downloading ever longer prefixes of the file (8 KB × 4^k) one
 * after another and gives up past 4 MB, so the upper episodes of a large v2 dataset could not open.
 * An index running 0..total-1 lets the episode be located from info.json instead; indexes that
 * start elsewhere (10, 20, 30, ... in behavior-1k) keep the package's lookup.
 */
function isV2IndexContiguous(
  repoId: string,
  totalEpisodes: number,
): Promise<boolean> {
  const url = leRobotDataset(repoId).fileUrl("meta/episodes.jsonl");
  let contiguous = v2ContiguousIndexes.get(url);
  if (!contiguous) {
    const read = (start: number, end?: number) =>
      fetchRange(url, start, end, {
        additionalFetchHeaders: authHeaders(),
      }).then(({ bytes }) => new TextDecoder().decode(bytes));
    const headRead = read(0, 4095);
    /// The Hub answers a suffix longer than the file with a 416; the head then holds all of it.
    const tailRead = read(-4096).catch((error) => {
      if (error instanceof HttpError && error.status === 416) return headRead;
      throw error;
    });
    contiguous = Promise.all([headRead, tailRead]).then(
      ([head, tail]) => {
        try {
          const first = JSON.parse(head.split("\n")[0]);
          const last = JSON.parse(tail.trimEnd().split("\n").pop() ?? "");
          return (
            first.episode_index === 0 &&
            last.episode_index === totalEpisodes - 1
          );
        } catch {
          /// A line longer than the 4 KB window: the answer would not change on a retry.
          return false;
        }
      },
      () => {
        v2ContiguousIndexes.delete(url);
        return false;
      },
    );
    v2ContiguousIndexes.set(url, contiguous);
  }
  return contiguous;
}

/**
 * Enough of the package's episode for getEpisodeDataV2, built from info.json alone. Only
 * `videos[].url` and `data` are filled in: `length`, `durationSec`, `tasks` and `toSec` stay empty,
 * since that path takes its duration from the chart timestamps.
 */
async function v2EpisodeFromTemplates(
  repoId: string,
  episodeId: number,
): Promise<LeRobotEpisode> {
  const dataset = leRobotDataset(repoId);
  const info = await dataset.info();
  /// The package's lookup keeps answering for ids that name no episode ("not found" past the end).
  if (
    !Number.isInteger(episodeId) ||
    episodeId < 0 ||
    episodeId >= info.totalEpisodes
  ) {
    return loadLeRobotEpisode(repoId, episodeId);
  }
  const { videoPath } = info;
  const vars = {
    episode_chunk: Math.floor(episodeId / info.chunksSize),
    episode_index: episodeId,
  };
  return {
    index: episodeId,
    length: 0,
    durationSec: 0,
    tasks: [],
    videos:
      videoPath === undefined
        ? []
        : info.cameras.map((camera) => ({
            cameraKey: camera.key,
            url: dataset.fileUrl(
              formatPathTemplate(videoPath, { ...vars, video_key: camera.key }),
            ),
            fromSec: 0,
            toSec: 0,
          })),
    data: {
      url: dataset.fileUrl(formatPathTemplate(info.dataPath, vars)),
      /// The file holds this one episode, and hyparquet stops at its last row.
      fromRow: 0,
      toRow: Number.MAX_SAFE_INTEGER,
    },
  };
}

// Legacy v2.x data loading
async function getEpisodeDataV2(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<EpisodeData> {
  const datasetInfo: DatasetDisplayInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
    robot_type: null,
    codebase_version: version,
    total_tasks: 0,
    cameras: [],
  };

  // Generate list of episodes
  const episodes =
    process.env.EPISODES === undefined
      ? Array.from(
          { length: datasetInfo.total_episodes },
          // episode id starts from 0
          (_, i) => i,
        )
      : process.env.EPISODES.split(/\s+/)
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !isNaN(x));

  /// Both ways of locating the episode need the package's info.json; fetch it alongside the probe.
  const probe =
    episodeId >= V2_PROBE_FROM_EPISODE ||
    v2ContiguousIndexes.has(
      leRobotDataset(repoId).fileUrl("meta/episodes.jsonl"),
    );
  const [contiguous] = await Promise.all([
    probe && isV2IndexContiguous(repoId, info.total_episodes),
    leRobotDataset(repoId).info(),
  ]);
  const leRobotEpisode = contiguous
    ? await v2EpisodeFromTemplates(repoId, episodeId)
    : await loadLeRobotEpisode(repoId, episodeId);
  const videosInfo =
    info.video_path !== null ? toVideosInfo(leRobotEpisode, info, false) : [];

  const { frames, textRows, handTracking } = await loadEpisodeFrames(
    repoId,
    leRobotEpisode,
    info,
  );
  const frameTimestamps = sortedTimestamps(frames);
  const languageAtoms = extractLanguageAtoms(textRows);

  // Extract task from language_instruction fields, task field, or tasks.jsonl
  let task: string | undefined;

  if (textRows.length > 0) {
    const firstRow = textRows[0];
    const languageInstructions: string[] = [];

    if (typeof firstRow.language_instruction === "string") {
      languageInstructions.push(firstRow.language_instruction);
    }

    let instructionNum = 2;
    while (
      typeof firstRow[`language_instruction_${instructionNum}`] === "string"
    ) {
      languageInstructions.push(
        firstRow[`language_instruction_${instructionNum}`] as string,
      );
      instructionNum++;
    }

    if (languageInstructions.length > 0) {
      task = languageInstructions.join("\n");
    }
  }

  if (!task && textRows.length > 0 && typeof textRows[0].task === "string") {
    task = textRows[0].task;
  }

  if (!task && textRows.length > 0) {
    try {
      const tasksUrl = buildVersionedUrl(repoId, version, "meta/tasks.jsonl");
      const tasksResponse = await fetch(tasksUrl, { cache: "no-store" });

      if (tasksResponse.ok) {
        const tasksText = await tasksResponse.text();
        const tasksData = tasksText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

        if (tasksData && tasksData.length > 0) {
          const taskIndex = textRows[0].task_index;
          const taskIndexNum =
            typeof taskIndex === "bigint" ? Number(taskIndex) : taskIndex;
          const taskData = tasksData.find(
            (t: Record<string, unknown>) => t.task_index === taskIndexNum,
          );
          if (taskData) {
            task = taskData.task;
          }
        }
      }
    } catch {
      // No tasks metadata file for this v2.x dataset
    }
  }

  const { chartDataGroups, flatChartData } = frames
    ? chartDataFromFrames(
        frames,
        info,
        EXCLUDED_COLUMNS.V2,
        (frameIndex) => frames.timestamps[frameIndex],
      )
    : { chartDataGroups: [], flatChartData: [] };

  // List of columns that are ignored (e.g., 2D or 3D data)
  const ignoredColumns = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) && value.shape.length > 1,
    )
    .map(([key]) => key);

  const duration =
    flatChartData.length > 0
      ? flatChartData[flatChartData.length - 1].timestamp
      : 0;

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    flatChartData,
    episodes,
    ignoredColumns,
    duration,
    task,
    languageAtoms,
    frameTimestamps,
    handTracking,
  };
}

// v3.0 implementation with segmentation support for all episodes
async function getEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<EpisodeData> {
  const datasetInfo: DatasetDisplayInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
    robot_type: null,
    codebase_version: version,
    total_tasks: 0,
    cameras: [],
  };

  const episodes = Array.from({ length: info.total_episodes }, (_, i) => i);

  const leRobotEpisode = await loadLeRobotEpisode(repoId, episodeId);
  const episodeMetadata = toEpisodeMetadataV3(leRobotEpisode);
  const videosInfo = toVideosInfo(leRobotEpisode, info, true);

  // Load episode data for charts
  const {
    chartDataGroups,
    flatChartData,
    ignoredColumns,
    task,
    languageAtoms,
    frameTimestamps,
    handTracking,
  } = await loadEpisodeDataV3(
    repoId,
    version,
    info,
    episodeMetadata,
    leRobotEpisode,
  );

  const duration = episodeMetadata.length
    ? episodeMetadata.length / info.fps
    : episodeMetadata.video_to_timestamp - episodeMetadata.video_from_timestamp;

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    flatChartData,
    episodes,
    ignoredColumns,
    duration,
    task,
    languageAtoms,
    frameTimestamps,
    handTracking,
  };
}

// Load episode data for v3.0 charts
async function loadEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: EpisodeMetadataV3,
  episode: LeRobotEpisode,
): Promise<{
  chartDataGroups: ChartRow[][];
  flatChartData: Record<string, number>[];
  ignoredColumns: string[];
  task?: string;
  languageAtoms?: import("@/types/language.types").LanguageAtom[];
  frameTimestamps?: number[];
  handTracking?: HandTracking;
}> {
  try {
    const { frames, textRows, handTracking } = await loadEpisodeFrames(
      repoId,
      episode,
      info,
    );
    const frameTimestamps = sortedTimestamps(frames);

    if (!frames) {
      return {
        chartDataGroups: [],
        flatChartData: [],
        ignoredColumns: [],
        task: undefined,
        languageAtoms: extractLanguageAtoms(textRows),
        frameTimestamps,
        handTracking,
      };
    }

    /// Stretched over the video segment rather than read from `timestamp`, so the chart cursor
    /// stays in step with the player.
    const videoDuration =
      (episodeMetadata.video_to_timestamp || 30) -
      (episodeMetadata.video_from_timestamp || 0);
    const { chartDataGroups, flatChartData } = chartDataFromFrames(
      frames,
      info,
      EXCLUDED_COLUMNS.V3,
      (_, position, count) =>
        (position / Math.max(count - 1, 1)) * videoDuration,
    );

    // List of columns that are ignored (now we handle 2D data by flattening)
    const ignoredColumns = [
      ...Object.entries(info.features)
        .filter(
          ([, value]) =>
            ["float32", "int32"].includes(value.dtype) &&
            value.shape.length > 2, // Only ignore 3D+ data
        )
        .map(([key]) => key),
      ...EXCLUDED_COLUMNS.V3,
    ];

    // Prefer the authoritative `tasks` list on the episode's own metadata
    // (v3.0 stores it as list[str] — see lerobot dataset_metadata.save_episode).
    let task: string | undefined;
    if (episodeMetadata.tasks && episodeMetadata.tasks.length > 0) {
      task = episodeMetadata.tasks.join("\n");
    }

    // Fall back to per-frame language_instruction fields
    if (!task && textRows.length > 0) {
      const languageInstructions: string[] = [];

      const extractInstructions = (row: Record<string, unknown>) => {
        if (typeof row.language_instruction === "string") {
          languageInstructions.push(row.language_instruction);
        }
        let num = 2;
        while (typeof row[`language_instruction_${num}`] === "string") {
          languageInstructions.push(
            row[`language_instruction_${num}`] as string,
          );
          num++;
        }
      };

      extractInstructions(textRows[0]);

      // If no instructions in first row, check middle and last rows
      if (languageInstructions.length === 0 && textRows.length > 1) {
        for (const idx of [
          Math.floor(textRows.length / 2),
          textRows.length - 1,
        ]) {
          extractInstructions(textRows[idx]);
          if (languageInstructions.length > 0) break;
        }
      }

      if (languageInstructions.length > 0) {
        task = languageInstructions.join("\n");
      }
    }

    // Fall back to tasks metadata parquet
    if (!task && textRows.length > 0) {
      try {
        const tasksUrl = buildVersionedUrl(
          repoId,
          version,
          "meta/tasks.parquet",
        );
        const tasksArrayBuffer = await fetchParquetFile(tasksUrl);
        const tasksData = await readParquetAsObjects(tasksArrayBuffer, []);

        if (tasksData.length > 0) {
          const taskIndexNum = bigIntToNumber(textRows[0].task_index, -1);

          if (taskIndexNum >= 0) {
            // lerobot writes tasks.parquet from a DataFrame with the task
            // string as the (possibly named) index and `task_index` as a
            // column. Row order is not guaranteed to match task_index, so
            // match on the column value.
            const taskData = tasksData.find(
              (row) => bigIntToNumber(row.task_index, -1) === taskIndexNum,
            );
            if (taskData) {
              const rawTask = taskData.__index_level_0__ ?? taskData.task;
              task = typeof rawTask === "string" ? rawTask : undefined;
            }
          }
        }
      } catch {
        // Could not load tasks metadata
      }
    }

    return {
      chartDataGroups,
      flatChartData,
      ignoredColumns,
      task,
      languageAtoms: extractLanguageAtoms(textRows),
      frameTimestamps,
      handTracking,
    };
  } catch {
    return {
      chartDataGroups: [],
      flatChartData: [],
      ignoredColumns: [],
      task: undefined,
    };
  }
}

/**
 * Extract `LanguageAtom`s from a list of v3.1 parquet rows.
 *
 * Each row may carry two arrays:
 *   - `language_persistent`: broadcast — same content on every row in the
 *     episode. We sample row 0 (skipping nulls/empties).
 *   - `language_events`: per-row, mostly empty. We collect every event whose
 *     row's `timestamp` falls within the episode.
 *
 * Hyparquet decodes `list<struct<...>>` to `Array<Record<string, unknown>>`.
 * We coerce loosely-typed values to the canonical `LanguageAtom` shape and
 * drop rows that don't validate.
 */
export function extractLanguageAtoms(
  episodeRows: Record<string, unknown>[],
): import("@/types/language.types").LanguageAtom[] {
  if (!episodeRows.length) return [];
  type LanguageAtom = import("@/types/language.types").LanguageAtom;
  const atoms: LanguageAtom[] = [];
  const seenPersistent: Set<string> = new Set(); // dedupe broadcast copies

  const coerce = (raw: unknown, fallbackTs?: number): LanguageAtom | null => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const role =
      typeof r.role === "string" ? (r.role as LanguageAtom["role"]) : null;
    if (!role) return null;
    const style =
      typeof r.style === "string" ? (r.style as LanguageAtom["style"]) : null;
    const content = typeof r.content === "string" ? r.content : null;
    const timestamp =
      typeof r.timestamp === "number"
        ? r.timestamp
        : typeof r.timestamp === "bigint"
          ? Number(r.timestamp)
          : (fallbackTs ?? 0);
    const tool_calls = Array.isArray(r.tool_calls)
      ? (r.tool_calls as LanguageAtom["tool_calls"])
      : null;
    const camera =
      typeof r.camera === "string" && r.camera.length > 0 ? r.camera : null;
    return { role, content, style, timestamp, camera, tool_calls };
  };

  // Persistent slice: read once from the first row that has a non-empty list.
  for (const row of episodeRows) {
    const list = row["language_persistent"];
    if (Array.isArray(list) && list.length > 0) {
      for (const raw of list) {
        const atom = coerce(raw);
        if (!atom) continue;
        const key = `${atom.style}|${atom.role}|${atom.timestamp}|${atom.camera ?? ""}|${atom.content}`;
        if (seenPersistent.has(key)) continue;
        seenPersistent.add(key);
        atoms.push(atom);
      }
      break;
    }
  }

  // Event slice: every non-empty per-row list contributes its rows. Each
  // event's timestamp should already match its frame timestamp; we use the
  // row timestamp as a fallback if it's missing.
  for (const row of episodeRows) {
    const list = row["language_events"];
    if (!Array.isArray(list) || list.length === 0) continue;
    const rowTs =
      typeof row.timestamp === "number"
        ? row.timestamp
        : typeof row.timestamp === "bigint"
          ? Number(row.timestamp)
          : 0;
    for (const raw of list) {
      const atom = coerce(raw, rowTs);
      if (atom) atoms.push(atom);
    }
  }

  return atoms;
}

/**
 * Columns `frames()` leaves out that the episode view still needs: the task, and the v3.1 language
 * atoms (lerobot#3467), which lerobot can also write onto v2.x datasets. hyparquet skips requested
 * columns that are not in the file, so un-annotated datasets cost nothing extra.
 */
const TEXT_COLUMNS = [
  "timestamp",
  "task",
  "task_index",
  "language_instruction",
  "language_instruction_2",
  "language_instruction_3",
  "language_persistent",
  "language_events",
];

/**
 * Past this many values in its row groups, a nested text column is left out: hyparquet decodes it
 * for the whole row group, and a file written as one row group can hold millions of atoms. 22M
 * took 2-3 GB of heap; 44M (MinhDuk/final_dataset_annotated) and 66M crashed the tab.
 */
const MAX_NESTED_TEXT_VALUES = 25_000_000;

/** The episode's numeric series from `@huggingface/lerobot`, plus its text columns read alongside. */
async function loadEpisodeFrames(
  repoId: string,
  episode: LeRobotEpisode,
  info: DatasetMetadata,
): Promise<{
  frames: LeRobotFrames | undefined;
  textRows: Record<string, unknown>[];
  handTracking?: HandTracking;
}> {
  const data = episode.data;
  if (!data) return { frames: undefined, textRows: [] };
  const [frames, textRows, report] = await Promise.all([
    leRobotDataset(repoId).frames(episode),
    fetchParquetFile(data.url).then(async (file) => {
      const values = nestedColumnValues(
        await parquetMetadataAsync(file),
        data.fromRow,
        data.toRow,
      );
      const skipped = TEXT_COLUMNS.filter(
        (column) => (values.get(column) ?? 0) > MAX_NESTED_TEXT_VALUES,
      );
      if (skipped.length > 0)
        console.warn(
          `[language] ${skipped.join(", ")} left out: its row group is too large to decode`,
        );
      return readParquetAsObjects(
        file,
        TEXT_COLUMNS.filter((column) => !skipped.includes(column)),
        { rowStart: data.fromRow, rowEnd: data.toRow },
      );
    }),
    hasHandTracking(info)
      ? fetch(
          buildVersionedUrl(
            repoId,
            info.codebase_version,
            "annotation_studio/run.json",
          ),
          { headers: authHeaders(), signal: AbortSignal.timeout(10_000) },
        )
          .then((response) =>
            response.ok ? (response.json() as Promise<unknown>) : null,
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    frames,
    textRows,
    handTracking: readHandTracking(
      info,
      frames,
      handProjectionMetadata(info, episode.index, report),
    ),
  };
}

/** Source-frame timestamps, sorted, for the annotations editor to snap to. */
function sortedTimestamps(frames: LeRobotFrames | undefined): number[] {
  return (frames?.timestamps ?? [])
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
}

/**
 * Chart rows for an episode, sampled down to MAX_EPISODE_POINTS. An array feature gets one series
 * per component, named from `info.json` when it lists one name per component and by index otherwise;
 * a single unnamed component (a reward, a success flag) keeps its bare feature key.
 */
function chartDataFromFrames(
  frames: LeRobotFrames,
  info: DatasetMetadata,
  excludedColumns: readonly string[],
  timestampAt: (frameIndex: number, position: number, count: number) => number,
): { chartDataGroups: ChartRow[][]; flatChartData: Record<string, number>[] } {
  const series: [string, number[]][] = [];
  for (const [key, components] of Object.entries(frames.series)) {
    if (!info.features[key] || excludedColumns.includes(key)) continue;
    if (hasHandTracking(info) && isHandGeometryColumn(key)) continue;
    const names =
      frames.names[key]?.length === components.length
        ? frames.names[key]
        : undefined;
    components.forEach((values, i) => {
      const suffix = names?.[i] ?? (components.length > 1 ? i : undefined);
      series.push([
        suffix === undefined ? key : `${key}${SERIES_NAME_DELIMITER}${suffix}`,
        values,
      ]);
    });
  }

  const sampled = evenlySampleIndices(frames.length, MAX_EPISODE_POINTS);
  const flatChartData = sampled.map((frameIndex, position) => {
    const row: Record<string, number> = {
      timestamp: timestampAt(frameIndex, position, sampled.length),
    };
    for (const [name, values] of series) row[name] = values[frameIndex];
    return row;
  });

  const seriesNames = ["timestamp", ...series.map(([name]) => name)];
  const chartDataGroups = processChartDataGroups(
    seriesNames,
    flatChartData,
  ).map((group) =>
    flatChartData.map((row) => {
      const grouped = groupRowBySuffix(pick(row, [...group, "timestamp"]));
      // Ensure timestamp is always a number at the top level
      return {
        ...grouped,
        timestamp:
          typeof grouped.timestamp === "number" ? grouped.timestamp : 0,
      };
    }),
  );

  return { chartDataGroups, flatChartData };
}

// ─── Stats computation ───────────────────────────────────────────

/**
 * Compute per-column min/max values from the current episode's chart data.
 */
export function computeColumnMinMax(
  chartDataGroups: ChartRow[][],
): ColumnMinMax[] {
  const stats: Record<string, { min: number; max: number }> = {};

  for (const group of chartDataGroups) {
    for (const row of group) {
      for (const [key, value] of Object.entries(row)) {
        if (key === "timestamp") continue;
        if (typeof value === "number" && isFinite(value)) {
          if (!stats[key]) {
            stats[key] = { min: value, max: value };
          } else {
            if (value < stats[key].min) stats[key].min = value;
            if (value > stats[key].max) stats[key].max = value;
          }
        } else if (typeof value === "object" && value !== null) {
          // Nested group like { joint_0: 1.2, joint_1: 3.4 }
          for (const [subKey, subVal] of Object.entries(value)) {
            const fullKey = `${key} | ${subKey}`;
            if (typeof subVal === "number" && isFinite(subVal)) {
              if (!stats[fullKey]) {
                stats[fullKey] = { min: subVal, max: subVal };
              } else {
                if (subVal < stats[fullKey].min) stats[fullKey].min = subVal;
                if (subVal > stats[fullKey].max) stats[fullKey].max = subVal;
              }
            }
          }
        }
      }
    }
  }

  return Object.entries(stats).map(([column, { min, max }]) => ({
    column,
    min: Math.round(min * 1000) / 1000,
    max: Math.round(max * 1000) / 1000,
  }));
}

/**
 * Load all episode lengths from the episodes metadata parquet files (v3.0).
 * Returns min/max/mean/median/std and a histogram, or null if unavailable.
 */
/** Works for every version: the package reads v2's episodes.jsonl and v3's episode index alike. */
export async function loadAllEpisodeLengths(
  repoId: string,
  fps: number,
): Promise<EpisodeLengthStats | null> {
  try {
    const { totalEpisodes } = await leRobotDataset(repoId).info();
    const listing = (await loadLeRobotEpisodes(repoId, totalEpisodes)).map(
      (episode) => ({ index: episode.index, length: episode.length }),
    );

    if (listing.length === 0) return null;

    const withSeconds = listing.map((ep) => ({
      episodeIndex: ep.index,
      frames: ep.length,
      lengthSeconds: Math.round((ep.length / fps) * 100) / 100,
    }));

    const sortedByLength = [...withSeconds].sort(
      (a, b) => a.lengthSeconds - b.lengthSeconds,
    );
    const shortestEpisodes = sortedByLength.slice(0, 5);
    const longestEpisodes = sortedByLength.slice(-5).reverse();

    const lengths = withSeconds.map((e) => e.lengthSeconds);
    const sum = lengths.reduce((a, b) => a + b, 0);
    const mean = Math.round((sum / lengths.length) * 100) / 100;

    const sorted = [...lengths].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
        : sorted[mid];

    const variance =
      lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length;
    const std = Math.round(Math.sqrt(variance) * 100) / 100;

    // Build histogram
    const histMin = Math.min(...lengths);
    const histMax = Math.max(...lengths);

    if (histMax === histMin) {
      return {
        shortestEpisodes,
        longestEpisodes,
        allEpisodeLengths: withSeconds,
        meanEpisodeLength: mean,
        medianEpisodeLength: median,
        stdEpisodeLength: std,
        episodeLengthHistogram: [
          { binLabel: `${histMin.toFixed(1)}s`, count: lengths.length },
        ],
      };
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
    const niceSteps = [1, 2, 2.5, 5, 10];
    const niceBinWidth =
      niceSteps.map((s) => s * magnitude).find((w) => w >= rawBinWidth) ??
      rawBinWidth;

    const niceMin = Math.floor(p1 / niceBinWidth) * niceBinWidth;
    const niceMax = Math.ceil(p99 / niceBinWidth) * niceBinWidth;
    const actualBinCount = Math.max(
      1,
      Math.round((niceMax - niceMin) / niceBinWidth),
    );
    const bins = Array.from({ length: actualBinCount }, () => 0);

    for (const len of lengths) {
      let binIdx = Math.floor((len - niceMin) / niceBinWidth);
      if (binIdx < 0) binIdx = 0;
      if (binIdx >= actualBinCount) binIdx = actualBinCount - 1;
      bins[binIdx]++;
    }

    const histogram = bins.map((count, i) => {
      const lo = niceMin + i * niceBinWidth;
      const hi = lo + niceBinWidth;
      return { binLabel: `${lo.toFixed(1)}–${hi.toFixed(1)}s`, count };
    });

    return {
      shortestEpisodes,
      longestEpisodes,
      allEpisodeLengths: withSeconds,
      meanEpisodeLength: mean,
      medianEpisodeLength: median,
      stdEpisodeLength: std,
      episodeLengthHistogram: histogram,
    };
  } catch {
    return null;
  }
}

/**
 * Load video frame info for all episodes across all cameras.
 * Returns camera names + a map of camera → EpisodeFrameInfo[].
 */
export async function loadAllEpisodeFrameInfo(
  repoId: string,
  version: string,
  info: DatasetMetadata,
): Promise<EpisodeFramesData> {
  /// A timestamp on a frame boundary can resolve to either side of it: seeking to an episode's
  /// exact start could show the previous episode's last frame. Half a frame in is unambiguous.
  const halfFrameSec = 0.5 / (info.fps || 30);
  const empty = { totalEpisodes: info.total_episodes, halfFrameSec };
  const videoFeatures = Object.entries(info.features).filter(
    ([, f]) => f.dtype === "video",
  );
  if (videoFeatures.length === 0)
    return { cameras: [], framesByCamera: {}, ...empty };

  const cameras = videoFeatures.map(([key]) => key);
  const framesByCamera: Record<string, EpisodeFrameInfo[]> = {};
  for (const cam of cameras) framesByCamera[cam] = [];
  const sampledEpisodeSet = buildSampledEpisodeSet(
    info.total_episodes,
    MAX_FRAMES_OVERVIEW_EPISODES,
  );

  if (version === "v3.0") {
    for (const episode of await loadLeRobotEpisodes(
      repoId,
      info.total_episodes,
    )) {
      if (sampledEpisodeSet && !sampledEpisodeSet.has(episode.index)) continue;
      for (const video of episode.videos) {
        framesByCamera[video.cameraKey]?.push({
          episodeIndex: episode.index,
          videoUrl: video.url,
          firstFrameTime: video.fromSec + halfFrameSec,
          lastFrameTime: Math.max(video.fromSec, video.toSec - halfFrameSec),
          durationSec: video.toSec - video.fromSec,
        });
      }
    }
    return { cameras, framesByCamera, ...empty };
  }

  // v2.x — construct URLs from template
  for (let i = 0; i < info.total_episodes; i++) {
    if (sampledEpisodeSet && !sampledEpisodeSet.has(i)) continue;
    const chunk = Math.floor(i / (info.chunks_size || 1000));
    for (const cam of cameras) {
      const videoPath = formatStringWithVars(info.video_path, {
        video_key: cam,
        episode_chunk: chunk.toString().padStart(3, "0"),
        episode_index: i.toString().padStart(6, "0"),
      });
      framesByCamera[cam].push({
        episodeIndex: i,
        videoUrl: buildVersionedUrl(repoId, version, videoPath),
        firstFrameTime: halfFrameSec,
        lastFrameTime: null,
      });
    }
  }
  return { cameras, framesByCamera, ...empty };
}

// ─── Cross-episode action variance ──────────────────────────────

export type {
  LowMovementEpisode,
  AggVelocityStat,
  AggAutocorrelation,
  SpeedDistEntry,
  AggAlignment,
  JerkyEpisode,
  CrossEpisodeVarianceData,
} from "@/utils/crossEpisode";

/** The names of a vector feature's components, however deeply info.json nests them. */
function featureNames(names: unknown, dim: number): string[] | null {
  while (typeof names === "object" && names !== null && !Array.isArray(names)) {
    names = Object.values(names)[0];
  }
  return Array.isArray(names) && names.length === dim
    ? (names as string[])
    : null;
}

/** Runs `task` over `items`, at most `limit` at a time, keeping their order in the result. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]);
      }
    }),
  );
  return results;
}

type EpisodeRows = {
  index: number;
  /** Row offsets in the file; `toRow` exclusive, or null for "to the file's end" (v2.x). */
  fromRow: number;
  toRow: number | null;
};

/** Copies one row's vector into `out`; false when the cell is not a vector of numbers. */
function writeVector(
  out: Float32Array,
  offset: number,
  dim: number,
  value: unknown,
): boolean {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const vector = value as ArrayLike<unknown>;
    if (vector.length < dim) return false;
    for (let d = 0; d < dim; d++) out[offset + d] = Number(vector[d]);
    return true;
  }
  // A feature of shape [1] is stored as a plain number.
  if (dim === 1 && (typeof value === "number" || typeof value === "bigint")) {
    out[offset] = Number(value);
    return true;
  }
  return false;
}

/**
 * Reads the action (and state) rows of the given episodes out of one data file, in a single pass
 * over the row groups that hold them. An episode whose action rows cannot be read is left out.
 */
async function readEpisodeSeries(
  url: string,
  episodes: EpisodeRows[],
  action: { key: string; dim: number },
  state: { key: string; dim: number } | null,
): Promise<EpisodeSeries[]> {
  const file = await openParquetFile(url);
  const metadata = await parquetMetadataAsync(file);
  const numRows = Number(metadata.num_rows);

  const targets = episodes
    .map((episode) => {
      const from = Math.min(episode.fromRow, numRows);
      const to = Math.min(episode.toRow ?? numRows, numRows);
      const length = Math.max(0, to - from);
      return {
        index: episode.index,
        from,
        to,
        length,
        actions: new Float32Array(length * action.dim),
        states: state ? new Float32Array(length * state.dim) : null,
        actionRows: 0,
        stateRows: 0,
      };
    })
    .filter((target) => target.length > 0);
  if (targets.length === 0) return [];

  await readParquetColumnChunks(
    file,
    state ? [action.key, state.key] : [action.key],
    ({ columnName, columnData, rowStart, rowEnd }) => {
      const isAction = columnName === action.key;
      const dim = isAction ? action.dim : (state?.dim ?? 0);
      for (const target of targets) {
        const out = isAction ? target.actions : target.states;
        if (!out) continue;
        const from = Math.max(target.from, rowStart);
        const to = Math.min(target.to, rowEnd);
        let written = 0;
        for (let row = from; row < to; row++) {
          const offset = (row - target.from) * dim;
          if (writeVector(out, offset, dim, columnData[row - rowStart])) {
            written++;
          }
        }
        if (isAction) target.actionRows += written;
        else target.stateRows += written;
      }
    },
    {
      rowStart: Math.min(...targets.map((t) => t.from)),
      rowEnd: Math.max(...targets.map((t) => t.to)),
      metadata,
    },
  );

  return targets
    .filter((target) => target.actionRows === target.length)
    .map((target) => ({
      index: target.index,
      length: target.length,
      actions: target.actions,
      states: target.stateRows === target.length ? target.states : null,
    }));
}

export async function loadCrossEpisodeActionVariance(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  fps: number,
  options: {
    maxEpisodes?: number;
    numTimeBins?: number;
    /** Called as data files finish: how many are read, out of how many. */
    onProgress?: (progress: { done: number; total: number }) => void;
  } = {},
): Promise<CrossEpisodeVarianceData | null> {
  const maxEpisodes = Math.min(
    options.maxEpisodes ?? MAX_CROSS_EPISODE_SAMPLE,
    MAX_CROSS_EPISODE_SAMPLE,
  );
  const actionEntry = Object.entries(info.features).find(
    ([key, f]) => key === "action" && f.shape.length === 1,
  );
  if (!actionEntry) {
    console.warn(
      "[cross-ep] No action feature found. Available features:",
      Object.entries(info.features)
        .map(([k, f]) => `${k}(${f.dtype}, shape=${JSON.stringify(f.shape)})`)
        .join(", "),
    );
    return null;
  }

  const [actionKey, actionMeta] = actionEntry;
  const actionDim = actionMeta.shape[0];
  /// Some datasets list fewer names than the action has components (libero declares ["actions"]
  /// for a 7-wide action); index those instead of leaving components unnamed.
  const actionNames = (
    featureNames(actionMeta.names, actionDim) ??
    Array.from({ length: actionDim }, (_, i) => `${i}`)
  ).map((name) => `${actionKey}${SERIES_NAME_DELIMITER}${name}`);

  // State feature for alignment computation
  const stateEntry = Object.entries(info.features).find(
    ([key, f]) => key === "observation.state" && f.shape.length === 1,
  );
  const stateDim = stateEntry?.[1].shape[0] ?? 0;
  const state =
    stateEntry && stateDim > 0 ? { key: stateEntry[0], dim: stateDim } : null;
  /// Any list of names is taken as it is, as before: a state whose names do not line up with its
  /// components is paired with the actions by position.
  let stateNames: unknown = stateEntry?.[1].names;
  while (
    typeof stateNames === "object" &&
    stateNames !== null &&
    !Array.isArray(stateNames)
  ) {
    stateNames = Object.values(stateNames)[0];
  }

  // Which episodes to read, and from which files.
  const byFile = new Map<string, EpisodeRows[]>();
  const addToFile = (url: string, episode: EpisodeRows) => {
    const list = byFile.get(url);
    if (list) list.push(episode);
    else byFile.set(url, [episode]);
  };

  if (version === "v3.0") {
    const candidates = (await loadLeRobotEpisodes(repoId, info.total_episodes))
      .filter((episode) => episode.data)
      .map((episode) => ({
        index: episode.index,
        file: episode.data!.url,
        fromRow: episode.data!.fromRow,
        toRow: episode.data!.toRow,
      }));
    /// The budget is in bytes read. A row costs about 5 bytes a component: a float32, plus the
    /// list encoding around it (floats barely compress).
    const rowBudget = Math.floor(
      MAX_CROSS_EPISODE_BYTES / (5 * (actionDim + stateDim)),
    );
    for (const episode of planEpisodeSample(
      candidates,
      maxEpisodes,
      rowBudget,
    )) {
      addToFile(episode.file, episode);
    }
  } else {
    // v2.x: one small file per episode, so the sample is simply spread over the episodes.
    const chunkSize = info.chunks_size || 1000;
    for (const index of evenlySampleIndices(info.total_episodes, maxEpisodes)) {
      const dataPath = formatStringWithVars(info.data_path, {
        episode_chunk: Math.floor(index / chunkSize)
          .toString()
          .padStart(3, "0"),
        episode_index: index.toString().padStart(6, "0"),
      });
      addToFile(buildVersionedUrl(repoId, version, dataPath), {
        index,
        fromRow: 0,
        toRow: null,
      });
    }
  }

  const sampled = [...byFile.values()].reduce((n, eps) => n + eps.length, 0);
  if (sampled < 2) {
    console.warn(`[cross-ep] Only ${sampled} episode(s) to read, need ≥2`);
    return null;
  }

  // Decoding a file, and each stage of the statistics, is one long stretch of work on the main
  // thread: a pause between them lets the page paint and respond.
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const files = [...byFile.entries()];
  let done = 0;
  options.onProgress?.({ done, total: files.length });
  const perFile = await mapLimit(files, 4, async ([url, episodes]) => {
    let series: EpisodeSeries[] = [];
    try {
      series = await readEpisodeSeries(
        url,
        episodes,
        { key: actionKey, dim: actionDim },
        state,
      );
    } catch {
      /* skip file */
    }
    options.onProgress?.({ done: ++done, total: files.length });
    await pause();
    return series;
  });
  const episodes = perFile.flat().sort((x, y) => x.index - y.index);

  if (episodes.length < 2) {
    console.warn(
      `[cross-ep] Only ${episodes.length} episode(s) had loadable action data out of ${sampled} sampled`,
    );
    return null;
  }

  return computeCrossEpisodeStatsInSteps(
    {
      episodes,
      actionDim,
      stateDim,
      actionNames,
      stateNames: Array.isArray(stateNames)
        ? (stateNames as string[])
        : Array.from({ length: stateDim }, (_, i) => `${i}`),
      fps,
      numTimeBins: options.numTimeBins,
    },
    pause,
  );
}

// Load only flatChartData for a specific episode (used by the 3D Replay viewer's episode switching)
export async function loadEpisodeFlatChartData(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<Record<string, number>[]> {
  const episode = await loadLeRobotEpisode(repoId, episodeId);
  const { flatChartData } = await loadEpisodeDataV3(
    repoId,
    version,
    info,
    toEpisodeMetadataV3(episode),
    episode,
  );
  return flatChartData;
}

// Safe wrapper for UI error display
export async function getEpisodeDataSafe(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<{ data?: EpisodeData; error?: string; noEpisodes?: boolean }> {
  try {
    const data = await getEpisodeData(org, dataset, episodeId);
    return { data };
  } catch (err: unknown) {
    if (err instanceof NoEpisodesError) {
      return { noEpisodes: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: message || "Unknown error" };
  }
}

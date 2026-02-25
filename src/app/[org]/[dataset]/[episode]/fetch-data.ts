import {
  DatasetMetadata,
  fetchParquetFile,
  formatStringWithVars,
  readParquetAsObjects,
} from "@/utils/parquetUtils";
import { pick } from "@/utils/pick";
import {
  getDatasetVersionAndInfo,
  buildVersionedUrl,
} from "@/utils/versionUtils";
import { PADDING, CHART_CONFIG, EXCLUDED_COLUMNS } from "@/utils/constants";
import {
  processChartDataGroups,
  groupRowBySuffix,
} from "@/utils/dataProcessing";
import {
  buildV3VideoPath,
  buildV3DataPath,
  buildV3EpisodesMetadataPath,
} from "@/utils/stringFormatting";
import { bigIntToNumber } from "@/utils/typeGuards";
import type { VideoInfo, AdjacentEpisodeVideos } from "@/types";

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;

export type CameraInfo = { name: string; width: number; height: number };

export type DatasetDisplayInfo = {
  repoId: string;
  total_frames: number;
  total_episodes: number;
  fps: number;
  robot_type: string | null;
  codebase_version: string;
  total_tasks: number;
  dataset_size_mb: number;
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
  firstFrameTime: number;
  lastFrameTime: number | null; // null = seek to video.duration on client
};

export type EpisodeFramesData = {
  cameras: string[];
  framesByCamera: Record<string, EpisodeFrameInfo[]>;
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
};

type EpisodeMetadataV3 = {
  episode_index: number;
  data_chunk_index: number;
  data_file_index: number;
  dataset_from_index: number;
  dataset_to_index: number;
  video_chunk_index: number;
  video_file_index: number;
  video_from_timestamp: number;
  video_to_timestamp: number;
  length: number;
  [key: string]: string | number;
};

type ColumnDef = {
  key: string;
  value: string[];
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
const MAX_CROSS_EPISODE_FRAMES_PER_EPISODE = parsePositiveIntEnv(
  process.env.MAX_CROSS_EPISODE_FRAMES_PER_EPISODE,
  2500,
  100,
);
const PROGRESS_PARQUET_CANDIDATES = [
  "sarm_progress.parquet",
  "srm_progress.parquet",
] as const;
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

async function loadEpisodeProgressGroup(
  repoId: string,
  version: string,
  episodeId: number,
  episodeDuration: number,
): Promise<ChartRow[] | null> {
  for (const progressPath of PROGRESS_PARQUET_CANDIDATES) {
    const progressUrl = buildVersionedUrl(repoId, version, progressPath);
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
      const duration = Math.max(episodeDuration, 0);

      return sampledPoints.map((point, idx) => ({
        timestamp:
          sampledPoints.length === 1 ? 0 : (idx / denominator) * duration,
        [progressKey]: point.progress,
      }));
    } catch {
      // Optional file: ignore and try next candidate.
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

export async function getEpisodeData(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<EpisodeData> {
  const repoId = `${org}/${dataset}`;
  try {
    console.time(`[perf] getDatasetVersionAndInfo`);
    const { version, info: rawInfo } = await getDatasetVersionAndInfo(repoId);
    console.timeEnd(`[perf] getDatasetVersionAndInfo`);
    const info = rawInfo as unknown as DatasetMetadata;

    if (info.video_path === null) {
      throw new Error(
        "Only videos datasets are supported in this visualizer.\nPlease use Rerun visualizer for images datasets.",
      );
    }

    console.time(`[perf] getEpisodeData (${version})`);
    const result =
      version === "v3.0"
        ? await getEpisodeDataV3(repoId, version, info, episodeId)
        : await getEpisodeDataV2(repoId, version, info, episodeId);
    console.timeEnd(`[perf] getEpisodeData (${version})`);

    // Extract camera resolutions from features
    const cameras: CameraInfo[] = Object.entries(rawInfo.features)
      .filter(([, f]) => f.dtype === "video" && f.shape.length >= 2)
      .map(([name, f]) => ({ name, height: f.shape[0], width: f.shape[1] }));

    result.datasetInfo = {
      ...result.datasetInfo,
      robot_type: rawInfo.robot_type ?? null,
      codebase_version: rawInfo.codebase_version,
      total_tasks: rawInfo.total_tasks ?? 0,
      dataset_size_mb:
        Math.round(
          ((rawInfo.data_files_size_in_mb ?? 0) +
            (rawInfo.video_files_size_in_mb ?? 0)) *
            10,
        ) / 10,
      cameras,
    };

    const progressGroup = await loadEpisodeProgressGroup(
      repoId,
      version,
      episodeId,
      result.duration,
    );
    if (progressGroup && progressGroup.length > 0) {
      result.chartDataGroups = [...result.chartDataGroups, progressGroup];
    }

    return result;
  } catch (err) {
    console.error("Error loading episode data:", err);
    throw err;
  }
}

export async function getAdjacentEpisodesVideoInfo(
  org: string,
  dataset: string,
  currentEpisodeId: number,
  radius: number = 2,
): Promise<AdjacentEpisodeVideos[]> {
  const repoId = `${org}/${dataset}`;
  try {
    const { version, info: rawInfo } = await getDatasetVersionAndInfo(repoId);
    const info = rawInfo as unknown as DatasetMetadata;

    const totalEpisodes = info.total_episodes;
    const adjacentVideos: AdjacentEpisodeVideos[] = [];

    // Calculate adjacent episode IDs
    for (let offset = -radius; offset <= radius; offset++) {
      if (offset === 0) continue; // Skip current episode

      const episodeId = currentEpisodeId + offset;
      if (episodeId >= 0 && episodeId < totalEpisodes) {
        try {
          let videosInfo: VideoInfo[] = [];

          if (version === "v3.0") {
            const episodeMetadata = await loadEpisodeMetadataV3Simple(
              repoId,
              version,
              episodeId,
            );
            videosInfo = extractVideoInfoV3WithSegmentation(
              repoId,
              version,
              info,
              episodeMetadata,
            );
          } else {
            // For v2.x, use simpler video info extraction
            if (info.video_path) {
              const chunkSize = Math.max(1, info.chunks_size || 1000);
              const episode_chunk = Math.floor(episodeId / chunkSize);
              videosInfo = Object.entries(info.features)
                .filter(([, value]) => value.dtype === "video")
                .map(([key]) => {
                  const videoPath = formatStringWithVars(info.video_path!, {
                    video_key: key,
                    episode_chunk: episode_chunk
                      .toString()
                      .padStart(PADDING.CHUNK_INDEX, "0"),
                    episode_index: episodeId
                      .toString()
                      .padStart(PADDING.EPISODE_INDEX, "0"),
                  });
                  return {
                    filename: key,
                    url: buildVersionedUrl(repoId, version, videoPath),
                  };
                });
            }
          }

          adjacentVideos.push({ episodeId, videosInfo });
        } catch {
          // Skip failed episodes silently
        }
      }
    }

    return adjacentVideos;
  } catch {
    // Return empty array on error
    return [];
  }
}

// Legacy v2.x data loading
async function getEpisodeDataV2(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<EpisodeData> {
  const chunkSize = Math.max(1, info.chunks_size || 1000);
  const episode_chunk = Math.floor(episodeId / chunkSize);

  const datasetInfo: DatasetDisplayInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
    robot_type: null,
    codebase_version: version,
    total_tasks: 0,
    dataset_size_mb: 0,
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

  // Videos information
  const videosInfo =
    info.video_path !== null
      ? Object.entries(info.features)
          .filter(([, value]) => value.dtype === "video")
          .map(([key]) => {
            const videoPath = formatStringWithVars(info.video_path!, {
              video_key: key,
              episode_chunk: episode_chunk
                .toString()
                .padStart(PADDING.CHUNK_INDEX, "0"),
              episode_index: episodeId
                .toString()
                .padStart(PADDING.EPISODE_INDEX, "0"),
            });
            return {
              filename: key,
              url: buildVersionedUrl(repoId, version, videoPath),
            };
          })
      : [];

  // Column data
  const columnNames = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) && value.shape.length === 1,
    )
    .map(([key, { shape }]) => ({ key, length: shape[0] }));

  // Exclude specific columns
  const excludedColumns = EXCLUDED_COLUMNS.V2 as readonly string[];
  const filteredColumns = columnNames.filter(
    (column) => !excludedColumns.includes(column.key),
  );
  const columns: ColumnDef[] = filteredColumns.map(({ key }) => {
    let column_names: unknown = info.features[key].names;
    while (typeof column_names === "object" && column_names !== null) {
      if (Array.isArray(column_names)) break;
      column_names = Object.values(column_names)[0];
    }
    return {
      key,
      value: Array.isArray(column_names)
        ? column_names.map(
            (name: string) => `${key}${SERIES_NAME_DELIMITER}${name}`,
          )
        : Array.from(
            { length: columnNames.find((c) => c.key === key)?.length ?? 1 },
            (_, i) => `${key}${CHART_CONFIG.SERIES_NAME_DELIMITER}${i}`,
          ),
    };
  });

  const parquetUrl = buildVersionedUrl(
    repoId,
    version,
    formatStringWithVars(info.data_path, {
      episode_chunk: episode_chunk
        .toString()
        .padStart(PADDING.CHUNK_INDEX, "0"),
      episode_index: episodeId.toString().padStart(PADDING.EPISODE_INDEX, "0"),
    }),
  );

  const arrayBuffer = await fetchParquetFile(parquetUrl);
  const parquetColumns = Array.from(
    new Set([
      "timestamp",
      "task",
      "task_index",
      "language_instruction",
      ...filteredColumns.map((c) => c.key),
    ]),
  );
  const allData = await readParquetAsObjects(arrayBuffer, parquetColumns);

  // Extract task from language_instruction fields, task field, or tasks.jsonl
  let task: string | undefined;

  if (allData.length > 0) {
    const firstRow = allData[0];
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

  if (!task && allData.length > 0 && typeof allData[0].task === "string") {
    task = allData[0].task;
  }

  if (!task && allData.length > 0) {
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
          const taskIndex = allData[0].task_index;
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

  // Build chart data from already-parsed allData (no second parquet parse)
  const seriesNames = [
    "timestamp",
    ...columns.map(({ value }) => value).flat(),
  ];

  const chartData = allData.map((row) => {
    const obj: Record<string, number> = {};
    obj["timestamp"] = Number(row.timestamp);
    for (const col of columns) {
      const rawVal = row[col.key];
      if (Array.isArray(rawVal)) {
        rawVal.forEach((v: unknown, i: number) => {
          if (i < col.value.length) obj[col.value[i]] = Number(v);
        });
      } else if (rawVal !== undefined) {
        obj[col.value[0]] = Number(rawVal);
      }
    }
    return obj;
  });
  const sampledChartData = evenlySampleArray(chartData, MAX_EPISODE_POINTS);

  // List of columns that are ignored (e.g., 2D or 3D data)
  const ignoredColumns = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) && value.shape.length > 1,
    )
    .map(([key]) => key);

  // Process chart data into organized groups using utility function
  const chartGroups = processChartDataGroups(seriesNames, sampledChartData);

  const duration =
    sampledChartData.length > 0
      ? sampledChartData[sampledChartData.length - 1].timestamp
      : 0;

  const chartDataGroups = chartGroups.map((group) =>
    sampledChartData.map((row) => {
      const grouped = groupRowBySuffix(pick(row, [...group, "timestamp"]));
      // Ensure timestamp is always a number at the top level
      return {
        ...grouped,
        timestamp:
          typeof grouped.timestamp === "number" ? grouped.timestamp : 0,
      };
    }),
  );

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    flatChartData: sampledChartData,
    episodes,
    ignoredColumns,
    duration,
    task,
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
    dataset_size_mb: 0,
    cameras: [],
  };

  const episodes = Array.from({ length: info.total_episodes }, (_, i) => i);

  // Load episode metadata to get timestamps for episode 0
  const episodeMetadata = await loadEpisodeMetadataV3Simple(
    repoId,
    version,
    episodeId,
  );

  // Create video info with segmentation using the metadata
  const videosInfo = extractVideoInfoV3WithSegmentation(
    repoId,
    version,
    info,
    episodeMetadata,
  );

  // Load episode data for charts
  const { chartDataGroups, flatChartData, ignoredColumns, task } =
    await loadEpisodeDataV3(repoId, version, info, episodeMetadata);

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
  };
}

// Load episode data for v3.0 charts
async function loadEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: EpisodeMetadataV3,
): Promise<{
  chartDataGroups: ChartRow[][];
  flatChartData: Record<string, number>[];
  ignoredColumns: string[];
  task?: string;
}> {
  // Build data file path using chunk and file indices
  const dataChunkIndex = bigIntToNumber(episodeMetadata.data_chunk_index, 0);
  const dataFileIndex = bigIntToNumber(episodeMetadata.data_file_index, 0);
  const dataPath = buildV3DataPath(dataChunkIndex, dataFileIndex);

  try {
    const dataUrl = buildVersionedUrl(repoId, version, dataPath);
    const parquetFile = await fetchParquetFile(dataUrl);
    const v3DataColumns = Array.from(
      new Set([
        "index",
        "timestamp",
        "task_index",
        "language_instruction",
        "language_instruction_2",
        "language_instruction_3",
        ...Object.entries(info.features)
          .filter(([, feature]) => {
            const dtype = feature.dtype.toLowerCase();
            const isNumericOrBool = [
              "float32",
              "float64",
              "int8",
              "int16",
              "int32",
              "int64",
              "uint8",
              "uint16",
              "uint32",
              "uint64",
              "bool",
              "boolean",
            ].includes(dtype);
            return isNumericOrBool && feature.shape.length <= 1;
          })
          .map(([key]) => key),
      ]),
    );
    // Extract the episode-specific data slice
    const fromIndex = bigIntToNumber(episodeMetadata.dataset_from_index, 0);
    let toIndex = bigIntToNumber(episodeMetadata.dataset_to_index, fromIndex);
    if (toIndex <= fromIndex) {
      toIndex = fromIndex + 1;
    }

    let episodeRows: Record<string, unknown>[] = [];
    let usedRowRange = false;

    try {
      const indexPreview = await readParquetAsObjects(parquetFile, ["index"], {
        rowStart: 0,
        rowEnd: 1,
      });
      const startIndexValue = indexPreview[0]?.index;
      if (startIndexValue !== undefined && startIndexValue !== null) {
        const fileStartIndex =
          typeof startIndexValue === "bigint"
            ? Number(startIndexValue)
            : Number(startIndexValue);
        const localFromIndex = Math.max(0, fromIndex - fileStartIndex);
        const localToIndex = Math.max(localFromIndex, toIndex - fileStartIndex);
        episodeRows = await readParquetAsObjects(parquetFile, v3DataColumns, {
          rowStart: localFromIndex,
          rowEnd: localToIndex,
        });
        usedRowRange = true;
      }
    } catch {
      // Fall back to full reads if row-range selection fails.
    }

    if (!usedRowRange) {
      episodeRows = await readParquetAsObjects(parquetFile, v3DataColumns);
    }

    const episodeData = evenlySampleArray(episodeRows, MAX_EPISODE_POINTS);

    if (episodeData.length === 0) {
      return {
        chartDataGroups: [],
        flatChartData: [],
        ignoredColumns: [],
        task: undefined,
      };
    }

    // Convert to the same format as v2.x for compatibility with existing chart code
    const { chartDataGroups, flatChartData, ignoredColumns } =
      processEpisodeDataForCharts(episodeData, info, episodeMetadata);

    // First check for language_instruction fields in the data (preferred)
    let task: string | undefined;
    if (episodeData.length > 0) {
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

      extractInstructions(episodeData[0]);

      // If no instructions in first row, check middle and last rows
      if (languageInstructions.length === 0 && episodeData.length > 1) {
        for (const idx of [
          Math.floor(episodeData.length / 2),
          episodeData.length - 1,
        ]) {
          extractInstructions(episodeData[idx]);
          if (languageInstructions.length > 0) break;
        }
      }

      if (languageInstructions.length > 0) {
        task = languageInstructions.join("\n");
      }
    }

    // Fall back to tasks metadata parquet
    if (!task && episodeData.length > 0) {
      try {
        const tasksUrl = buildVersionedUrl(
          repoId,
          version,
          "meta/tasks.parquet",
        );
        const tasksArrayBuffer = await fetchParquetFile(tasksUrl);
        const tasksData = await readParquetAsObjects(tasksArrayBuffer, []);

        if (tasksData.length > 0) {
          const taskIndexNum = bigIntToNumber(episodeData[0].task_index, -1);

          if (taskIndexNum >= 0 && taskIndexNum < tasksData.length) {
            const taskData = tasksData[taskIndexNum];
            const rawTask = taskData.__index_level_0__ ?? taskData.task;
            task = typeof rawTask === "string" ? rawTask : undefined;
          }
        }
      } catch {
        // Could not load tasks metadata
      }
    }

    return { chartDataGroups, flatChartData, ignoredColumns, task };
  } catch {
    return {
      chartDataGroups: [],
      flatChartData: [],
      ignoredColumns: [],
      task: undefined,
    };
  }
}

// Process episode data for charts (v3.0 compatible)
function processEpisodeDataForCharts(
  episodeData: Record<string, unknown>[],
  info: DatasetMetadata,
  episodeMetadata?: EpisodeMetadataV3,
): {
  chartDataGroups: ChartRow[][];
  flatChartData: Record<string, number>[];
  ignoredColumns: string[];
} {
  // Convert parquet data to chart format
  let seriesNames: string[] = [];

  // Dynamically create a mapping from numeric indices to feature names based on actual dataset features
  const v3IndexToFeatureMap: Record<string, string> = {};

  // Build mapping based on what features actually exist in the dataset
  const featureKeys = Object.keys(info.features);

  // Common feature order for v3.0 datasets (but only include if they exist)
  const expectedFeatureOrder = [
    "observation.state",
    "action",
    "timestamp",
    "episode_index",
    "frame_index",
    "next.reward",
    "next.done",
    "index",
    "task_index",
  ];

  // Map indices to features that actually exist
  let currentIndex = 0;
  expectedFeatureOrder.forEach((feature) => {
    if (featureKeys.includes(feature)) {
      v3IndexToFeatureMap[currentIndex.toString()] = feature;
      currentIndex++;
    }
  });

  // Columns to exclude from charts (note: 'task' is intentionally not excluded as we want to access it)
  const excludedColumns = EXCLUDED_COLUMNS.V3 as readonly string[];

  // Create columns structure similar to V2.1 for proper hierarchical naming
  const columns: ColumnDef[] = Object.entries(info.features)
    .filter(
      ([key, value]) =>
        ["float32", "int32"].includes(value.dtype) &&
        value.shape.length === 1 &&
        !excludedColumns.includes(key),
    )
    .map(([key, feature]) => {
      let column_names: unknown = feature.names;
      while (typeof column_names === "object" && column_names !== null) {
        if (Array.isArray(column_names)) break;
        column_names = Object.values(column_names)[0];
      }
      return {
        key,
        value: Array.isArray(column_names)
          ? column_names.map(
              (name: string) => `${key}${SERIES_NAME_DELIMITER}${name}`,
            )
          : Array.from(
              { length: feature.shape[0] || 1 },
              (_, i) => `${key}${CHART_CONFIG.SERIES_NAME_DELIMITER}${i}`,
            ),
      };
    });

  // First, extract all series from the first data row to understand the structure
  if (episodeData.length > 0) {
    const firstRow = episodeData[0];
    const allKeys: string[] = [];

    Object.entries(firstRow || {}).forEach(([key, value]) => {
      if (key === "timestamp") return; // Skip timestamp, we'll add it separately

      // Map numeric key to feature name if available
      const featureName = v3IndexToFeatureMap[key] || key;

      // Skip if feature doesn't exist in dataset
      if (!info.features[featureName]) return;

      // Skip excluded columns
      if (excludedColumns.includes(featureName)) return;

      // Find the matching column definition to get proper names
      const columnDef = columns.find((col) => col.key === featureName);
      if (columnDef && Array.isArray(value) && value.length > 0) {
        // Use the proper hierarchical naming from column definition
        columnDef.value.forEach((seriesName, idx) => {
          if (idx < value.length) {
            allKeys.push(seriesName);
          }
        });
      } else if (typeof value === "number" && !isNaN(value)) {
        // For scalar numeric values
        allKeys.push(featureName);
      } else if (typeof value === "bigint") {
        // For BigInt values
        allKeys.push(featureName);
      }
    });

    seriesNames = ["timestamp", ...allKeys];
  } else {
    // Fallback to column-based approach like V2.1
    seriesNames = ["timestamp", ...columns.map(({ value }) => value).flat()];
  }

  const chartData = episodeData.map((row, index) => {
    const obj: Record<string, number> = {};

    // Add timestamp aligned with video timing
    // For v3.0, we need to map the episode data index to the actual video duration
    let videoDuration = episodeData.length; // Fallback to data length
    if (episodeMetadata) {
      // Use actual video segment duration if available
      videoDuration =
        (episodeMetadata.video_to_timestamp || 30) -
        (episodeMetadata.video_from_timestamp || 0);
    }
    obj["timestamp"] =
      (index / Math.max(episodeData.length - 1, 1)) * videoDuration;

    // Add all data columns using hierarchical naming
    if (row && typeof row === "object") {
      Object.entries(row).forEach(([key, value]) => {
        if (key === "timestamp") {
          // Timestamp is already handled above
          return;
        }

        // Map numeric key to feature name if available
        const featureName = v3IndexToFeatureMap[key] || key;

        // Skip if feature doesn't exist in dataset
        if (!info.features[featureName]) return;

        // Skip excluded columns
        if (excludedColumns.includes(featureName)) return;

        // Find the matching column definition to get proper series names
        const columnDef = columns.find((col) => col.key === featureName);

        if (Array.isArray(value) && columnDef) {
          // For array values like observation.state and action, use proper hierarchical naming
          value.forEach((val, idx) => {
            if (idx < columnDef.value.length) {
              const seriesName = columnDef.value[idx];
              obj[seriesName] = typeof val === "number" ? val : Number(val);
            }
          });
        } else if (typeof value === "number" && !isNaN(value)) {
          obj[featureName] = value;
        } else if (typeof value === "bigint") {
          obj[featureName] = Number(value);
        } else if (typeof value === "boolean") {
          // Convert boolean to number for charts
          obj[featureName] = value ? 1 : 0;
        }
      });
    }

    return obj;
  });

  // List of columns that are ignored (now we handle 2D data by flattening)
  const ignoredColumns = [
    ...Object.entries(info.features)
      .filter(
        ([, value]) =>
          ["float32", "int32"].includes(value.dtype) && value.shape.length > 2, // Only ignore 3D+ data
      )
      .map(([key]) => key),
    ...excludedColumns, // Also include the manually excluded columns
  ];

  // Process chart data into organized groups using utility function
  const chartGroups = processChartDataGroups(seriesNames, chartData);

  const chartDataGroups = chartGroups.map((group) =>
    chartData.map((row) => {
      const grouped = groupRowBySuffix(pick(row, [...group, "timestamp"]));
      // Ensure timestamp is always a number at the top level
      return {
        ...grouped,
        timestamp:
          typeof grouped.timestamp === "number" ? grouped.timestamp : 0,
      };
    }),
  );

  return { chartDataGroups, flatChartData: chartData, ignoredColumns };
}

// Video info extraction with segmentation for v3.0
function extractVideoInfoV3WithSegmentation(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: EpisodeMetadataV3,
): VideoInfo[] {
  // Get video features from dataset info
  const videoFeatures = Object.entries(info.features).filter(
    ([, value]) => value.dtype === "video",
  );

  const videosInfo = videoFeatures.map(([videoKey]) => {
    // Check if we have per-camera metadata in the episode row
    const cameraSpecificKeys = Object.keys(episodeMetadata).filter((key) =>
      key.startsWith(`videos/${videoKey}/`),
    );

    let chunkIndex: number,
      fileIndex: number,
      segmentStart: number,
      segmentEnd: number;

    const toNum = (v: string | number): number =>
      typeof v === "string" ? parseFloat(v) || 0 : v;

    if (cameraSpecificKeys.length > 0) {
      chunkIndex = toNum(episodeMetadata[`videos/${videoKey}/chunk_index`]);
      fileIndex = toNum(episodeMetadata[`videos/${videoKey}/file_index`]);
      segmentStart =
        toNum(episodeMetadata[`videos/${videoKey}/from_timestamp`]) || 0;
      segmentEnd =
        toNum(episodeMetadata[`videos/${videoKey}/to_timestamp`]) || 30;
    } else {
      chunkIndex = episodeMetadata.video_chunk_index || 0;
      fileIndex = episodeMetadata.video_file_index || 0;
      segmentStart = episodeMetadata.video_from_timestamp || 0;
      segmentEnd = episodeMetadata.video_to_timestamp || 30;
    }

    // Convert BigInt to number for timestamps
    const startNum = bigIntToNumber(segmentStart);
    const endNum = bigIntToNumber(segmentEnd);

    const videoPath = buildV3VideoPath(
      videoKey,
      bigIntToNumber(chunkIndex, 0),
      bigIntToNumber(fileIndex, 0),
    );
    const fullUrl = buildVersionedUrl(repoId, version, videoPath);

    return {
      filename: videoKey,
      url: fullUrl,
      // Enable segmentation with timestamps from metadata
      isSegmented: true,
      segmentStart: startNum,
      segmentEnd: endNum,
      segmentDuration: endNum - startNum,
    };
  });

  return videosInfo;
}

// Metadata loading for v3.0 episodes
async function loadEpisodeMetadataV3Simple(
  repoId: string,
  version: string,
  episodeId: number,
): Promise<EpisodeMetadataV3> {
  // Pattern: meta/episodes/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet
  // Most datasets have all episodes in chunk-000/file-000, but episodes can be split across files

  let episodeRow = null;
  let fileIndex = 0;
  const chunkIndex = 0; // Episodes are typically in chunk-000

  // Try loading episode metadata files until we find the episode
  while (!episodeRow) {
    const episodesMetadataPath = buildV3EpisodesMetadataPath(
      chunkIndex,
      fileIndex,
    );
    const episodesMetadataUrl = buildVersionedUrl(
      repoId,
      version,
      episodesMetadataPath,
    );

    try {
      const arrayBuffer = await fetchParquetFile(episodesMetadataUrl);
      const episodesData = await readParquetAsObjects(arrayBuffer, []);

      if (episodesData.length === 0) {
        // Empty file, try next one
        fileIndex++;
        continue;
      }

      // Find the row for the requested episode by episode_index
      for (const row of episodesData) {
        const parsedRow = parseEpisodeRowSimple(row);

        if (parsedRow.episode_index === episodeId) {
          episodeRow = row;
          break;
        }
      }

      if (!episodeRow) {
        // Not in this file, try the next one
        fileIndex++;
      }
    } catch {
      // File doesn't exist - episode not found
      throw new Error(
        `Episode ${episodeId} not found in metadata (searched up to file-${fileIndex.toString().padStart(PADDING.CHUNK_INDEX, "0")}.parquet)`,
      );
    }
  }

  // Convert the row to a usable format
  return parseEpisodeRowSimple(episodeRow);
}

// Simple parser for episode row - focuses on key fields for episodes
function parseEpisodeRowSimple(
  row: Record<string, unknown>,
): EpisodeMetadataV3 {
  // v3.0 uses named keys in the episode metadata
  if (row && typeof row === "object") {
    // Check if this is v3.0 format with named keys
    if ("episode_index" in row) {
      // v3.0 format - use named keys
      // Convert BigInt values to numbers
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

      // Handle video metadata - look for video-specific keys
      const videoKeys = Object.keys(row).filter(
        (key) => key.includes("videos/") && key.includes("/chunk_index"),
      );
      let videoChunkIndex = 0,
        videoFileIndex = 0,
        videoFromTs = 0,
        videoToTs = 30;
      if (videoKeys.length > 0) {
        const videoBaseName = videoKeys[0].replace("/chunk_index", "");
        videoChunkIndex = toBigIntSafe(row[`${videoBaseName}/chunk_index`]);
        videoFileIndex = toBigIntSafe(row[`${videoBaseName}/file_index`]);
        videoFromTs = toNumSafe(row[`${videoBaseName}/from_timestamp`]);
        videoToTs = toNumSafe(row[`${videoBaseName}/to_timestamp`]) || 30;
      }

      const episodeData: EpisodeMetadataV3 = {
        episode_index: toBigIntSafe(row["episode_index"]),
        data_chunk_index: toBigIntSafe(row["data/chunk_index"]),
        data_file_index: toBigIntSafe(row["data/file_index"]),
        dataset_from_index: toBigIntSafe(row["dataset_from_index"]),
        dataset_to_index: toBigIntSafe(row["dataset_to_index"]),
        length: toBigIntSafe(row["length"]),
        video_chunk_index: videoChunkIndex,
        video_file_index: videoFileIndex,
        video_from_timestamp: videoFromTs,
        video_to_timestamp: videoToTs,
      };

      // Store per-camera metadata for extractVideoInfoV3WithSegmentation
      Object.keys(row).forEach((key) => {
        if (key.startsWith("videos/")) {
          const val = row[key];
          episodeData[key] =
            typeof val === "bigint"
              ? Number(val)
              : typeof val === "number" || typeof val === "string"
                ? val
                : 0;
        }
      });

      return episodeData as EpisodeMetadataV3;
    } else {
      // Fallback to numeric keys for compatibility
      const toNum = (v: unknown, fallback = 0): number =>
        typeof v === "number"
          ? v
          : typeof v === "bigint"
            ? Number(v)
            : fallback;
      return {
        episode_index: toNum(row["0"]),
        data_chunk_index: toNum(row["1"]),
        data_file_index: toNum(row["2"]),
        dataset_from_index: toNum(row["3"]),
        dataset_to_index: toNum(row["4"]),
        video_chunk_index: toNum(row["5"]),
        video_file_index: toNum(row["6"]),
        video_from_timestamp: toNum(row["7"]),
        video_to_timestamp: toNum(row["8"], 30),
        length: toNum(row["9"], 30),
      };
    }
  }

  // Fallback if parsing fails
  const fallback = {
    episode_index: 0,
    data_chunk_index: 0,
    data_file_index: 0,
    dataset_from_index: 0,
    dataset_to_index: 0,
    video_chunk_index: 0,
    video_file_index: 0,
    video_from_timestamp: 0,
    video_to_timestamp: 30,
    length: 30,
  };

  return fallback;
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
export async function loadAllEpisodeLengthsV3(
  repoId: string,
  version: string,
  fps: number,
): Promise<EpisodeLengthStats | null> {
  try {
    const allEpisodes: { index: number; length: number }[] = [];
    let fileIndex = 0;
    const chunkIndex = 0;

    while (true) {
      const path = `meta/episodes/chunk-${chunkIndex.toString().padStart(3, "0")}/file-${fileIndex.toString().padStart(3, "0")}.parquet`;
      const url = buildVersionedUrl(repoId, version, path);
      try {
        const buf = await fetchParquetFile(url);
        const rows = await readParquetAsObjects(buf, []);
        if (rows.length === 0 && fileIndex > 0) break;
        for (const row of rows) {
          const parsed = parseEpisodeRowSimple(row);
          allEpisodes.push({
            index: parsed.episode_index,
            length: parsed.length,
          });
        }
        fileIndex++;
      } catch {
        break;
      }
    }

    if (allEpisodes.length === 0) return null;

    const withSeconds = allEpisodes.map((ep) => ({
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
  const videoFeatures = Object.entries(info.features).filter(
    ([, f]) => f.dtype === "video",
  );
  if (videoFeatures.length === 0) return { cameras: [], framesByCamera: {} };

  const cameras = videoFeatures.map(([key]) => key);
  const framesByCamera: Record<string, EpisodeFrameInfo[]> = {};
  for (const cam of cameras) framesByCamera[cam] = [];
  const sampledEpisodeSet = buildSampledEpisodeSet(
    info.total_episodes,
    MAX_FRAMES_OVERVIEW_EPISODES,
  );

  if (version === "v3.0") {
    let fileIndex = 0;
    while (true) {
      const path = `meta/episodes/chunk-000/file-${fileIndex.toString().padStart(3, "0")}.parquet`;
      try {
        const buf = await fetchParquetFile(
          buildVersionedUrl(repoId, version, path),
        );
        const rows = await readParquetAsObjects(buf, []);
        if (rows.length === 0 && fileIndex > 0) break;
        for (const row of rows) {
          const epIdx = Number(row["episode_index"] ?? 0);
          if (sampledEpisodeSet && !sampledEpisodeSet.has(epIdx)) continue;
          for (const cam of cameras) {
            const cIdx = Number(
              row[`videos/${cam}/chunk_index`] ?? row["video_chunk_index"] ?? 0,
            );
            const fIdx = Number(
              row[`videos/${cam}/file_index`] ?? row["video_file_index"] ?? 0,
            );
            const fromTs = Number(
              row[`videos/${cam}/from_timestamp`] ??
                row["video_from_timestamp"] ??
                0,
            );
            const toTs = Number(
              row[`videos/${cam}/to_timestamp`] ??
                row["video_to_timestamp"] ??
                30,
            );
            const videoPath = `videos/${cam}/chunk-${cIdx.toString().padStart(3, "0")}/file-${fIdx.toString().padStart(3, "0")}.mp4`;
            framesByCamera[cam].push({
              episodeIndex: epIdx,
              videoUrl: buildVersionedUrl(repoId, version, videoPath),
              firstFrameTime: fromTs,
              lastFrameTime: Math.max(0, toTs - 0.05),
            });
          }
        }
        fileIndex++;
      } catch {
        break;
      }
    }
    return { cameras, framesByCamera };
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
        firstFrameTime: 0,
        lastFrameTime: null,
      });
    }
  }
  return { cameras, framesByCamera };
}

// ─── Cross-episode action variance ──────────────────────────────

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
  inactive?: boolean; // true if p95(|Δa|) < 1% of motor range
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

export async function loadCrossEpisodeActionVariance(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  fps: number,
  maxEpisodes = MAX_CROSS_EPISODE_SAMPLE,
  numTimeBins = 50,
): Promise<CrossEpisodeVarianceData | null> {
  const cappedMaxEpisodes = Math.min(maxEpisodes, MAX_CROSS_EPISODE_SAMPLE);
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

  let names: unknown = actionMeta.names;
  while (typeof names === "object" && names !== null && !Array.isArray(names)) {
    names = Object.values(names)[0];
  }
  const actionNames = Array.isArray(names)
    ? (names as string[]).map((n) => `${actionKey}${SERIES_NAME_DELIMITER}${n}`)
    : Array.from(
        { length: actionDim },
        (_, i) => `${actionKey}${SERIES_NAME_DELIMITER}${i}`,
      );

  // State feature for alignment computation
  const stateEntry = Object.entries(info.features).find(
    ([key, f]) => key === "observation.state" && f.shape.length === 1,
  );
  const stateKey = stateEntry?.[0] ?? null;
  const stateDim = stateEntry?.[1].shape[0] ?? 0;

  // Collect episode metadata
  type EpMeta = {
    index: number;
    chunkIdx: number;
    fileIdx: number;
    from: number;
    to: number;
  };
  const allEps: EpMeta[] = [];

  if (version === "v3.0") {
    let fileIndex = 0;
    while (true) {
      const path = `meta/episodes/chunk-000/file-${fileIndex.toString().padStart(3, "0")}.parquet`;
      try {
        const buf = await fetchParquetFile(
          buildVersionedUrl(repoId, version, path),
        );
        const rows = await readParquetAsObjects(buf, []);
        if (rows.length === 0 && fileIndex > 0) break;
        for (const row of rows) {
          const parsed = parseEpisodeRowSimple(row);
          allEps.push({
            index: parsed.episode_index,
            chunkIdx: parsed.data_chunk_index,
            fileIdx: parsed.data_file_index,
            from: parsed.dataset_from_index,
            to: parsed.dataset_to_index,
          });
        }
        fileIndex++;
      } catch {
        break;
      }
    }
  } else {
    for (let i = 0; i < info.total_episodes; i++) {
      allEps.push({ index: i, chunkIdx: 0, fileIdx: 0, from: 0, to: 0 });
    }
  }

  if (allEps.length < 2) {
    console.warn(
      `[cross-ep] Only ${allEps.length} episode(s) found in metadata, need ≥2`,
    );
    return null;
  }
  console.log(
    `[cross-ep] Found ${allEps.length} episodes in metadata, sampling up to ${cappedMaxEpisodes}`,
  );

  // Sample episodes evenly
  const sampled =
    allEps.length <= cappedMaxEpisodes
      ? allEps
      : Array.from(
          { length: cappedMaxEpisodes },
          (_, i) =>
            allEps[
              Math.round((i * (allEps.length - 1)) / (cappedMaxEpisodes - 1))
            ],
        );

  // Load action (and state) data per episode
  const episodeActions: { index: number; actions: number[][] }[] = [];
  const episodeStates: (number[][] | null)[] = [];

  if (version === "v3.0") {
    const byFile = new Map<string, EpMeta[]>();
    for (const ep of sampled) {
      const key = `${ep.chunkIdx}-${ep.fileIdx}`;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(ep);
    }

    for (const [, eps] of byFile) {
      const ep0 = eps[0];
      const dataPath = `data/chunk-${ep0.chunkIdx.toString().padStart(3, "0")}/file-${ep0.fileIdx.toString().padStart(3, "0")}.parquet`;
      try {
        const buf = await fetchParquetFile(
          buildVersionedUrl(repoId, version, dataPath),
        );
        const rows = await readParquetAsObjects(
          buf,
          stateKey ? ["index", actionKey, stateKey] : ["index", actionKey],
        );
        const fileStart =
          rows.length > 0 && rows[0].index !== undefined
            ? Number(rows[0].index)
            : 0;

        for (const ep of eps) {
          const localFrom = Math.max(0, ep.from - fileStart);
          const localTo = Math.min(rows.length, ep.to - fileStart);
          const actions: number[][] = [];
          const states: number[][] = [];
          for (let r = localFrom; r < localTo; r++) {
            const raw = rows[r]?.[actionKey];
            if (Array.isArray(raw)) actions.push(raw.map(Number));
            if (stateKey) {
              const sRaw = rows[r]?.[stateKey];
              if (Array.isArray(sRaw)) states.push(sRaw.map(Number));
            }
          }
          if (actions.length > 0) {
            const sampledIndices = evenlySampleIndices(
              actions.length,
              Math.min(actions.length, MAX_CROSS_EPISODE_FRAMES_PER_EPISODE),
            );
            const sampledActions = sampledIndices.map((i) => actions[i]);
            const sampledStates =
              stateKey && states.length === actions.length
                ? sampledIndices.map((i) => states[i])
                : null;
            episodeActions.push({ index: ep.index, actions: sampledActions });
            episodeStates.push(stateKey ? sampledStates : null);
          }
        }
      } catch {
        /* skip file */
      }
    }
  } else {
    const chunkSize = info.chunks_size || 1000;
    for (const ep of sampled) {
      const chunk = Math.floor(ep.index / chunkSize);
      const dataPath = formatStringWithVars(info.data_path, {
        episode_chunk: chunk.toString().padStart(3, "0"),
        episode_index: ep.index.toString().padStart(6, "0"),
      });
      try {
        const buf = await fetchParquetFile(
          buildVersionedUrl(repoId, version, dataPath),
        );
        const rows = await readParquetAsObjects(
          buf,
          stateKey ? [actionKey, stateKey] : [actionKey],
        );
        const actions: number[][] = [];
        const states: number[][] = [];
        for (const row of rows) {
          const raw = row[actionKey];
          if (Array.isArray(raw)) {
            actions.push(raw.map(Number));
          } else {
            const vec: number[] = [];
            for (let d = 0; d < actionDim; d++) {
              const v = row[`${actionKey}.${d}`] ?? row[d];
              vec.push(typeof v === "number" ? v : Number(v) || 0);
            }
            actions.push(vec);
          }
          if (stateKey) {
            const sRaw = row[stateKey];
            if (Array.isArray(sRaw)) states.push(sRaw.map(Number));
          }
        }
        if (actions.length > 0) {
          const sampledIndices = evenlySampleIndices(
            actions.length,
            Math.min(actions.length, MAX_CROSS_EPISODE_FRAMES_PER_EPISODE),
          );
          const sampledActions = sampledIndices.map((i) => actions[i]);
          const sampledStates =
            stateKey && states.length === actions.length
              ? sampledIndices.map((i) => states[i])
              : null;
          episodeActions.push({ index: ep.index, actions: sampledActions });
          episodeStates.push(stateKey ? sampledStates : null);
        }
      } catch {
        /* skip */
      }
    }
  }

  if (episodeActions.length < 2) {
    console.warn(
      `[cross-ep] Only ${episodeActions.length} episode(s) had loadable action data out of ${sampled.length} sampled`,
    );
    return null;
  }
  console.log(
    `[cross-ep] Loaded action data for ${episodeActions.length}/${sampled.length} episodes`,
  );

  // Resample each episode to numTimeBins and compute variance
  const timeBins = Array.from(
    { length: numTimeBins },
    (_, i) => i / (numTimeBins - 1),
  );
  const sums = Array.from(
    { length: numTimeBins },
    () => new Float64Array(actionDim),
  );
  const sumsSq = Array.from(
    { length: numTimeBins },
    () => new Float64Array(actionDim),
  );
  const counts = new Uint32Array(numTimeBins);

  for (const { actions: epActions } of episodeActions) {
    const T = epActions.length;
    for (let b = 0; b < numTimeBins; b++) {
      const srcIdx = Math.min(Math.round(timeBins[b] * (T - 1)), T - 1);
      const row = epActions[srcIdx];
      for (let d = 0; d < actionDim; d++) {
        const v = row[d] ?? 0;
        sums[b][d] += v;
        sumsSq[b][d] += v * v;
      }
      counts[b]++;
    }
  }

  const variance: number[][] = [];
  for (let b = 0; b < numTimeBins; b++) {
    const row: number[] = [];
    const n = counts[b];
    for (let d = 0; d < actionDim; d++) {
      if (n < 2) {
        row.push(0);
        continue;
      }
      const mean = sums[b][d] / n;
      row.push(sumsSq[b][d] / n - mean * mean);
    }
    variance.push(row);
  }

  // Per-episode average movement per frame: mean L2 norm of frame-to-frame action deltas
  const movementScores: LowMovementEpisode[] = episodeActions.map(
    ({ index, actions: ep }) => {
      if (ep.length < 2) return { episodeIndex: index, totalMovement: 0 };
      let total = 0;
      for (let t = 1; t < ep.length; t++) {
        let sumSq = 0;
        for (let d = 0; d < actionDim; d++) {
          const delta = (ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0);
          sumSq += delta * delta;
        }
        total += Math.sqrt(sumSq);
      }
      const avgPerFrame = total / (ep.length - 1);
      return {
        episodeIndex: index,
        totalMovement: Math.round(avgPerFrame * 10000) / 10000,
      };
    },
  );

  movementScores.sort((a, b) => a.totalMovement - b.totalMovement);
  const lowMovementEpisodes = movementScores.slice(0, 10);

  // Precompute per-dimension normalization: motor range (max − min) and unique value count
  const motorRanges: number[] = new Array(actionDim);
  const motorUniqueCount: number[] = new Array(actionDim);
  const DISCRETE_THRESHOLD = 4; // ≤ this many unique values → discrete motor
  for (let d = 0; d < actionDim; d++) {
    let lo = Infinity,
      hi = -Infinity;
    const uniqueVals = new Set<number>();
    for (const { actions: ep } of episodeActions) {
      for (let t = 0; t < ep.length; t++) {
        const v = ep[t][d] ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (uniqueVals.size <= DISCRETE_THRESHOLD) uniqueVals.add(v);
      }
    }
    motorRanges[d] = hi - lo || 1;
    motorUniqueCount[d] = uniqueVals.size;
  }

  // Per-episode, per-dimension activity: p95(|Δa|) >= 1% of motor range
  const ACTIVITY_THRESHOLD = 0.001; // 0.1% of motor range
  // activeMap[episodeIdx][dimIdx] = true if motor d is active in that episode
  const activeMap: boolean[][] = episodeActions.map(({ actions: ep }) => {
    const flags: boolean[] = new Array(actionDim);
    for (let d = 0; d < actionDim; d++) {
      if (ep.length < 2) {
        flags[d] = false;
        continue;
      }
      const absDeltas: number[] = [];
      for (let t = 1; t < ep.length; t++) {
        absDeltas.push(Math.abs((ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0)));
      }
      absDeltas.sort((a, b) => a - b);
      const p95 = absDeltas[Math.floor(absDeltas.length * 0.95)];
      flags[d] = p95 >= motorRanges[d] * ACTIVITY_THRESHOLD;
    }
    return flags;
  });
  // A motor is globally inactive only if inactive in all episodes
  const globallyActive: boolean[] = new Array(actionDim);
  for (let d = 0; d < actionDim; d++) {
    globallyActive[d] = activeMap.some((flags) => flags[d]);
  }

  // Aggregated velocity stats: pool deltas from all episodes, normalized by motor range
  const shortName = (k: string) => {
    const p = k.split(SERIES_NAME_DELIMITER);
    return p.length > 1 ? p[p.length - 1] : k;
  };

  const aggVelocity: AggVelocityStat[] = (() => {
    const binCount = 30;
    const results: AggVelocityStat[] = [];
    for (let d = 0; d < actionDim; d++) {
      const motorRange = motorRanges[d];
      const inactive = !globallyActive[d];
      // Collect all deltas (unfiltered) for histogram display
      const allDeltas: number[] = [];
      // Collect only deltas from active episodes for stats
      const activeDeltas: number[] = [];
      for (let ei = 0; ei < episodeActions.length; ei++) {
        const ep = episodeActions[ei].actions;
        for (let t = 1; t < ep.length; t++) {
          const delta = (ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0);
          allDeltas.push(delta);
          if (activeMap[ei][d]) activeDeltas.push(delta);
        }
      }
      const deltas = activeDeltas.length > 0 ? activeDeltas : allDeltas;
      const nUnique = motorUniqueCount[d];
      const discrete = nUnique <= DISCRETE_THRESHOLD;
      if (deltas.length === 0) {
        results.push({
          name: shortName(actionNames[d]),
          std: 0,
          maxAbs: 0,
          bins: new Array(binCount).fill(0),
          lo: 0,
          hi: 0,
          motorRange,
          inactive,
          discrete,
        });
        continue;
      }
      let sum = 0,
        maxAbsRaw = 0,
        loRaw = Infinity,
        hiRaw = -Infinity;
      for (const v of deltas) {
        sum += v;
        const a = Math.abs(v);
        if (a > maxAbsRaw) maxAbsRaw = a;
        if (v < loRaw) loRaw = v;
        if (v > hiRaw) hiRaw = v;
      }
      const mean = sum / deltas.length;
      let varSum = 0;
      for (const v of deltas) varSum += (v - mean) ** 2;
      const rawStd = Math.sqrt(varSum / deltas.length);
      const std = rawStd / motorRange;
      const maxAbs = maxAbsRaw / motorRange;
      const lo = loRaw / motorRange;
      const hi = hiRaw / motorRange;
      const range = hi - lo || 1;
      const binW = range / binCount;
      const bins = new Array(binCount).fill(0);
      for (const v of deltas) {
        const normV = v / motorRange;
        let b = Math.floor((normV - lo) / binW);
        if (b >= binCount) b = binCount - 1;
        bins[b]++;
      }
      results.push({
        name: shortName(actionNames[d]),
        std,
        maxAbs,
        bins,
        lo,
        hi,
        motorRange,
        inactive,
        discrete,
      });
    }
    return results;
  })();

  // Aggregated autocorrelation: average per-episode ACFs
  const aggAutocorrelation: AggAutocorrelation | null = (() => {
    const maxLag = Math.min(
      100,
      Math.floor(
        episodeActions.reduce(
          (min, e) => Math.min(min, e.actions.length),
          Infinity,
        ) / 2,
      ),
    );
    if (maxLag < 2) return null;

    const avgAcf: number[][] = Array.from({ length: actionDim }, () =>
      new Array(maxLag).fill(0),
    );
    let epCount = 0;

    for (const { actions: ep } of episodeActions) {
      if (ep.length < maxLag * 2) continue;
      epCount++;
      for (let d = 0; d < actionDim; d++) {
        const vals = ep.map((row) => row[d] ?? 0);
        const n = vals.length;
        const m = vals.reduce((a, b) => a + b, 0) / n;
        const centered = vals.map((v) => v - m);
        const vari = centered.reduce((a, v) => a + v * v, 0);
        if (vari === 0) continue;
        for (let lag = 1; lag <= maxLag; lag++) {
          let s = 0;
          for (let t = 0; t < n - lag; t++)
            s += centered[t] * centered[t + lag];
          avgAcf[d][lag - 1] += s / vari;
        }
      }
    }

    if (epCount === 0) return null;
    for (let d = 0; d < actionDim; d++)
      for (let l = 0; l < maxLag; l++) avgAcf[d][l] /= epCount;

    const shortKeys = actionNames.map(shortName);
    const chartData = Array.from({ length: maxLag }, (_, lag) => {
      const row: Record<string, number> = {
        lag: lag + 1,
        time: (lag + 1) / fps,
      };
      shortKeys.forEach((k, d) => {
        row[k] = avgAcf[d][lag];
      });
      return row;
    });

    // Suggested chunk: median lag where ACF drops below 0.5
    const lags = avgAcf
      .map((acf) => {
        const i = acf.findIndex((v) => v < 0.5);
        return i >= 0 ? i + 1 : null;
      })
      .filter(Boolean) as number[];
    const suggestedChunk =
      lags.length > 0
        ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)]
        : null;

    return { chartData, suggestedChunk, shortKeys };
  })();

  // Per-episode jerkiness: mean |Δa| across dimensions active in that episode, normalized by motor range
  const jerkyEpisodes: JerkyEpisode[] = episodeActions
    .map(({ index, actions: ep }, ei) => {
      let sum = 0,
        count = 0;
      for (let t = 1; t < ep.length; t++) {
        for (let d = 0; d < actionDim; d++) {
          if (!activeMap[ei][d]) continue; // skip motors inactive in this episode
          sum +=
            Math.abs((ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0)) / motorRanges[d];
          count++;
        }
      }
      return { episodeIndex: index, meanAbsDelta: count > 0 ? sum / count : 0 };
    })
    .sort((a, b) => b.meanAbsDelta - a.meanAbsDelta);

  // Speed distribution: all episode movement scores (not just lowest 10)
  const speedDistribution: SpeedDistEntry[] = movementScores.map((s) => ({
    episodeIndex: s.episodeIndex,
    speed: s.totalMovement,
  }));

  // Aggregated state-action alignment across episodes
  const aggAlignment: AggAlignment | null = (() => {
    if (!stateKey || stateDim === 0) return null;

    let sNms: unknown = stateEntry![1].names;
    while (typeof sNms === "object" && sNms !== null && !Array.isArray(sNms))
      sNms = Object.values(sNms)[0];
    const stateNames = Array.isArray(sNms)
      ? (sNms as string[])
      : Array.from({ length: stateDim }, (_, i) => `${i}`);
    const actionSuffixes = actionNames.map((n) => {
      const p = n.split(SERIES_NAME_DELIMITER);
      return p[p.length - 1];
    });

    // Match pairs by suffix, fall back to index
    const pairs: [number, number][] = [];
    for (let ai = 0; ai < actionDim; ai++) {
      const si = stateNames.findIndex((s) => s === actionSuffixes[ai]);
      if (si >= 0) pairs.push([ai, si]);
    }
    if (pairs.length === 0) {
      const count = Math.min(actionDim, stateDim);
      for (let i = 0; i < count; i++) pairs.push([i, i]);
    }
    if (pairs.length === 0) return null;

    const maxLag = 30;
    const numLags = 2 * maxLag + 1;
    const corrSums = pairs.map(() => new Float64Array(numLags));
    const corrCounts = pairs.map(() => new Uint32Array(numLags));

    for (let ei = 0; ei < episodeActions.length; ei++) {
      const states = episodeStates[ei];
      if (!states) continue;
      const { actions } = episodeActions[ei];
      const n = Math.min(actions.length, states.length);
      if (n < 10) continue;

      for (let pi = 0; pi < pairs.length; pi++) {
        const [ai, si] = pairs[pi];
        const aDeltas = Array.from(
          { length: n - 1 },
          (_, t) => (actions[t + 1][ai] ?? 0) - (actions[t][ai] ?? 0),
        );
        const sDeltas = Array.from(
          { length: n - 1 },
          (_, t) => (states[t + 1][si] ?? 0) - (states[t][si] ?? 0),
        );
        const effN = aDeltas.length;
        if (effN < 4) continue;
        const aM = aDeltas.reduce((a, b) => a + b, 0) / effN;
        const sM = sDeltas.reduce((a, b) => a + b, 0) / effN;

        for (let li = 0; li < numLags; li++) {
          const lag = -maxLag + li;
          let sum = 0,
            aV = 0,
            sV = 0;
          for (let t = 0; t < effN; t++) {
            const sIdx = t + lag;
            if (sIdx < 0 || sIdx >= effN) continue;
            const a = aDeltas[t] - aM,
              s = sDeltas[sIdx] - sM;
            sum += a * s;
            aV += a * a;
            sV += s * s;
          }
          const d = Math.sqrt(aV * sV);
          if (d > 0) {
            corrSums[pi][li] += sum / d;
            corrCounts[pi][li]++;
          }
        }
      }
    }

    const avgCorrs = pairs.map((_, pi) =>
      Array.from({ length: numLags }, (_, li) =>
        corrCounts[pi][li] > 0 ? corrSums[pi][li] / corrCounts[pi][li] : 0,
      ),
    );

    const ccData = Array.from({ length: numLags }, (_, li) => {
      const lag = -maxLag + li;
      const vals = avgCorrs.map((pc) => pc[li]);
      return {
        lag,
        max: Math.max(...vals),
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        min: Math.min(...vals),
      };
    });

    let meanPeakLag = 0,
      meanPeakCorr = -Infinity;
    let maxPeakLag = 0,
      maxPeakCorr = -Infinity;
    let minPeakLag = 0,
      minPeakCorr = -Infinity;
    for (const row of ccData) {
      if (row.max > maxPeakCorr) {
        maxPeakCorr = row.max;
        maxPeakLag = row.lag;
      }
      if (row.mean > meanPeakCorr) {
        meanPeakCorr = row.mean;
        meanPeakLag = row.lag;
      }
      if (row.min > minPeakCorr) {
        minPeakCorr = row.min;
        minPeakLag = row.lag;
      }
    }

    const perPairPeakLags = avgCorrs.map((pc) => {
      let best = -Infinity,
        bestLag = 0;
      for (let li = 0; li < pc.length; li++) {
        if (pc[li] > best) {
          best = pc[li];
          bestLag = -maxLag + li;
        }
      }
      return bestLag;
    });

    return {
      ccData,
      meanPeakLag,
      meanPeakCorr,
      maxPeakLag,
      maxPeakCorr,
      minPeakLag,
      minPeakCorr,
      lagRangeMin: Math.min(...perPairPeakLags),
      lagRangeMax: Math.max(...perPairPeakLags),
      numPairs: pairs.length,
    };
  })();

  return {
    actionNames,
    timeBins,
    variance,
    numEpisodes: episodeActions.length,
    lowMovementEpisodes,
    aggVelocity,
    aggAutocorrelation,
    speedDistribution,
    jerkyEpisodes,
    aggAlignment,
  };
}

// Load only flatChartData for a specific episode (used by URDF viewer episode switching)
export async function loadEpisodeFlatChartData(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<Record<string, number>[]> {
  const episodeMetadata = await loadEpisodeMetadataV3Simple(
    repoId,
    version,
    episodeId,
  );
  const { flatChartData } = await loadEpisodeDataV3(
    repoId,
    version,
    info,
    episodeMetadata,
  );
  return flatChartData;
}

// Safe wrapper for UI error display
export async function getEpisodeDataSafe(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<{ data?: EpisodeData; error?: string }> {
  try {
    const data = await getEpisodeData(org, dataset, episodeId);
    return { data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message || "Unknown error" };
  }
}

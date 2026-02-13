import {
  fetchJson,
  fetchParquetFile,
  formatStringWithVars,
  readParquetColumn,
  readParquetAsObjects,
} from "@/utils/parquetUtils";
import { pick } from "@/utils/pick";
import { getDatasetVersion, buildVersionedUrl } from "@/utils/versionUtils";
import { PADDING, CHART_CONFIG, EXCLUDED_COLUMNS } from "@/utils/constants";
import {
  processChartDataGroups,
  groupRowBySuffix,
} from "@/utils/dataProcessing";
import { extractLanguageInstructions } from "@/utils/languageInstructions";
import {
  buildV3VideoPath,
  buildV3DataPath,
  buildV3EpisodesMetadataPath,
} from "@/utils/stringFormatting";
import { bigIntToNumber } from "@/utils/typeGuards";
import type {
  DatasetMetadata,
  EpisodeData,
  EpisodeMetadataV3,
  VideoInfo,
  AdjacentEpisodeVideos,
  ChartDataGroup,
} from "@/types";

export async function getEpisodeData(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<EpisodeData> {
  const repoId = `${org}/${dataset}`;
  try {
    // Check for compatible dataset version (v3.0, v2.1, or v2.0)
    const version = await getDatasetVersion(repoId);
    const jsonUrl = buildVersionedUrl(repoId, version, "meta/info.json");
    const info = await fetchJson<DatasetMetadata>(jsonUrl);

    if (info.video_path === null) {
      throw new Error(
        "Only videos datasets are supported in this visualizer.\nPlease use Rerun visualizer for images datasets.",
      );
    }

    // Handle different versions
    if (version === "v3.0") {
      return await getEpisodeDataV3(repoId, version, info, episodeId);
    } else {
      return await getEpisodeDataV2(repoId, version, info, episodeId);
    }
  } catch (err) {
    console.error("Error loading episode data:", err);
    throw err;
  }
}

// Get video info for adjacent episodes (for preloading)
export async function getAdjacentEpisodesVideoInfo(
  org: string,
  dataset: string,
  currentEpisodeId: number,
  radius: number = 2,
): Promise<AdjacentEpisodeVideos[]> {
  const repoId = `${org}/${dataset}`;
  try {
    const version = await getDatasetVersion(repoId);
    const jsonUrl = buildVersionedUrl(repoId, version, "meta/info.json");
    const info = await fetchJson<DatasetMetadata>(jsonUrl);

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
              const episode_chunk = Math.floor(0 / 1000);
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
  const episode_chunk = Math.floor(0 / 1000);

  // Dataset information
  const datasetInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
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
  const filteredColumnNames = [
    "timestamp",
    ...filteredColumns.map((column) => column.key),
  ];

  const columns = filteredColumns.map(({ key }) => {
    let column_names = info.features[key].names;
    while (typeof column_names === "object") {
      if (Array.isArray(column_names)) break;
      column_names = Object.values(column_names ?? {})[0];
    }
    return {
      key,
      value: Array.isArray(column_names)
        ? column_names.map(
            (name) => `${key}${CHART_CONFIG.SERIES_NAME_DELIMITER}${name}`,
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

  // Extract task - first check for language instructions (preferred), then fallback to task field or tasks.jsonl
  let task: string | undefined;
  let allData: Record<string, unknown>[] = [];

  // Load data first
  try {
    allData = await readParquetAsObjects(arrayBuffer, []);
  } catch {
    // Could not read parquet data
  }

  // First check for language_instruction fields in the data (preferred)
  task = extractLanguageInstructions(allData);

  // If no language instructions found, try direct task field
  if (
    !task &&
    allData.length > 0 &&
    typeof allData[0].task === "string" &&
    allData[0].task
  ) {
    task = allData[0].task;
  }

  // If still no task found, try loading from tasks.jsonl metadata file (v2.x format)
  if (!task && allData.length > 0) {
    try {
      const tasksUrl = buildVersionedUrl(repoId, version, "meta/tasks.jsonl");
      const tasksResponse = await fetch(tasksUrl);

      if (tasksResponse.ok) {
        const tasksText = await tasksResponse.text();
        // Parse JSONL format (one JSON object per line)
        const tasksData = tasksText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

        if (tasksData && tasksData.length > 0) {
          const taskIndex = allData[0].task_index;

          // Convert BigInt to number for comparison
          const taskIndexNum =
            typeof taskIndex === "bigint" ? Number(taskIndex) : taskIndex;

          // Find task by task_index
          const taskData = tasksData.find((t) => t.task_index === taskIndexNum);
          if (taskData) {
            task = taskData.task;
          }
        }
      }
    } catch {
      // No tasks metadata file for this v2.x dataset
    }
  }

  const data = await readParquetColumn(arrayBuffer, filteredColumnNames);
  // Flatten and map to array of objects for chartData
  const seriesNames = [
    "timestamp",
    ...columns.map(({ value }) => value).flat(),
  ];

  const chartData = data.map((row) => {
    const flatRow = row.flat();
    const obj: Record<string, number> = {};
    seriesNames.forEach((key, idx) => {
      const value = flatRow[idx];
      obj[key] = typeof value === "number" ? value : Number(value) || 0;
    });
    return obj;
  });

  // List of columns that are ignored (e.g., 2D or 3D data)
  const ignoredColumns = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) && value.shape.length > 1,
    )
    .map(([key]) => key);

  // Process chart data into organized groups using utility function
  const chartGroups = processChartDataGroups(seriesNames, chartData);

  const duration = chartData[chartData.length - 1].timestamp;

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

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
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
  // Create dataset info structure (like v2.x)
  const datasetInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
  };

  // Generate episodes list based on total_episodes from dataset info
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
  const { chartDataGroups, ignoredColumns, task } = await loadEpisodeDataV3(
    repoId,
    version,
    info,
    episodeMetadata,
  );

  // Calculate duration from episode length and FPS if available
  const episodeLength = bigIntToNumber(episodeMetadata.length);
  const duration = episodeLength
    ? episodeLength / info.fps
    : (episodeMetadata.video_to_timestamp || 0) -
      (episodeMetadata.video_from_timestamp || 0);

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
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
  chartDataGroups: ChartDataGroup[];
  ignoredColumns: string[];
  task?: string;
}> {
  // Build data file path using chunk and file indices
  const dataChunkIndex = bigIntToNumber(episodeMetadata.data_chunk_index, 0);
  const dataFileIndex = bigIntToNumber(episodeMetadata.data_file_index, 0);
  const dataPath = buildV3DataPath(dataChunkIndex, dataFileIndex);

  try {
    const dataUrl = buildVersionedUrl(repoId, version, dataPath);
    const arrayBuffer = await fetchParquetFile(dataUrl);
    const fullData = await readParquetAsObjects(arrayBuffer, []);

    // Extract the episode-specific data slice
    // Convert BigInt to number if needed
    const fromIndex = Number(episodeMetadata.dataset_from_index || 0);
    const toIndex = Number(episodeMetadata.dataset_to_index || fullData.length);

    // Find the starting index of this parquet file by checking the first row's index
    // This handles the case where episodes are split across multiple parquet files
    let fileStartIndex = 0;
    if (fullData.length > 0 && fullData[0].index !== undefined) {
      fileStartIndex = Number(fullData[0].index);
    }

    // Adjust indices to be relative to this file's starting position
    const localFromIndex = Math.max(0, fromIndex - fileStartIndex);
    const localToIndex = Math.min(fullData.length, toIndex - fileStartIndex);

    const episodeData = fullData.slice(localFromIndex, localToIndex);

    if (episodeData.length === 0) {
      return { chartDataGroups: [], ignoredColumns: [], task: undefined };
    }

    // Convert to the same format as v2.x for compatibility with existing chart code
    const { chartDataGroups, ignoredColumns } = processEpisodeDataForCharts(
      episodeData,
      info,
      episodeMetadata,
    );

    // First check for language_instruction fields in the data (preferred)
    // Check multiple rows: first, middle, and last
    const sampleIndices = [
      0,
      Math.floor(episodeData.length / 2),
      episodeData.length - 1,
    ];
    let task = extractLanguageInstructions(episodeData, sampleIndices);

    // If no language instructions found, fall back to tasks metadata
    if (!task) {
      try {
        // Load tasks metadata
        const tasksUrl = buildVersionedUrl(
          repoId,
          version,
          "meta/tasks.parquet",
        );
        const tasksArrayBuffer = await fetchParquetFile(tasksUrl);
        const tasksData = await readParquetAsObjects(tasksArrayBuffer, []);

        if (
          episodeData.length > 0 &&
          tasksData &&
          tasksData.length > 0 &&
          "task_index" in episodeData[0]
        ) {
          const taskIndex = episodeData[0].task_index;

          // Convert BigInt to number for comparison
          const taskIndexNum =
            typeof taskIndex === "bigint"
              ? Number(taskIndex)
              : typeof taskIndex === "number"
                ? taskIndex
                : undefined;

          // Look up task by index
          if (
            taskIndexNum !== undefined &&
            taskIndexNum >= 0 &&
            taskIndexNum < tasksData.length
          ) {
            const taskData = tasksData[taskIndexNum];
            // Extract task from various possible fields
            if (
              taskData &&
              "__index_level_0__" in taskData &&
              typeof taskData.__index_level_0__ === "string"
            ) {
              task = taskData.__index_level_0__;
            } else if (
              taskData &&
              "task" in taskData &&
              typeof taskData.task === "string"
            ) {
              task = taskData.task;
            }
          }
        }
      } catch {
        // Could not load tasks metadata - dataset might not have language tasks
      }
    }

    return { chartDataGroups, ignoredColumns, task };
  } catch {
    return { chartDataGroups: [], ignoredColumns: [], task: undefined };
  }
}

// Process episode data for charts (v3.0 compatible)
function processEpisodeDataForCharts(
  episodeData: Record<string, unknown>[],
  info: DatasetMetadata,
  episodeMetadata?: EpisodeMetadataV3,
): { chartDataGroups: ChartDataGroup[]; ignoredColumns: string[] } {
  // Get numeric column features (not currently used but kept for reference)
  // const columnNames = Object.entries(info.features)
  //   .filter(
  //     ([, value]) =>
  //       ["float32", "int32"].includes(value.dtype) &&
  //       value.shape.length === 1,
  //   )
  //   .map(([key, value]) => ({ key, value }));

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
  const columns = Object.entries(info.features)
    .filter(
      ([key, value]) =>
        ["float32", "int32"].includes(value.dtype) &&
        value.shape.length === 1 &&
        !excludedColumns.includes(key),
    )
    .map(([key, feature]) => {
      let column_names = feature.names;
      while (typeof column_names === "object") {
        if (Array.isArray(column_names)) break;
        column_names = Object.values(column_names ?? {})[0];
      }
      return {
        key,
        value: Array.isArray(column_names)
          ? column_names.map(
              (name) => `${key}${CHART_CONFIG.SERIES_NAME_DELIMITER}${name}`,
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

  // Utility function to group row keys by suffix (same as V2.1)
  function groupRowBySuffix(row: Record<string, number>): {
    timestamp: number;
    [key: string]: number | Record<string, number>;
  } {
    const result: {
      timestamp: number;
      [key: string]: number | Record<string, number>;
    } = {
      timestamp: 0,
    };
    const suffixGroups: Record<string, Record<string, number>> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "timestamp") {
        result.timestamp = value;
        continue;
      }
      const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
      if (parts.length === 2) {
        const [prefix, suffix] = parts;
        if (!suffixGroups[suffix]) suffixGroups[suffix] = {};
        suffixGroups[suffix][prefix] = value;
      } else {
        result[key] = value;
      }
    }
    for (const [suffix, group] of Object.entries(suffixGroups)) {
      const keys = Object.keys(group);
      if (keys.length === 1) {
        // Use the full original name as the key
        const fullName = `${keys[0]}${CHART_CONFIG.SERIES_NAME_DELIMITER}${suffix}`;
        result[fullName] = group[keys[0]];
      } else {
        result[suffix] = group;
      }
    }
    return result;
  }

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

  return { chartDataGroups, ignoredColumns };
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

    let chunkIndex, fileIndex, segmentStart, segmentEnd;

    if (cameraSpecificKeys.length > 0) {
      // Use camera-specific metadata
      const chunkValue = episodeMetadata[`videos/${videoKey}/chunk_index`];
      const fileValue = episodeMetadata[`videos/${videoKey}/file_index`];
      chunkIndex = bigIntToNumber(chunkValue, 0);
      fileIndex = bigIntToNumber(fileValue, 0);
      segmentStart = episodeMetadata[`videos/${videoKey}/from_timestamp`] || 0;
      segmentEnd = episodeMetadata[`videos/${videoKey}/to_timestamp`] || 30;
    } else {
      // Fallback to generic video metadata
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
      const episodeData: Record<string, number | bigint | undefined> = {
        episode_index: bigIntToNumber(row["episode_index"], 0),
        data_chunk_index: bigIntToNumber(row["data/chunk_index"], 0),
        data_file_index: bigIntToNumber(row["data/file_index"], 0),
        dataset_from_index: bigIntToNumber(row["dataset_from_index"], 0),
        dataset_to_index: bigIntToNumber(row["dataset_to_index"], 0),
        length: bigIntToNumber(row["length"], 0),
      };

      // Handle video metadata - look for video-specific keys
      const videoKeys = Object.keys(row).filter(
        (key) => key.includes("videos/") && key.includes("/chunk_index"),
      );
      if (videoKeys.length > 0) {
        // Use the first video stream for basic info
        const firstVideoKey = videoKeys[0];
        const videoBaseName = firstVideoKey.replace("/chunk_index", "");

        episodeData.video_chunk_index = bigIntToNumber(
          row[`${videoBaseName}/chunk_index`],
          0,
        );
        episodeData.video_file_index = bigIntToNumber(
          row[`${videoBaseName}/file_index`],
          0,
        );
        episodeData.video_from_timestamp = bigIntToNumber(
          row[`${videoBaseName}/from_timestamp`],
          0,
        );
        episodeData.video_to_timestamp = bigIntToNumber(
          row[`${videoBaseName}/to_timestamp`],
          0,
        );
      } else {
        // Fallback video values
        episodeData.video_chunk_index = 0;
        episodeData.video_file_index = 0;
        episodeData.video_from_timestamp = 0;
        episodeData.video_to_timestamp = 30;
      }

      // Store the raw row data to preserve per-camera metadata
      // This allows extractVideoInfoV3WithSegmentation to access camera-specific timestamps
      Object.keys(row).forEach((key) => {
        if (key.startsWith("videos/")) {
          episodeData[key] = bigIntToNumber(row[key]);
        }
      });

      return episodeData as EpisodeMetadataV3;
    } else {
      // Fallback to numeric keys for compatibility
      return {
        episode_index: bigIntToNumber(row["0"], 0),
        data_chunk_index: bigIntToNumber(row["1"], 0),
        data_file_index: bigIntToNumber(row["2"], 0),
        dataset_from_index: bigIntToNumber(row["3"], 0),
        dataset_to_index: bigIntToNumber(row["4"], 0),
        video_chunk_index: bigIntToNumber(row["5"], 0),
        video_file_index: bigIntToNumber(row["6"], 0),
        video_from_timestamp: bigIntToNumber(row["7"], 0),
        video_to_timestamp: bigIntToNumber(row["8"], 30),
        length: bigIntToNumber(row["9"], 30),
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

// Safe wrapper for UI error display
export async function getEpisodeDataSafe(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<{ data?: EpisodeData; error?: string }> {
  try {
    const data = await getEpisodeData(org, dataset, episodeId);
    return { data };
  } catch (err) {
    // Only expose the error message, not stack or sensitive info
    const errorMessage =
      err instanceof Error ? err.message : String(err) || "Unknown error";
    return { error: errorMessage };
  }
}

import {
  DatasetMetadata,
  fetchParquetFile,
  formatStringWithVars,
  readParquetAsObjects,
} from "@/utils/parquetUtils";
import { pick } from "@/utils/pick";
import { getDatasetVersionAndInfo, buildVersionedUrl } from "@/utils/versionUtils";
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

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;

export type VideoInfo = {
  filename: string;
  url: string;
  isSegmented?: boolean;
  segmentStart?: number;
  segmentEnd?: number;
  segmentDuration?: number;
};

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

type AdjacentEpisodeVideos = {
  episodeId: number;
  videosInfo: VideoInfo[];
};

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
    const result = version === "v3.0"
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
      dataset_size_mb: Math.round(((rawInfo.data_files_size_in_mb ?? 0) + (rawInfo.video_files_size_in_mb ?? 0)) * 10) / 10,
      cameras,
    };

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
        ? column_names.map((name: string) => `${key}${SERIES_NAME_DELIMITER}${name}`)
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
  const allData = await readParquetAsObjects(arrayBuffer, []);
  
  // Extract task from language_instruction fields, task field, or tasks.jsonl
  let task: string | undefined;
  
  if (allData.length > 0) {
    const firstRow = allData[0];
    const languageInstructions: string[] = [];
    
    if (typeof firstRow.language_instruction === 'string') {
      languageInstructions.push(firstRow.language_instruction);
    }
    
    let instructionNum = 2;
    while (typeof firstRow[`language_instruction_${instructionNum}`] === 'string') {
      languageInstructions.push(firstRow[`language_instruction_${instructionNum}`] as string);
      instructionNum++;
    }
    
    if (languageInstructions.length > 0) {
      task = languageInstructions.join('\n');
    }
  }
  
  if (!task && allData.length > 0 && typeof allData[0].task === 'string') {
    task = allData[0].task;
  }
  
  if (!task && allData.length > 0) {
    try {
      const tasksUrl = buildVersionedUrl(repoId, version, "meta/tasks.jsonl");
      const tasksResponse = await fetch(tasksUrl);
      
      if (tasksResponse.ok) {
        const tasksText = await tasksResponse.text();
        const tasksData = tasksText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        
        if (tasksData && tasksData.length > 0) {
          const taskIndex = allData[0].task_index;
          const taskIndexNum = typeof taskIndex === 'bigint' ? Number(taskIndex) : taskIndex;
          const taskData = tasksData.find((t: Record<string, unknown>) => t.task_index === taskIndexNum);
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
    flatChartData: chartData,
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
  const { chartDataGroups, flatChartData, ignoredColumns, task } = await loadEpisodeDataV3(repoId, version, info, episodeMetadata);

  const duration = episodeMetadata.length ? episodeMetadata.length / info.fps : 
                   (episodeMetadata.video_to_timestamp - episodeMetadata.video_from_timestamp);

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
): Promise<{ chartDataGroups: ChartRow[][]; flatChartData: Record<string, number>[]; ignoredColumns: string[]; task?: string }> {
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
      return { chartDataGroups: [], flatChartData: [], ignoredColumns: [], task: undefined };
    }
    
    // Convert to the same format as v2.x for compatibility with existing chart code
    const { chartDataGroups, flatChartData, ignoredColumns } = processEpisodeDataForCharts(episodeData, info, episodeMetadata);
    
    // First check for language_instruction fields in the data (preferred)
    let task: string | undefined;
    if (episodeData.length > 0) {
      const languageInstructions: string[] = [];
      
      const extractInstructions = (row: Record<string, unknown>) => {
        if (typeof row.language_instruction === 'string') {
          languageInstructions.push(row.language_instruction);
        }
        let num = 2;
        while (typeof row[`language_instruction_${num}`] === 'string') {
          languageInstructions.push(row[`language_instruction_${num}`] as string);
          num++;
        }
      };

      extractInstructions(episodeData[0]);
      
      // If no instructions in first row, check middle and last rows
      if (languageInstructions.length === 0 && episodeData.length > 1) {
        for (const idx of [Math.floor(episodeData.length / 2), episodeData.length - 1]) {
          extractInstructions(episodeData[idx]);
          if (languageInstructions.length > 0) break;
        }
      }
      
      if (languageInstructions.length > 0) {
        task = languageInstructions.join('\n');
      }
    }
    
    // Fall back to tasks metadata parquet
    if (!task && episodeData.length > 0) {
      try {
        const tasksUrl = buildVersionedUrl(repoId, version, "meta/tasks.parquet");
        const tasksArrayBuffer = await fetchParquetFile(tasksUrl);
        const tasksData = await readParquetAsObjects(tasksArrayBuffer, []);
        
        if (tasksData.length > 0) {
          const taskIndex = episodeData[0].task_index;
          const taskIndexNum = typeof taskIndex === 'bigint' ? Number(taskIndex) : 
                               typeof taskIndex === 'number' ? taskIndex : undefined;
          
          if (taskIndexNum !== undefined && taskIndexNum < tasksData.length) {
            const taskData = tasksData[taskIndexNum];
            const rawTask = taskData.__index_level_0__ ?? taskData.task;
            task = typeof rawTask === 'string' ? rawTask : undefined;
          }
        }
      } catch {
        // Could not load tasks metadata
      }
    }
    
    return { chartDataGroups, flatChartData, ignoredColumns, task };
  } catch {
    return { chartDataGroups: [], flatChartData: [], ignoredColumns: [], task: undefined };
  }
}

// Process episode data for charts (v3.0 compatible)
function processEpisodeDataForCharts(
  episodeData: Record<string, unknown>[],
  info: DatasetMetadata,
  episodeMetadata?: EpisodeMetadataV3,
): { chartDataGroups: ChartRow[][]; flatChartData: Record<string, number>[]; ignoredColumns: string[] } {
  
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
    .filter(([key, value]) => 
      ["float32", "int32"].includes(value.dtype) && 
      value.shape.length === 1 && 
      !excludedColumns.includes(key)
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
          ? column_names.map((name: string) => `${key}${SERIES_NAME_DELIMITER}${name}`)
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
    
    let chunkIndex: number, fileIndex: number, segmentStart: number, segmentEnd: number;
    
    const toNum = (v: string | number): number => typeof v === 'string' ? parseFloat(v) || 0 : v;

    if (cameraSpecificKeys.length > 0) {
      chunkIndex = toNum(episodeMetadata[`videos/${videoKey}/chunk_index`]);
      fileIndex = toNum(episodeMetadata[`videos/${videoKey}/file_index`]);
      segmentStart = toNum(episodeMetadata[`videos/${videoKey}/from_timestamp`]) || 0;
      segmentEnd = toNum(episodeMetadata[`videos/${videoKey}/to_timestamp`]) || 30;
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
function parseEpisodeRowSimple(row: Record<string, unknown>): EpisodeMetadataV3 {
  // v3.0 uses named keys in the episode metadata
  if (row && typeof row === "object") {
    // Check if this is v3.0 format with named keys
    if ("episode_index" in row) {
      // v3.0 format - use named keys
      // Convert BigInt values to numbers
      const toBigIntSafe = (value: unknown): number => {
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return parseInt(value) || 0;
        return 0;
      };
      
      const toNumSafe = (value: unknown): number => {
        if (typeof value === 'number') return value;
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'string') return parseFloat(value) || 0;
        return 0;
      };

      // Handle video metadata - look for video-specific keys
      const videoKeys = Object.keys(row).filter(key => key.includes('videos/') && key.includes('/chunk_index'));
      let videoChunkIndex = 0, videoFileIndex = 0, videoFromTs = 0, videoToTs = 30;
      if (videoKeys.length > 0) {
        const videoBaseName = videoKeys[0].replace('/chunk_index', '');
        videoChunkIndex = toBigIntSafe(row[`${videoBaseName}/chunk_index`]);
        videoFileIndex = toBigIntSafe(row[`${videoBaseName}/file_index`]);
        videoFromTs = toNumSafe(row[`${videoBaseName}/from_timestamp`]);
        videoToTs = toNumSafe(row[`${videoBaseName}/to_timestamp`]) || 30;
      }

      const episodeData: EpisodeMetadataV3 = {
        episode_index: toBigIntSafe(row['episode_index']),
        data_chunk_index: toBigIntSafe(row['data/chunk_index']),
        data_file_index: toBigIntSafe(row['data/file_index']),
        dataset_from_index: toBigIntSafe(row['dataset_from_index']),
        dataset_to_index: toBigIntSafe(row['dataset_to_index']),
        length: toBigIntSafe(row['length']),
        video_chunk_index: videoChunkIndex,
        video_file_index: videoFileIndex,
        video_from_timestamp: videoFromTs,
        video_to_timestamp: videoToTs,
      };
      
      // Store per-camera metadata for extractVideoInfoV3WithSegmentation
      Object.keys(row).forEach(key => {
        if (key.startsWith('videos/')) {
          const val = row[key];
          episodeData[key] = typeof val === 'bigint' ? Number(val) : (typeof val === 'number' || typeof val === 'string' ? val : 0);
        }
      });
      
      return episodeData as EpisodeMetadataV3;
    } else {
      // Fallback to numeric keys for compatibility
      const toNum = (v: unknown, fallback = 0): number =>
        typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : fallback;
      return {
        episode_index: toNum(row['0']),
        data_chunk_index: toNum(row['1']),
        data_file_index: toNum(row['2']),
        dataset_from_index: toNum(row['3']),
        dataset_to_index: toNum(row['4']),
        video_chunk_index: toNum(row['5']),
        video_file_index: toNum(row['6']),
        video_from_timestamp: toNum(row['7']),
        video_to_timestamp: toNum(row['8'], 30),
        length: toNum(row['9'], 30),
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
export function computeColumnMinMax(chartDataGroups: ChartRow[][]): ColumnMinMax[] {
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
          allEpisodes.push({ index: parsed.episode_index, length: parsed.length });
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

    const sortedByLength = [...withSeconds].sort((a, b) => a.lengthSeconds - b.lengthSeconds);
    const shortestEpisodes = sortedByLength.slice(0, 5);
    const longestEpisodes = sortedByLength.slice(-5).reverse();

    const lengths = withSeconds.map((e) => e.lengthSeconds);
    const sum = lengths.reduce((a, b) => a + b, 0);
    const mean = Math.round((sum / lengths.length) * 100) / 100;

    const sorted = [...lengths].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
      : sorted[mid];

    const variance = lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length;
    const std = Math.round(Math.sqrt(variance) * 100) / 100;

    // Build histogram
    const histMin = Math.min(...lengths);
    const histMax = Math.max(...lengths);

    if (histMax === histMin) {
      return {
        shortestEpisodes, longestEpisodes, allEpisodeLengths: withSeconds,
        meanEpisodeLength: mean, medianEpisodeLength: median, stdEpisodeLength: std,
        episodeLengthHistogram: [{ binLabel: `${histMin.toFixed(1)}s`, count: lengths.length }],
      };
    }

    const p1 = sorted[Math.floor(sorted.length * 0.01)];
    const p99 = sorted[Math.ceil(sorted.length * 0.99) - 1];
    const range = (p99 - p1) || 1;

    const targetBins = Math.max(10, Math.min(50, Math.ceil(Math.log2(lengths.length) + 1)));
    const rawBinWidth = range / targetBins;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawBinWidth)));
    const niceSteps = [1, 2, 2.5, 5, 10];
    const niceBinWidth = niceSteps.map((s) => s * magnitude).find((w) => w >= rawBinWidth) ?? rawBinWidth;

    const niceMin = Math.floor(p1 / niceBinWidth) * niceBinWidth;
    const niceMax = Math.ceil(p99 / niceBinWidth) * niceBinWidth;
    const actualBinCount = Math.max(1, Math.round((niceMax - niceMin) / niceBinWidth));
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
      shortestEpisodes, longestEpisodes, allEpisodeLengths: withSeconds,
      meanEpisodeLength: mean, medianEpisodeLength: median, stdEpisodeLength: std,
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
  const videoFeatures = Object.entries(info.features).filter(([, f]) => f.dtype === "video");
  if (videoFeatures.length === 0) return { cameras: [], framesByCamera: {} };

  const cameras = videoFeatures.map(([key]) => key);
  const framesByCamera: Record<string, EpisodeFrameInfo[]> = {};
  for (const cam of cameras) framesByCamera[cam] = [];

  if (version === "v3.0") {
    let fileIndex = 0;
    while (true) {
      const path = `meta/episodes/chunk-000/file-${fileIndex.toString().padStart(3, "0")}.parquet`;
      try {
        const buf = await fetchParquetFile(buildVersionedUrl(repoId, version, path));
        const rows = await readParquetAsObjects(buf, []);
        if (rows.length === 0 && fileIndex > 0) break;
        for (const row of rows) {
          const epIdx = Number(row["episode_index"] ?? 0);
          for (const cam of cameras) {
            const cIdx = Number(row[`videos/${cam}/chunk_index`] ?? row["video_chunk_index"] ?? 0);
            const fIdx = Number(row[`videos/${cam}/file_index`] ?? row["video_file_index"] ?? 0);
            const fromTs = Number(row[`videos/${cam}/from_timestamp`] ?? row["video_from_timestamp"] ?? 0);
            const toTs = Number(row[`videos/${cam}/to_timestamp`] ?? row["video_to_timestamp"] ?? 30);
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

export type LowMovementEpisode = { episodeIndex: number; totalMovement: number };

export type AggVelocityStat = {
  name: string;
  std: number;
  maxAbs: number;
  bins: number[];
  lo: number;
  hi: number;
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
  maxEpisodes = 500,
  numTimeBins = 50,
): Promise<CrossEpisodeVarianceData | null> {
  const actionEntry = Object.entries(info.features)
    .find(([key, f]) => key === "action" && f.shape.length === 1);
  if (!actionEntry) {
    console.warn("[cross-ep] No action feature found. Available features:", Object.entries(info.features).map(([k, f]) => `${k}(${f.dtype}, shape=${JSON.stringify(f.shape)})`).join(", "));
    return null;
  }

  const [actionKey, actionMeta] = actionEntry;
  const actionDim = actionMeta.shape[0];

  let names: unknown = actionMeta.names;
  while (typeof names === "object" && names !== null && !Array.isArray(names)) {
    names = Object.values(names)[0];
  }
  const actionNames = Array.isArray(names)
    ? (names as string[]).map(n => `${actionKey}${SERIES_NAME_DELIMITER}${n}`)
    : Array.from({ length: actionDim }, (_, i) => `${actionKey}${SERIES_NAME_DELIMITER}${i}`);

  // State feature for alignment computation
  const stateEntry = Object.entries(info.features)
    .find(([key, f]) => key === "observation.state" && f.shape.length === 1);
  const stateKey = stateEntry?.[0] ?? null;
  const stateDim = stateEntry?.[1].shape[0] ?? 0;

  // Collect episode metadata
  type EpMeta = { index: number; chunkIdx: number; fileIdx: number; from: number; to: number };
  const allEps: EpMeta[] = [];

  if (version === "v3.0") {
    let fileIndex = 0;
    while (true) {
      const path = `meta/episodes/chunk-000/file-${fileIndex.toString().padStart(3, "0")}.parquet`;
      try {
        const buf = await fetchParquetFile(buildVersionedUrl(repoId, version, path));
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
      } catch { break; }
    }
  } else {
    for (let i = 0; i < info.total_episodes; i++) {
      allEps.push({ index: i, chunkIdx: 0, fileIdx: 0, from: 0, to: 0 });
    }
  }

  if (allEps.length < 2) {
    console.warn(`[cross-ep] Only ${allEps.length} episode(s) found in metadata, need ≥2`);
    return null;
  }
  console.log(`[cross-ep] Found ${allEps.length} episodes in metadata, sampling up to ${maxEpisodes}`);

  // Sample episodes evenly
  const sampled = allEps.length <= maxEpisodes
    ? allEps
    : Array.from({ length: maxEpisodes }, (_, i) =>
        allEps[Math.round((i * (allEps.length - 1)) / (maxEpisodes - 1))]
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
        const buf = await fetchParquetFile(buildVersionedUrl(repoId, version, dataPath));
        const rows = await readParquetAsObjects(buf, []);
        const fileStart = rows.length > 0 && rows[0].index !== undefined ? Number(rows[0].index) : 0;

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
            episodeActions.push({ index: ep.index, actions });
            episodeStates.push(stateKey && states.length === actions.length ? states : null);
          }
        }
      } catch { /* skip file */ }
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
        const buf = await fetchParquetFile(buildVersionedUrl(repoId, version, dataPath));
        const rows = await readParquetAsObjects(buf, []);
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
          episodeActions.push({ index: ep.index, actions });
          episodeStates.push(stateKey && states.length === actions.length ? states : null);
        }
      } catch { /* skip */ }
    }
  }

  if (episodeActions.length < 2) {
    console.warn(`[cross-ep] Only ${episodeActions.length} episode(s) had loadable action data out of ${sampled.length} sampled`);
    return null;
  }
  console.log(`[cross-ep] Loaded action data for ${episodeActions.length}/${sampled.length} episodes`);

  // Resample each episode to numTimeBins and compute variance
  const timeBins = Array.from({ length: numTimeBins }, (_, i) => i / (numTimeBins - 1));
  const sums = Array.from({ length: numTimeBins }, () => new Float64Array(actionDim));
  const sumsSq = Array.from({ length: numTimeBins }, () => new Float64Array(actionDim));
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
      if (n < 2) { row.push(0); continue; }
      const mean = sums[b][d] / n;
      row.push(sumsSq[b][d] / n - mean * mean);
    }
    variance.push(row);
  }

  // Per-episode average movement per frame: mean L2 norm of frame-to-frame action deltas
  const movementScores: LowMovementEpisode[] = episodeActions.map(({ index, actions: ep }) => {
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
    return { episodeIndex: index, totalMovement: Math.round(avgPerFrame * 10000) / 10000 };
  });

  movementScores.sort((a, b) => a.totalMovement - b.totalMovement);
  const lowMovementEpisodes = movementScores.slice(0, 10);

  // Aggregated velocity stats: pool deltas from all episodes
  const shortName = (k: string) => { const p = k.split(SERIES_NAME_DELIMITER); return p.length > 1 ? p[p.length - 1] : k; };

  const aggVelocity: AggVelocityStat[] = (() => {
    const binCount = 30;
    return Array.from({ length: actionDim }, (_, d) => {
      const deltas: number[] = [];
      for (const { actions: ep } of episodeActions) {
        for (let t = 1; t < ep.length; t++) {
          deltas.push((ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0));
        }
      }
      if (deltas.length === 0) return { name: shortName(actionNames[d]), std: 0, maxAbs: 0, bins: [], lo: 0, hi: 0 };
      let sum = 0, maxAbs = 0, lo = Infinity, hi = -Infinity;
      for (const v of deltas) { sum += v; const a = Math.abs(v); if (a > maxAbs) maxAbs = a; if (v < lo) lo = v; if (v > hi) hi = v; }
      const mean = sum / deltas.length;
      let varSum = 0; for (const v of deltas) varSum += (v - mean) ** 2;
      const std = Math.sqrt(varSum / deltas.length);
      const range = hi - lo || 1;
      const binW = range / binCount;
      const bins = new Array(binCount).fill(0);
      for (const v of deltas) { let b = Math.floor((v - lo) / binW); if (b >= binCount) b = binCount - 1; bins[b]++; }
      return { name: shortName(actionNames[d]), std, maxAbs, bins, lo, hi };
    });
  })();

  // Aggregated autocorrelation: average per-episode ACFs
  const aggAutocorrelation: AggAutocorrelation | null = (() => {
    const maxLag = Math.min(100, Math.floor(
      episodeActions.reduce((min, e) => Math.min(min, e.actions.length), Infinity) / 2
    ));
    if (maxLag < 2) return null;

    const avgAcf: number[][] = Array.from({ length: actionDim }, () => new Array(maxLag).fill(0));
    let epCount = 0;

    for (const { actions: ep } of episodeActions) {
      if (ep.length < maxLag * 2) continue;
      epCount++;
      for (let d = 0; d < actionDim; d++) {
        const vals = ep.map(row => row[d] ?? 0);
        const n = vals.length;
        const m = vals.reduce((a, b) => a + b, 0) / n;
        const centered = vals.map(v => v - m);
        const vari = centered.reduce((a, v) => a + v * v, 0);
        if (vari === 0) continue;
        for (let lag = 1; lag <= maxLag; lag++) {
          let s = 0;
          for (let t = 0; t < n - lag; t++) s += centered[t] * centered[t + lag];
          avgAcf[d][lag - 1] += s / vari;
        }
      }
    }

    if (epCount === 0) return null;
    for (let d = 0; d < actionDim; d++) for (let l = 0; l < maxLag; l++) avgAcf[d][l] /= epCount;

    const shortKeys = actionNames.map(shortName);
    const chartData = Array.from({ length: maxLag }, (_, lag) => {
      const row: Record<string, number> = { lag: lag + 1, time: (lag + 1) / fps };
      shortKeys.forEach((k, d) => { row[k] = avgAcf[d][lag]; });
      return row;
    });

    // Suggested chunk: median lag where ACF drops below 0.5
    const lags = avgAcf.map(acf => { const i = acf.findIndex(v => v < 0.5); return i >= 0 ? i + 1 : null; }).filter(Boolean) as number[];
    const suggestedChunk = lags.length > 0 ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null;

    return { chartData, suggestedChunk, shortKeys };
  })();

  // Per-episode jerkiness: mean |Δa| across all dimensions
  const jerkyEpisodes: JerkyEpisode[] = episodeActions.map(({ index, actions: ep }) => {
    let sum = 0, count = 0;
    for (let t = 1; t < ep.length; t++) {
      for (let d = 0; d < actionDim; d++) {
        sum += Math.abs((ep[t][d] ?? 0) - (ep[t - 1][d] ?? 0));
        count++;
      }
    }
    return { episodeIndex: index, meanAbsDelta: count > 0 ? sum / count : 0 };
  }).sort((a, b) => b.meanAbsDelta - a.meanAbsDelta);

  // Speed distribution: all episode movement scores (not just lowest 10)
  const speedDistribution: SpeedDistEntry[] = movementScores.map(s => ({
    episodeIndex: s.episodeIndex,
    speed: s.totalMovement,
  }));

  // Aggregated state-action alignment across episodes
  const aggAlignment: AggAlignment | null = (() => {
    if (!stateKey || stateDim === 0) return null;

    let sNms: unknown = stateEntry![1].names;
    while (typeof sNms === "object" && sNms !== null && !Array.isArray(sNms)) sNms = Object.values(sNms)[0];
    const stateNames = Array.isArray(sNms)
      ? (sNms as string[])
      : Array.from({ length: stateDim }, (_, i) => `${i}`);
    const actionSuffixes = actionNames.map(n => { const p = n.split(SERIES_NAME_DELIMITER); return p[p.length - 1]; });

    // Match pairs by suffix, fall back to index
    const pairs: [number, number][] = [];
    for (let ai = 0; ai < actionDim; ai++) {
      const si = stateNames.findIndex(s => s === actionSuffixes[ai]);
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
        const aVals = actions.slice(0, n).map(r => r[ai] ?? 0);
        const sDeltas = Array.from({ length: n - 1 }, (_, t) => (states[t + 1][si] ?? 0) - (states[t][si] ?? 0));
        const effN = Math.min(aVals.length, sDeltas.length);
        const aM = aVals.slice(0, effN).reduce((a, b) => a + b, 0) / effN;
        const sM = sDeltas.slice(0, effN).reduce((a, b) => a + b, 0) / effN;

        for (let li = 0; li < numLags; li++) {
          const lag = -maxLag + li;
          let sum = 0, aV = 0, sV = 0;
          for (let t = 0; t < effN; t++) {
            const sIdx = t + lag;
            if (sIdx < 0 || sIdx >= sDeltas.length) continue;
            const a = aVals[t] - aM, s = sDeltas[sIdx] - sM;
            sum += a * s; aV += a * a; sV += s * s;
          }
          const d = Math.sqrt(aV * sV);
          if (d > 0) { corrSums[pi][li] += sum / d; corrCounts[pi][li]++; }
        }
      }
    }

    const avgCorrs = pairs.map((_, pi) =>
      Array.from({ length: numLags }, (_, li) =>
        corrCounts[pi][li] > 0 ? corrSums[pi][li] / corrCounts[pi][li] : 0
      )
    );

    const ccData = Array.from({ length: numLags }, (_, li) => {
      const lag = -maxLag + li;
      const vals = avgCorrs.map(pc => pc[li]);
      return { lag, max: Math.max(...vals), mean: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals) };
    });

    let meanPeakLag = 0, meanPeakCorr = -Infinity;
    let maxPeakLag = 0, maxPeakCorr = -Infinity;
    let minPeakLag = 0, minPeakCorr = -Infinity;
    for (const row of ccData) {
      if (row.max > maxPeakCorr) { maxPeakCorr = row.max; maxPeakLag = row.lag; }
      if (row.mean > meanPeakCorr) { meanPeakCorr = row.mean; meanPeakLag = row.lag; }
      if (row.min > minPeakCorr) { minPeakCorr = row.min; minPeakLag = row.lag; }
    }

    const perPairPeakLags = avgCorrs.map(pc => {
      let best = -Infinity, bestLag = 0;
      for (let li = 0; li < pc.length; li++) { if (pc[li] > best) { best = pc[li]; bestLag = -maxLag + li; } }
      return bestLag;
    });

    return {
      ccData, meanPeakLag, meanPeakCorr, maxPeakLag, maxPeakCorr, minPeakLag, minPeakCorr,
      lagRangeMin: Math.min(...perPairPeakLags), lagRangeMax: Math.max(...perPairPeakLags), numPairs: pairs.length,
    };
  })();

  return {
    actionNames, timeBins, variance, numEpisodes: episodeActions.length,
    lowMovementEpisodes, aggVelocity, aggAutocorrelation,
    speedDistribution, jerkyEpisodes, aggAlignment,
  };
}

// Load only flatChartData for a specific episode (used by URDF viewer episode switching)
export async function loadEpisodeFlatChartData(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
): Promise<Record<string, number>[]> {
  const episodeMetadata = await loadEpisodeMetadataV3Simple(repoId, version, episodeId);
  const { flatChartData } = await loadEpisodeDataV3(repoId, version, info, episodeMetadata);
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

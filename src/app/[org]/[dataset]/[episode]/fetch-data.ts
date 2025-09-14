import {
  DatasetMetadata,
  fetchJson,
  fetchParquetFile,
  formatStringWithVars,
  readParquetColumn,
  readParquetAsObjects,
} from "@/utils/parquetUtils";
import { pick } from "@/utils/pick";
import { getDatasetVersion, buildVersionedUrl } from "@/utils/versionUtils";

const SERIES_NAME_DELIMITER = " | ";

export async function getEpisodeData(
  org: string,
  dataset: string,
  episodeId: number,
) {
  const repoId = `${org}/${dataset}`;
  try {
    // Check for compatible dataset version (v3.0, v2.1, or v2.0)
    const version = await getDatasetVersion(repoId);
    const jsonUrl = buildVersionedUrl(repoId, version, "meta/info.json");
    const info = await fetchJson<DatasetMetadata>(jsonUrl);

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
) {
  const repoId = `${org}/${dataset}`;
  try {
    const version = await getDatasetVersion(repoId);
    const jsonUrl = buildVersionedUrl(repoId, version, "meta/info.json");
    const info = await fetchJson<DatasetMetadata>(jsonUrl);
    
    const totalEpisodes = info.total_episodes;
    const adjacentVideos: Array<{episodeId: number; videosInfo: any[]}> = [];
    
    // Calculate adjacent episode IDs
    for (let offset = -radius; offset <= radius; offset++) {
      if (offset === 0) continue; // Skip current episode
      
      const episodeId = currentEpisodeId + offset;
      if (episodeId >= 0 && episodeId < totalEpisodes) {
        try {
          let videosInfo: any[] = [];
          
          if (version === "v3.0") {
            const episodeMetadata = await loadEpisodeMetadataV3Simple(repoId, version, episodeId);
            videosInfo = extractVideoInfoV3WithSegmentation(repoId, version, info, episodeMetadata);
          } else {
            // For v2.x, use simpler video info extraction
            const episode_chunk = Math.floor(0 / 1000);
            videosInfo = Object.entries(info.features)
              .filter(([, value]) => value.dtype === "video")
              .map(([key]) => {
                const videoPath = formatStringWithVars(info.video_path, {
                  video_key: key,
                  episode_chunk: episode_chunk.toString().padStart(3, "0"),
                  episode_index: episodeId.toString().padStart(6, "0"),
                });
                return {
                  filename: key,
                  url: buildVersionedUrl(repoId, version, videoPath),
                };
              });
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
) {
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
      : process.env.EPISODES
          .split(/\s+/)
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !isNaN(x));

      // Videos information
    const videosInfo = Object.entries(info.features)
      .filter(([, value]) => value.dtype === "video")
      .map(([key]) => {
      const videoPath = formatStringWithVars(info.video_path, {
        video_key: key,
        episode_chunk: episode_chunk.toString().padStart(3, "0"),
        episode_index: episodeId.toString().padStart(6, "0"),
      });
      return {
        filename: key,
        url: buildVersionedUrl(repoId, version, videoPath),
      };
    });

  // Column data
  const columnNames = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) &&
        value.shape.length === 1,
    )
    .map(([key, { shape }]) => ({ key, length: shape[0] }));

  // Exclude specific columns
  const excludedColumns = [
    "timestamp",
    "frame_index",
    "episode_index",
    "index",
    "task_index",
  ];
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
        ? column_names.map((name) => `${key}${SERIES_NAME_DELIMITER}${name}`)
        : Array.from(
            { length: columnNames.find((c) => c.key === key)?.length ?? 1 },
            (_, i) => `${key}${SERIES_NAME_DELIMITER}${i}`,
          ),
    };
  });

  const parquetUrl = buildVersionedUrl(
    repoId,
    version,
    formatStringWithVars(info.data_path, {
      episode_chunk: episode_chunk.toString().padStart(3, "0"),
      episode_index: episodeId.toString().padStart(6, "0"),
    })
  );

  const arrayBuffer = await fetchParquetFile(parquetUrl);
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
      obj[key] = flatRow[idx];
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

  // 1. Group all numeric keys by suffix (excluding 'timestamp')
  const numericKeys = seriesNames.filter((k) => k !== "timestamp");
  const suffixGroupsMap: Record<string, string[]> = {};
  for (const key of numericKeys) {
    const parts = key.split(SERIES_NAME_DELIMITER);
    const suffix = parts[1] || parts[0]; // fallback to key if no delimiter
    if (!suffixGroupsMap[suffix]) suffixGroupsMap[suffix] = [];
    suffixGroupsMap[suffix].push(key);
  }
  const suffixGroups = Object.values(suffixGroupsMap);

  // 2. Compute min/max for each suffix group as a whole
  const groupStats: Record<string, { min: number; max: number }> = {};
  suffixGroups.forEach((group) => {
    let min = Infinity,
      max = -Infinity;
    for (const row of chartData) {
      for (const key of group) {
        const v = row[key];
        if (typeof v === "number" && !isNaN(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    // Use the first key in the group as the group id
    groupStats[group[0]] = { min, max };
  });

  // 3. Group suffix groups by similar scale (treat each suffix group as a unit)
  const scaleGroups: Record<string, string[][]> = {};
  const used = new Set<string>();
  const SCALE_THRESHOLD = 2;
  for (const group of suffixGroups) {
    const groupId = group[0];
    if (used.has(groupId)) continue;
    const { min, max } = groupStats[groupId];
    if (!isFinite(min) || !isFinite(max)) continue;
    const logMin = Math.log10(Math.abs(min) + 1e-9);
    const logMax = Math.log10(Math.abs(max) + 1e-9);
    const unit: string[][] = [group];
    used.add(groupId);
    for (const other of suffixGroups) {
      const otherId = other[0];
      if (used.has(otherId) || otherId === groupId) continue;
      const { min: omin, max: omax } = groupStats[otherId];
      if (!isFinite(omin) || !isFinite(omax) || omin === omax) continue;
      const ologMin = Math.log10(Math.abs(omin) + 1e-9);
      const ologMax = Math.log10(Math.abs(omax) + 1e-9);
      if (
        Math.abs(logMin - ologMin) <= SCALE_THRESHOLD &&
        Math.abs(logMax - ologMax) <= SCALE_THRESHOLD
      ) {
        unit.push(other);
        used.add(otherId);
      }
    }
    scaleGroups[groupId] = unit;
  }

  // 4. Flatten scaleGroups into chartGroups (array of arrays of keys)
  const chartGroups: string[][] = Object.values(scaleGroups)
    .sort((a, b) => b.length - a.length)
    .flatMap((suffixGroupArr) => {
      // suffixGroupArr is array of suffix groups (each is array of keys)
      const merged = suffixGroupArr.flat();
      if (merged.length > 6) {
        const subgroups = [];
        for (let i = 0; i < merged.length; i += 6) {
          subgroups.push(merged.slice(i, i + 6));
        }
        return subgroups;
      }
      return [merged];
    });

  const duration = chartData[chartData.length - 1].timestamp;

  // Utility: group row keys by suffix
  function groupRowBySuffix(row: Record<string, number>): Record<string, any> {
    const result: Record<string, any> = {};
    const suffixGroups: Record<string, Record<string, number>> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "timestamp") {
        result["timestamp"] = value;
        continue;
      }
      const parts = key.split(SERIES_NAME_DELIMITER);
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
        const fullName = `${keys[0]}${SERIES_NAME_DELIMITER}${suffix}`;
        result[fullName] = group[keys[0]];
      } else {
        result[suffix] = group;
      }
    }
    return result;
  }

  const chartDataGroups = chartGroups.map((group) =>
    chartData.map((row) => groupRowBySuffix(pick(row, [...group, "timestamp"])))
  );

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    ignoredColumns,
    duration,
  };
}

// v3.0 implementation with segmentation support for all episodes
async function getEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeId: number,
) {
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
  const episodeMetadata = await loadEpisodeMetadataV3Simple(repoId, version, episodeId);
  
  // Create video info with segmentation using the metadata
  const videosInfo = extractVideoInfoV3WithSegmentation(repoId, version, info, episodeMetadata);

  // Load episode data for charts
  const { chartDataGroups, ignoredColumns } = await loadEpisodeDataV3(repoId, version, info, episodeMetadata);

  // Calculate duration from episode length and FPS if available
  const duration = episodeMetadata.length ? episodeMetadata.length / info.fps : 
                   (episodeMetadata.video_to_timestamp - episodeMetadata.video_from_timestamp);
  
  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    ignoredColumns,
    duration,
  };
}

// Load episode data for v3.0 charts
async function loadEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: any,
): Promise<{ chartDataGroups: any[]; ignoredColumns: string[] }> {
  // Build data file path using chunk and file indices
  const dataChunkIndex = episodeMetadata.data_chunk_index || 0;
  const dataFileIndex = episodeMetadata.data_file_index || 0;
  const dataPath = `data/chunk-${dataChunkIndex.toString().padStart(3, "0")}/file-${dataFileIndex.toString().padStart(3, "0")}.parquet`;
  
  try {
    const dataUrl = buildVersionedUrl(repoId, version, dataPath);
    const arrayBuffer = await fetchParquetFile(dataUrl);
    const fullData = await readParquetColumn(arrayBuffer, []);
    
    // Extract the episode-specific data slice
    // Convert BigInt to number if needed
    const fromIndex = Number(episodeMetadata.dataset_from_index || 0);
    const toIndex = Number(episodeMetadata.dataset_to_index || fullData.length);
    const episodeData = fullData.slice(fromIndex, toIndex);
    
    if (episodeData.length === 0) {
      return { chartDataGroups: [], ignoredColumns: [] };
    }
    
    // Convert to the same format as v2.x for compatibility with existing chart code
    const { chartDataGroups, ignoredColumns } = processEpisodeDataForCharts(episodeData, info, episodeMetadata);
    
    return { chartDataGroups, ignoredColumns };
  } catch {
    return { chartDataGroups: [], ignoredColumns: [] };
  }
}

// Process episode data for charts (v3.0 compatible)
function processEpisodeDataForCharts(
  episodeData: any[],
  info: DatasetMetadata,
  episodeMetadata?: any,
): { chartDataGroups: any[]; ignoredColumns: string[] } {
  
  // Get numeric column features
  const columnNames = Object.entries(info.features)
    .filter(
      ([, value]) =>
        ["float32", "int32"].includes(value.dtype) &&
        value.shape.length === 1,
    )
    .map(([key, value]) => ({ key, value }));

  // Convert parquet data to chart format
  let seriesNames: string[] = [];
  
  // Create a mapping from numeric indices to feature names for v3.0 data
  const v3IndexToFeatureMap: Record<string, string> = {
    '0': 'observation.state',
    '1': 'action',
    '2': 'timestamp',
    '3': 'episode_index', 
    '4': 'frame_index',
    '5': 'next.reward',
    '6': 'next.done',
    '7': 'index',
    '8': 'task_index'
  };
  
  // Columns to exclude from charts
  const excludedColumns = ['index', 'task_index', 'episode_index', 'frame_index', 'next.done'];

  // Create columns structure similar to V2.1 for proper hierarchical naming
  const columns = Object.entries(info.features)
    .filter(([key, value]) => 
      ["float32", "int32"].includes(value.dtype) && 
      value.shape.length === 1 && 
      !excludedColumns.includes(key)
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
          ? column_names.map((name) => `${key}${SERIES_NAME_DELIMITER}${name}`)
          : Array.from(
              { length: feature.shape[0] || 1 },
              (_, i) => `${key}${SERIES_NAME_DELIMITER}${i}`,
            ),
      };
    });

  // First, extract all series from the first data row to understand the structure
  if (episodeData.length > 0) {
    const firstRow = episodeData[0];
    const allKeys: string[] = [];
    
    Object.entries(firstRow || {}).forEach(([key, value]) => {
      if (key === 'timestamp') return; // Skip timestamp, we'll add it separately
      
      // Map numeric key to feature name if available
      const featureName = v3IndexToFeatureMap[key] || key;
      
      // Skip excluded columns
      if (excludedColumns.includes(featureName)) return;
      
      // Find the matching column definition to get proper names
      const columnDef = columns.find(col => col.key === featureName);
      if (columnDef && Array.isArray(value) && value.length > 0) {
        // Use the proper hierarchical naming from column definition
        columnDef.value.forEach((seriesName, idx) => {
          if (idx < value.length) {
            allKeys.push(seriesName);
          }
        });
      } else if (typeof value === 'number' && !isNaN(value)) {
        // For scalar numeric values
        allKeys.push(featureName);
      } else if (typeof value === 'bigint') {
        // For BigInt values
        allKeys.push(featureName);
      }
    });
    
    seriesNames = ["timestamp", ...allKeys];
  } else {
    // Fallback to column-based approach like V2.1
    seriesNames = [
      "timestamp",
      ...columns.map(({ value }) => value).flat(),
    ];
  }

  const chartData = episodeData.map((row, index) => {
    const obj: Record<string, number> = {};
    
    // Add timestamp aligned with video timing
    // For v3.0, we need to map the episode data index to the actual video duration
    let videoDuration = episodeData.length; // Fallback to data length
    if (episodeMetadata) {
      // Use actual video segment duration if available
      videoDuration = (episodeMetadata.video_to_timestamp || 30) - (episodeMetadata.video_from_timestamp || 0);
    }
    obj["timestamp"] = (index / Math.max(episodeData.length - 1, 1)) * videoDuration;
    
    // Add all data columns using hierarchical naming
    if (row && typeof row === 'object') {
      Object.entries(row).forEach(([key, value]) => {
        if (key === 'timestamp') {
          // Timestamp is already handled above
          return;
        }
        
        // Map numeric key to feature name if available
        const featureName = v3IndexToFeatureMap[key] || key;
        
        // Skip excluded columns
        if (excludedColumns.includes(featureName)) return;
        
        // Find the matching column definition to get proper series names
        const columnDef = columns.find(col => col.key === featureName);
        
        if (Array.isArray(value) && columnDef) {
          // For array values like observation.state and action, use proper hierarchical naming
          value.forEach((val, idx) => {
            if (idx < columnDef.value.length) {
              const seriesName = columnDef.value[idx];
              obj[seriesName] = typeof val === 'number' ? val : Number(val);
            }
          });
        } else if (typeof value === 'number' && !isNaN(value)) {
          obj[featureName] = value;
        } else if (typeof value === 'bigint') {
          obj[featureName] = Number(value);
        } else if (typeof value === 'boolean') {
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
    ...excludedColumns // Also include the manually excluded columns
  ];

  // Group processing logic (using SERIES_NAME_DELIMITER like v2.1)
  const numericKeys = seriesNames.filter((k) => k !== "timestamp");
  const suffixGroupsMap: Record<string, string[]> = {};
  
  for (const key of numericKeys) {
    const parts = key.split(SERIES_NAME_DELIMITER);
    const suffix = parts[1] || parts[0]; // fallback to key if no delimiter
    if (!suffixGroupsMap[suffix]) suffixGroupsMap[suffix] = [];
    suffixGroupsMap[suffix].push(key);
  }
  const suffixGroups = Object.values(suffixGroupsMap);
  

  // Compute min/max for each suffix group
  const groupStats: Record<string, { min: number; max: number }> = {};
  suffixGroups.forEach((group) => {
    let min = Infinity, max = -Infinity;
    for (const row of chartData) {
      for (const key of group) {
        const v = row[key];
        if (typeof v === "number" && !isNaN(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    groupStats[group[0]] = { min, max };
  });

  // Group by similar scale
  const scaleGroups: Record<string, string[][]> = {};
  const used = new Set<string>();
  const SCALE_THRESHOLD = 2;
  for (const group of suffixGroups) {
    const groupId = group[0];
    if (used.has(groupId)) continue;
    const { min, max } = groupStats[groupId];
    if (!isFinite(min) || !isFinite(max)) continue;
    const logMin = Math.log10(Math.abs(min) + 1e-9);
    const logMax = Math.log10(Math.abs(max) + 1e-9);
    const unit: string[][] = [group];
    used.add(groupId);
    for (const other of suffixGroups) {
      const otherId = other[0];
      if (used.has(otherId) || otherId === groupId) continue;
      const { min: omin, max: omax } = groupStats[otherId];
      if (!isFinite(omin) || !isFinite(omax) || omin === omax) continue;
      const ologMin = Math.log10(Math.abs(omin) + 1e-9);
      const ologMax = Math.log10(Math.abs(omax) + 1e-9);
      if (
        Math.abs(logMin - ologMin) <= SCALE_THRESHOLD &&
        Math.abs(logMax - ologMax) <= SCALE_THRESHOLD
      ) {
        unit.push(other);
        used.add(otherId);
      }
    }
    scaleGroups[groupId] = unit;
  }

  // Flatten into chartGroups
  const chartGroups: string[][] = Object.values(scaleGroups)
    .sort((a, b) => b.length - a.length)
    .flatMap((suffixGroupArr) => {
      const merged = suffixGroupArr.flat();
      if (merged.length > 6) {
        const subgroups = [];
        for (let i = 0; i < merged.length; i += 6) {
          subgroups.push(merged.slice(i, i + 6));
        }
        return subgroups;
      }
      return [merged];
    });

  // Utility function to group row keys by suffix (same as V2.1)
  function groupRowBySuffix(row: Record<string, number>): Record<string, any> {
    const result: Record<string, any> = {};
    const suffixGroups: Record<string, Record<string, number>> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "timestamp") {
        result["timestamp"] = value;
        continue;
      }
      const parts = key.split(SERIES_NAME_DELIMITER);
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
        const fullName = `${keys[0]}${SERIES_NAME_DELIMITER}${suffix}`;
        result[fullName] = group[keys[0]];
      } else {
        result[suffix] = group;
      }
    }
    return result;
  }

  const chartDataGroups = chartGroups.map((group) =>
    chartData.map((row) => groupRowBySuffix(pick(row, [...group, "timestamp"])))
  );


  return { chartDataGroups, ignoredColumns };
}


// Video info extraction with segmentation for v3.0
function extractVideoInfoV3WithSegmentation(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: any,
): any[] {
  // Get video features from dataset info
  const videoFeatures = Object.entries(info.features)
    .filter(([, value]) => value.dtype === "video");

  const videosInfo = videoFeatures.map(([videoKey]) => {
    // Check if we have per-camera metadata in the episode row
    const cameraSpecificKeys = Object.keys(episodeMetadata).filter(key => 
      key.startsWith(`videos/${videoKey}/`)
    );
    
    let chunkIndex, fileIndex, segmentStart, segmentEnd;
    
    if (cameraSpecificKeys.length > 0) {
      // Use camera-specific metadata
      const chunkValue = episodeMetadata[`videos/${videoKey}/chunk_index`];
      const fileValue = episodeMetadata[`videos/${videoKey}/file_index`];
      chunkIndex = typeof chunkValue === 'bigint' ? Number(chunkValue) : (chunkValue || 0);
      fileIndex = typeof fileValue === 'bigint' ? Number(fileValue) : (fileValue || 0);
      segmentStart = episodeMetadata[`videos/${videoKey}/from_timestamp`] || 0;
      segmentEnd = episodeMetadata[`videos/${videoKey}/to_timestamp`] || 30;
    } else {
      // Fallback to generic video metadata
      chunkIndex = episodeMetadata.video_chunk_index || 0;
      fileIndex = episodeMetadata.video_file_index || 0;
      segmentStart = episodeMetadata.video_from_timestamp || 0;
      segmentEnd = episodeMetadata.video_to_timestamp || 30;
    }
    
    const videoPath = `videos/${videoKey}/chunk-${chunkIndex.toString().padStart(3, "0")}/file-${fileIndex.toString().padStart(3, "0")}.mp4`;
    const fullUrl = buildVersionedUrl(repoId, version, videoPath);
    
    return {
      filename: videoKey,
      url: fullUrl,
      // Enable segmentation with timestamps from metadata
      isSegmented: true,
      segmentStart: segmentStart,
      segmentEnd: segmentEnd,
      segmentDuration: segmentEnd - segmentStart,
    };
  });

  return videosInfo;
}

// Metadata loading for v3.0 episodes
async function loadEpisodeMetadataV3Simple(
  repoId: string,
  version: string,
  episodeId: number,
): Promise<any> {
  const episodesMetadataUrl = buildVersionedUrl(
    repoId,
    version,
    "meta/episodes/chunk-000/file-000.parquet"
  );

  try {
    const arrayBuffer = await fetchParquetFile(episodesMetadataUrl);
    const episodesData = await readParquetAsObjects(arrayBuffer, []);
    
    if (episodesData.length === 0) {
      throw new Error("No episode metadata found");
    }
    
    // Find the row for the requested episode
    let episodeRow = null;
    
    for (let i = 0; i < episodesData.length; i++) {
      const row = episodesData[i];
      const parsedRow = parseEpisodeRowSimple(row);
      
      if (parsedRow.episode_index === episodeId) {
        episodeRow = row;
        break;
      }
    }
    
    if (!episodeRow) {
      // Fallback: if we can't find the exact episode, use the row at index episodeId
      if (episodeId < episodesData.length) {
        episodeRow = episodesData[episodeId];
      } else {
        throw new Error(`Episode ${episodeId} not found in metadata`);
      }
    }
    
    // Convert the row to a usable format
    return parseEpisodeRowSimple(episodeRow);
  } catch (error) {
    throw error;
  }
}

// Simple parser for episode row - focuses on key fields for episodes
function parseEpisodeRowSimple(row: any): any {
  // v3.0 uses named keys in the episode metadata
  if (row && typeof row === 'object') {
    // Check if this is v3.0 format with named keys
    if ('episode_index' in row) {
      // v3.0 format - use named keys
      // Convert BigInt values to numbers
      const toBigIntSafe = (value: any) => {
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number') return value;
        return parseInt(value) || 0;
      };
      
      const episodeData = {
        episode_index: toBigIntSafe(row['episode_index']),
        data_chunk_index: toBigIntSafe(row['data/chunk_index']),
        data_file_index: toBigIntSafe(row['data/file_index']),
        dataset_from_index: toBigIntSafe(row['dataset_from_index']),
        dataset_to_index: toBigIntSafe(row['dataset_to_index']),
        length: toBigIntSafe(row['length']),
      };
      
      // Handle video metadata - look for video-specific keys
      const videoKeys = Object.keys(row).filter(key => key.includes('videos/') && key.includes('/chunk_index'));
      if (videoKeys.length > 0) {
        // Use the first video stream for basic info
        const firstVideoKey = videoKeys[0];
        const videoBaseName = firstVideoKey.replace('/chunk_index', '');
        
        episodeData.video_chunk_index = toBigIntSafe(row[`${videoBaseName}/chunk_index`]);
        episodeData.video_file_index = toBigIntSafe(row[`${videoBaseName}/file_index`]);
        episodeData.video_from_timestamp = row[`${videoBaseName}/from_timestamp`] || 0;
        episodeData.video_to_timestamp = row[`${videoBaseName}/to_timestamp`] || 0;
      } else {
        // Fallback video values
        episodeData.video_chunk_index = 0;
        episodeData.video_file_index = 0;
        episodeData.video_from_timestamp = 0;
        episodeData.video_to_timestamp = 30;
      }
      
      // Store the raw row data to preserve per-camera metadata
      // This allows extractVideoInfoV3WithSegmentation to access camera-specific timestamps
      Object.keys(row).forEach(key => {
        if (key.startsWith('videos/')) {
          episodeData[key] = row[key];
        }
      });
      
      return episodeData;
    } else {
      // Fallback to numeric keys for compatibility
      const episodeData = {
        episode_index: row['0'] || 0,
        data_chunk_index: row['1'] || 0,
        data_file_index: row['2'] || 0,
        dataset_from_index: row['3'] || 0,
        dataset_to_index: row['4'] || 0,
        video_chunk_index: row['5'] || 0,
        video_file_index: row['6'] || 0,
        video_from_timestamp: row['7'] || 0,
        video_to_timestamp: row['8'] || 30,
        length: row['9'] || 30,
      };
      
      return episodeData;
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
): Promise<{ data?: any; error?: string }> {
  try {
    const data = await getEpisodeData(org, dataset, episodeId);
    return { data };
  } catch (err: any) {
    // Only expose the error message, not stack or sensitive info
    return { error: err?.message || String(err) || "Unknown error" };
  }
}

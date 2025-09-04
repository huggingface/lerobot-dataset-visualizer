import {
  DatasetMetadata,
  fetchJson,
  fetchParquetFile,
  formatStringWithVars,
  readParquetColumn,
} from "@/utils/parquetUtils";
import { pick } from "@/utils/pick";
import { getDatasetVersion, buildVersionedUrl } from "@/utils/versionUtils";

const DATASET_URL =
  process.env.DATASET_URL || "https://huggingface.co/datasets";

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
    console.log(`[DEBUG] Detected dataset version: ${version} for ${repoId}`);
    
    const jsonUrl = buildVersionedUrl(repoId, version, "meta/info.json");

    const info = await fetchJson<DatasetMetadata>(jsonUrl);

    // Handle different versions
    if (version === "v3.0") {
      console.log(`[DEBUG] Using v3.0 data loader for ${repoId}`);
      return await getEpisodeDataV3(repoId, version, info, episodeId);
    } else {
      console.log(`[DEBUG] Using v2.x data loader for ${repoId} (version: ${version})`);
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
              .filter(([key, value]) => value.dtype === "video")
              .map(([key, _]) => {
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
        } catch (err) {
          console.warn(`Failed to get video info for episode ${episodeId}:`, err);
        }
      }
    }
    
    return adjacentVideos;
  } catch (err) {
    console.error("Error getting adjacent episodes video info:", err);
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
    .filter(([key, value]) => value.dtype === "video")
    .map(([key, _]) => {
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
      ([key, value]) =>
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
      ([key, value]) =>
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
  console.log(`[DEBUG] Loading v3.0 episode data for ${repoId}, episode ${episodeId}`);

  // Create dataset info structure (like v2.x)
  const datasetInfo = {
    repoId,
    total_frames: info.total_frames,
    total_episodes: info.total_episodes,
    fps: info.fps,
  };

  // Generate episodes list based on total_episodes from dataset info
  const episodes = Array.from({ length: info.total_episodes }, (_, i) => i);
  console.log(`[DEBUG] Available episodes: ${episodes.length} (0 to ${episodes.length - 1})`);

  // Load episode metadata to get timestamps for episode 0
  const episodeMetadata = await loadEpisodeMetadataV3Simple(repoId, version, episodeId);
  
  // Create video info with segmentation using the metadata
  const videosInfo = extractVideoInfoV3WithSegmentation(repoId, version, info, episodeMetadata);

  // Load episode data for charts
  const { chartDataGroups, ignoredColumns } = await loadEpisodeDataV3(repoId, version, info, episodeMetadata);

  return {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    ignoredColumns,
    duration: episodeMetadata.video_to_timestamp - episodeMetadata.video_from_timestamp, // Use actual episode duration
  };
}

// Load episode data for v3.0 charts
async function loadEpisodeDataV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: any,
): Promise<{ chartDataGroups: any[]; ignoredColumns: string[] }> {
  console.log(`[DEBUG] Loading v3.0 data for episode ${episodeMetadata.episode_index}`);
  
  // Build data file path using chunk and file indices
  const dataChunkIndex = episodeMetadata.data_chunk_index || 0;
  const dataFileIndex = episodeMetadata.data_file_index || 0;
  const dataPath = `data/chunk-${dataChunkIndex.toString().padStart(3, "0")}/file-${dataFileIndex.toString().padStart(3, "0")}.parquet`;
  
  console.log(`[DEBUG] Loading data from: ${dataPath}`);
  console.log(`[DEBUG] Data range: ${episodeMetadata.dataset_from_index} to ${episodeMetadata.dataset_to_index}`);
  
  try {
    const dataUrl = buildVersionedUrl(repoId, version, dataPath);
    const arrayBuffer = await fetchParquetFile(dataUrl);
    const fullData = await readParquetColumn(arrayBuffer, []);
    
    console.log(`[DEBUG] Loaded ${fullData.length} total data rows`);
    
    // Extract the episode-specific data slice
    // Convert BigInt to number if needed
    const fromIndex = Number(episodeMetadata.dataset_from_index || 0);
    const toIndex = Number(episodeMetadata.dataset_to_index || fullData.length);
    
    console.log(`[DEBUG] Converting indices: ${episodeMetadata.dataset_from_index} → ${fromIndex}, ${episodeMetadata.dataset_to_index} → ${toIndex}`);
    
    const episodeData = fullData.slice(fromIndex, toIndex);
    
    console.log(`[DEBUG] Episode data slice: ${episodeData.length} rows (${fromIndex} to ${toIndex})`);
    
    if (episodeData.length === 0) {
      console.log(`[DEBUG] No data found for episode ${episodeMetadata.episode_index}`);
      return { chartDataGroups: [], ignoredColumns: [] };
    }
    
    // Convert to the same format as v2.x for compatibility with existing chart code
    const { chartDataGroups, ignoredColumns } = processEpisodeDataForCharts(episodeData, info, episodeMetadata);
    
    return { chartDataGroups, ignoredColumns };
  } catch (error) {
    console.error(`[DEBUG] Failed to load episode data:`, error);
    return { chartDataGroups: [], ignoredColumns: [] };
  }
}

// Process episode data for charts (v3.0 compatible)
function processEpisodeDataForCharts(
  episodeData: any[],
  info: DatasetMetadata,
  episodeMetadata?: any,
): { chartDataGroups: any[]; ignoredColumns: string[] } {
  const SERIES_NAME_DELIMITER = ".";
  
  // Get numeric column features
  const columnNames = Object.entries(info.features)
    .filter(
      ([key, value]) =>
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
  const excludedColumns = ['index', 'task_index', 'episode_index', 'frame_index'];

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
      
      if (Array.isArray(value) && value.length > 0) {
        // For array values like observation.state and action, create a key for each element
        value.forEach((_, idx) => {
          allKeys.push(`${featureName}[${idx}]`);
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
    console.log(`[DEBUG] Detected series:`, allKeys);
    console.log(`[DEBUG] First row sample:`, firstRow);
  } else {
    // Fallback to feature-based approach
    seriesNames = [
      "timestamp",
      ...columnNames.map(({ key }) => key),
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
    
    // For v3.0, data might have numeric string keys, so we need to map them
    // Get all available keys from the first row to understand the structure
    if (index === 0) {
      console.log(`[DEBUG] Data row keys:`, Object.keys(row || {}));
      console.log(`[DEBUG] Available features:`, Object.keys(info.features));
    }
    
    // Add all data columns
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
        
        if (Array.isArray(value)) {
          // For array values like observation.state and action
          value.forEach((val, idx) => {
            const elementKey = `${featureName}[${idx}]`;
            obj[elementKey] = typeof val === 'number' ? val : Number(val);
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
        ([key, value]) =>
          ["float32", "int32"].includes(value.dtype) && value.shape.length > 2, // Only ignore 3D+ data
      )
      .map(([key]) => key),
    ...excludedColumns // Also include the manually excluded columns
  ];

  // Group processing logic (adapted for v3.0 numeric keys)
  const numericKeys = seriesNames.filter((k) => k !== "timestamp");
  
  // Group keys by prefix (for hierarchical structure like v2)
  const suffixGroupsMap: Record<string, string[]> = {};
  
  // First, let's check if we have keys with dots (hierarchical structure)
  const hasHierarchicalKeys = numericKeys.some(key => key.includes('.') && !key.includes('['));
  
  if (hasHierarchicalKeys) {
    // Group by suffix after the dot (like v2 does)
    for (const key of numericKeys) {
      const cleanKey = key.replace(/\[\d+\]$/, ''); // Remove array indices
      const parts = cleanKey.split('.');
      
      if (parts.length >= 2) {
        // For keys like "observation.state" or "action.main_shoulder_pan"
        const suffix = parts.slice(1).join('.'); // Everything after first dot
        if (!suffixGroupsMap[suffix]) {
          suffixGroupsMap[suffix] = [];
        }
        suffixGroupsMap[suffix].push(key);
      } else {
        // Keys without dots go in their own group
        if (!suffixGroupsMap[key]) {
          suffixGroupsMap[key] = [];
        }
        suffixGroupsMap[key].push(key);
      }
    }
  } else {
    // For v3 data without hierarchical keys, group by base name (removing array indices)
    for (const key of numericKeys) {
      const baseKey = key.replace(/\[\d+\]$/, '');
      
      if (!suffixGroupsMap[baseKey]) {
        suffixGroupsMap[baseKey] = [];
      }
      suffixGroupsMap[baseKey].push(key);
    }
  }
  const suffixGroups = Object.values(suffixGroupsMap);
  
  console.log(`[DEBUG] Created suffix groups:`, suffixGroupsMap);

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

  // Utility function to group row keys by suffix
  function groupRowBySuffix(row: Record<string, number>): Record<string, any> {
    const result: Record<string, any> = {};
    
    // Check if we have hierarchical keys
    const hasHierarchicalKeys = Object.keys(row).some(key => key.includes('.') && !key.includes('[') && key !== 'timestamp');
    
    if (hasHierarchicalKeys) {
      // Group by prefix for hierarchical display
      const prefixGroups: Record<string, Record<string, number>> = {};
      
      for (const [key, value] of Object.entries(row)) {
        if (key === "timestamp") {
          result["timestamp"] = value;
          continue;
        }
        
        const cleanKey = key.replace(/\[\d+\]$/, ''); // Remove array indices
        const parts = cleanKey.split('.');
        
        if (parts.length >= 2) {
          const prefix = parts[0];
          const suffix = parts.slice(1).join('.');
          
          if (!prefixGroups[suffix]) {
            prefixGroups[suffix] = {};
          }
          
          // Store with the prefix as key
          prefixGroups[suffix][prefix] = value;
        } else {
          // Non-hierarchical keys go directly to result
          result[key] = value;
        }
      }
      
      // Add grouped data to result
      for (const [suffix, group] of Object.entries(prefixGroups)) {
        const keys = Object.keys(group);
        if (keys.length === 1) {
          // Single value, use full name
          result[`${keys[0]}.${suffix}`] = group[keys[0]];
        } else {
          // Multiple values, create nested structure
          result[suffix] = group;
        }
      }
    } else {
      // For non-hierarchical data, just pass through
      for (const [key, value] of Object.entries(row)) {
        result[key] = value;
      }
    }
    
    return result;
  }

  const chartDataGroups = chartGroups.map((group) =>
    chartData.map((row) => groupRowBySuffix(pick(row, [...group, "timestamp"])))
  );

  console.log(`[DEBUG] Generated ${chartDataGroups.length} chart groups`);
  console.log(`[DEBUG] Chart groups structure:`, chartGroups);
  if (chartDataGroups.length > 0 && chartDataGroups[0].length > 0) {
    console.log(`[DEBUG] Sample chart data:`, chartDataGroups[0][0]);
  }

  return { chartDataGroups, ignoredColumns };
}

// Simplified video info extraction for v3.0 - just use first chunk files
function extractSimpleVideoInfoV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
): any[] {
  // Get video features from dataset info
  const videoFeatures = Object.entries(info.features)
    .filter(([key, value]) => value.dtype === "video");

  const videosInfo = videoFeatures.map(([videoKey, _]) => {
    // For simplified version, just use chunk-000/file-000.mp4 
    const videoPath = `videos/${videoKey}/chunk-000/file-000.mp4`;
    
    return {
      filename: videoKey,
      url: buildVersionedUrl(repoId, version, videoPath),
      // No segmentation - just show the full video file
      isSegmented: false,
    };
  });

  return videosInfo;
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
    .filter(([key, value]) => value.dtype === "video");

  const videosInfo = videoFeatures.map(([videoKey, _]) => {
    // Use chunk and file indices from metadata
    const chunkIndex = episodeMetadata.video_chunk_index || 0;
    const fileIndex = episodeMetadata.video_file_index || 0;
    
    const videoPath = `videos/${videoKey}/chunk-${chunkIndex.toString().padStart(3, "0")}/file-${fileIndex.toString().padStart(3, "0")}.mp4`;
    const fullUrl = buildVersionedUrl(repoId, version, videoPath);
    
    console.log(`[DEBUG] Video URL for ${videoKey}: ${fullUrl}`);
    console.log(`[DEBUG] Chunk index: ${chunkIndex}, File index: ${fileIndex}`);
    console.log(`[DEBUG] Timestamps: ${episodeMetadata.video_from_timestamp} to ${episodeMetadata.video_to_timestamp}`);
    
    return {
      filename: videoKey,
      url: fullUrl,
      // Enable segmentation with timestamps from metadata
      isSegmented: true,
      segmentStart: episodeMetadata.video_from_timestamp || 0,
      segmentEnd: episodeMetadata.video_to_timestamp || 30,
      segmentDuration: (episodeMetadata.video_to_timestamp || 30) - (episodeMetadata.video_from_timestamp || 0),
    };
  });

  console.log(`[DEBUG] Created segmented video info:`, videosInfo);
  return videosInfo;
}

// Metadata loading for v3.0 episodes
async function loadEpisodeMetadataV3Simple(
  repoId: string,
  version: string,
  episodeId: number,
): Promise<any> {
  console.log(`[DEBUG] Loading v3.0 metadata for episode ${episodeId}`);

  const episodesMetadataUrl = buildVersionedUrl(
    repoId,
    version,
    "meta/episodes/chunk-000/file-000.parquet"
  );

  try {
    const arrayBuffer = await fetchParquetFile(episodesMetadataUrl);
    const episodesData = await readParquetColumn(arrayBuffer, []);
    
    console.log(`[DEBUG] Loaded ${episodesData.length} episode rows`);
    
    if (episodesData.length === 0) {
      throw new Error("No episode metadata found");
    }
    
    // Find the row for the requested episode
    let episodeRow = null;
    
    for (let i = 0; i < episodesData.length; i++) { // Check all rows
      const row = episodesData[i];
      const parsedRow = parseEpisodeRowSimple(row, false); // Don't log for each attempt
      
      if (parsedRow.episode_index === episodeId) {
        episodeRow = row;
        console.log(`[DEBUG] Found episode ${episodeId} at row ${i}`);
        break;
      }
    }
    
    if (!episodeRow) {
      // Fallback: if we can't find the exact episode, use the row at index episodeId
      if (episodeId < episodesData.length) {
        episodeRow = episodesData[episodeId];
        console.log(`[DEBUG] Using fallback row ${episodeId} for episode ${episodeId}`);
      } else {
        throw new Error(`Episode ${episodeId} not found in metadata`);
      }
    }
    
    // Convert the row to a usable format
    return parseEpisodeRowSimple(episodeRow, true); // Enable logging for final parse
  } catch (error) {
    console.error(`Failed to load episode metadata:`, error);
    throw error;
  }
}

// Simple parser for episode row - focuses on key fields for episodes
function parseEpisodeRowSimple(row: any, enableLogging: boolean = true): any {
  if (enableLogging) {
    console.log(`[DEBUG] Parsing episode row with keys:`, Object.keys(row || {}));
    console.log(`[DEBUG] Row type:`, typeof row);
  }
  
  // Based on the debug output we saw, the row has numeric string keys
  // We'll need to map these to meaningful field names
  // This is a best-guess mapping - may need adjustment based on actual data
  
  if (row && typeof row === 'object') {
    // Try to extract key fields we need for video segmentation
    // Based on your example: episode_index, video timestamps, etc.
    const episodeData = {
      episode_index: row['0'] || 0, // First column likely episode index
      data_chunk_index: row['1'] || 0, // Data chunk index
      data_file_index: row['2'] || 0, // Data file index
      dataset_from_index: row['3'] || 0, // Dataset start index
      dataset_to_index: row['4'] || 0, // Dataset end index
      video_chunk_index: row['5'] || 0, // Video chunk index
      video_file_index: row['6'] || 0, // Video file index
      video_from_timestamp: row['7'] || 0, // Video from timestamp 
      video_to_timestamp: row['8'] || 30, // Video to timestamp
      length: row['9'] || 30, // Episode length
    };
    
    if (enableLogging) {
      console.log(`[DEBUG] Raw row values:`);
      console.log(`  Row['0'] (episode_index): ${row['0']}`);
      console.log(`  Row['1'] (data_chunk_index): ${row['1']}`);
      console.log(`  Row['2'] (data_file_index): ${row['2']}`);
      console.log(`  Row['3'] (dataset_from_index): ${row['3']}`);
      console.log(`  Row['4'] (dataset_to_index): ${row['4']}`);
      console.log(`  Row['5'] (video_chunk_index): ${row['5']}`);
      console.log(`  Row['6'] (video_file_index): ${row['6']}`);
      console.log(`  Row['7'] (video_from_timestamp): ${row['7']}`);
      console.log(`  Row['8'] (video_to_timestamp): ${row['8']}`);
      console.log(`  Row['9'] (length): ${row['9']}`);
    }
    
    if (enableLogging) {
      console.log(`[DEBUG] Parsed episode data:`, episodeData);
    }
    return episodeData;
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
  
  if (enableLogging) {
    console.log(`[DEBUG] Using fallback episode data:`, fallback);
  }
  return fallback;
}

// Parse episode metadata row into structured object
function parseEpisodeRow(row: any): any {
  // This is a placeholder - the actual structure depends on how the parquet data is organized
  // You may need to adjust this based on the actual column names and order
  if (Array.isArray(row)) {
    // If it's an array, we need to map positions to field names
    // This is a rough mapping - needs to be adjusted based on actual data structure
    return {
      episode_index: row[0],
      data_chunk_index: row[1],
      data_file_index: row[2],
      dataset_from_index: row[3],
      dataset_to_index: row[4],
      video_chunk_index: row[5],
      video_file_index: row[6],
      video_from_timestamp: row[7],
      video_to_timestamp: row[8],
      length: row[9],
      // Add more fields as needed
    };
  } else {
    // If it's already an object, return as-is
    return row;
  }
}

// Extract video information for v3.0 format
async function extractVideoInfoV3(
  repoId: string,
  version: string,
  info: DatasetMetadata,
  episodeMetadata: any,
): Promise<any[]> {
  // Get video features from dataset info
  const videoFeatures = Object.entries(info.features)
    .filter(([key, value]) => value.dtype === "video");

  const videosInfo = videoFeatures.map(([videoKey, _]) => {
    // For v3.0, video path format is: videos/camera_key/chunk-000/file-000.mp4
    // Extract the appropriate chunk and file indices for this video key
    const videoChunkKey = `videos/${videoKey}/chunk_index`;
    const videoFileKey = `videos/${videoKey}/file_index`;
    const videoFromTimestampKey = `videos/${videoKey}/from_timestamp`;
    const videoToTimestampKey = `videos/${videoKey}/to_timestamp`;
    
    const chunkIndex = episodeMetadata[videoChunkKey] || 0;
    const fileIndex = episodeMetadata[videoFileKey] || 0;
    const fromTimestamp = episodeMetadata[videoFromTimestampKey] || 0;
    const toTimestamp = episodeMetadata[videoToTimestampKey] || 0;
    
    const videoPath = `videos/${videoKey}/chunk-${chunkIndex.toString().padStart(3, "0")}/file-${fileIndex.toString().padStart(3, "0")}.mp4`;
    
    return {
      filename: videoKey,
      url: buildVersionedUrl(repoId, version, videoPath),
      // Segment information for v3.0 chunked videos
      isSegmented: true,
      segmentStart: fromTimestamp,
      segmentEnd: toTimestamp,
      segmentDuration: toTimestamp - fromTimestamp,
    };
  });

  return videosInfo;
}

// DISABLED: Complex episode data loading for simplified v3.0 implementation
/*
async function loadEpisodeDataV3(
  episodeMetadata: any,
): Promise<{ chartDataGroups: any[]; ignoredColumns: string[]; duration: number }> {
  // Complex data loading disabled for simplified implementation
  throw new Error("Complex data loading disabled in simplified v3.0 implementation");
}
*/

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

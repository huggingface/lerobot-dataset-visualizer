/**
 * Episode type definitions for LeRobot datasets
 */

import type { DatasetInfo } from "./dataset.types";
import type { VideoInfo } from "./video.types";
import type { ChartDataGroup } from "./chart.types";

// Episode metadata for v3.0
export interface EpisodeMetadataV3 {
  episode_index: number | bigint;
  data_chunk_index: number | bigint;
  data_file_index: number | bigint;
  dataset_from_index: number | bigint;
  dataset_to_index: number | bigint;
  video_chunk_index?: number | bigint;
  video_file_index?: number | bigint;
  video_from_timestamp?: number;
  video_to_timestamp?: number;
  length: number | bigint;
  // Per-camera metadata (optional)
  [key: string]: number | bigint | undefined;
}

// Episode metadata for v2.x (simpler structure)
export interface EpisodeMetadataV2 {
  episode_chunk: number;
  episode_index: number;
}

// Task metadata
export interface TaskMetadata {
  task_index: number | bigint;
  task: string;
}

// Language instruction data
export interface LanguageInstruction {
  language_instruction?: string;
  [key: `language_instruction_${number}`]: string | undefined;
}

// Episode data returned to components
export interface EpisodeData {
  datasetInfo: DatasetInfo;
  episodeId: number;
  videosInfo: VideoInfo[];
  chartDataGroups: ChartDataGroup[];
  episodes: number[];
  ignoredColumns: string[];
  duration: number;
  task?: string;
}

// Raw parquet row structure
export interface ParquetDataRow {
  timestamp?: number;
  episode_index?: number | bigint;
  frame_index?: number | bigint;
  index?: number | bigint;
  task_index?: number | bigint;
  "observation.state"?: number[];
  action?: number[];
  "next.reward"?: number;
  "next.done"?: boolean;
  language_instruction?: string;
  [key: string]: unknown; // For additional fields
}

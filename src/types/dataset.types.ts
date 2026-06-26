/**
 * Dataset type definitions for LeRobot datasets
 * Based on the LeRobot dataset format (v2.0, v2.1, v3.0)
 */

// Version management
export type DatasetVersion = "v2.0" | "v2.1" | "v3.0";

// Feature data types
export type FeatureDType = "video" | "float32" | "int32" | "int64" | "bool";

// Video-specific feature
export interface VideoFeature {
  dtype: "video";
  shape: [number, number, number]; // [height, width, channels]
  names: ["height", "width", "channel"];
  video_info?: {
    "video.fps": number;
    "video.codec": string;
    "video.pix_fmt": string;
    "video.is_depth_map": boolean;
    has_audio: boolean;
  };
}

// Numeric feature (state, action, etc.)
export interface NumericFeature {
  dtype: "float32" | "int32" | "int64";
  shape: number[];
  names: string[] | { motors: string[] } | { [key: string]: string[] } | null;
  fps?: number;
}

// Boolean feature
export interface BooleanFeature {
  dtype: "bool";
  shape: number[];
  names: null;
  fps?: number;
}

// Discriminated union for all feature types
export type Feature = VideoFeature | NumericFeature | BooleanFeature;

// Complete dataset metadata
export interface DatasetMetadata {
  codebase_version: DatasetVersion;
  robot_type: string;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  total_videos?: number;
  total_chunks?: number;
  chunks_size: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string | null;
  features: Record<string, Feature>;
  data_files_size_in_mb?: number;
  video_files_size_in_mb?: number;
}

// Dataset info used in components
export interface DatasetInfo {
  repoId: string;
  total_frames: number;
  total_episodes: number;
  fps: number;
}

/**
 * Compact dataset record powering the /explore page, derived from the HuggingFace
 * datasets list API (one cached call covers the whole corpus). The list API does NOT
 * expose `robot_type`, so `robotTags` is a best-effort set of canonical robot keys
 * derived from free-form tags (see `ROBOT_TAG_TO_KEY` in utils/constants.ts); each card
 * refines to the exact `robot_type` lazily from `meta/info.json`.
 */
export interface ExploreDataset {
  id: string; // "org/name"
  downloads: number;
  likes: number;
  lastModified: string; // ISO timestamp
  sizeBytes: number | null; // from `mainSize`; null when unavailable (~2/1000)
  license: string | null; // from cardData.license → "license:*" tag → null
  robotTags: string[]; // canonical robot keys (may be empty → "Unknown" bucket)
  freeTags: string[]; // free-form tags (excludes structured "x:y" tags & robots)
}

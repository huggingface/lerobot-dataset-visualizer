/**
 * Centralized constants for the lerobot-dataset-visualizer
 * Eliminates magic numbers and provides single source of truth for configuration
 */

// Formatting constants for episode and file indexing
export const PADDING = {
  EPISODE_CHUNK: 3,
  EPISODE_INDEX: 6,
  FILE_INDEX: 3,
  CHUNK_INDEX: 3,
} as const;

// Numeric thresholds for data processing
export const THRESHOLDS = {
  SCALE_GROUPING: 2,
  EPSILON: 1e-9,
  VIDEO_SYNC_TOLERANCE: 0.2,
  VIDEO_SEGMENT_BOUNDARY: 0.05,
} as const;

// Chart configuration
export const CHART_CONFIG = {
  MAX_SERIES_PER_GROUP: 6,
  SERIES_NAME_DELIMITER: " | ",
} as const;

// Video player configuration
export const VIDEO_PLAYER = {
  JUMP_SECONDS: 5,
  STEP_SIZE: 0.01,
  DEBOUNCE_MS: 200,
} as const;

// HTTP configuration
export const HTTP = {
  TIMEOUT_MS: 10000,
} as const;

// Excluded columns by dataset version
export const EXCLUDED_COLUMNS = {
  V2: ["timestamp", "frame_index", "episode_index", "index", "task_index"],
  V3: ["index", "task_index", "episode_index", "frame_index", "next.done"],
} as const;

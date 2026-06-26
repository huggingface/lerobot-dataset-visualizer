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

// ---------------------------------------------------------------------------
// Explore page (dataset discovery)
// ---------------------------------------------------------------------------

// Tag stopwords excluded from the free-form "Tags" facet: either always present on
// LeRobot datasets (so they carry no filtering signal) or non-descriptive noise.
export const EXPLORE_TAG_STOPWORDS = new Set([
  "lerobot",
  "robotics",
  "v",
  ".",
  "1",
  "2",
  "e",
]);

// Best-effort mapping of HuggingFace free-form tags → a canonical robot key.
// `robot_type` is NOT exposed by the datasets list API, so the explore "Robot" facet
// is derived from these tags; each dataset card refines to the exact `robot_type` from
// meta/info.json once its preview loads. Keys are matched against lowercased tags.
export const ROBOT_TAG_TO_KEY: Record<string, string> = {
  so100: "so100",
  "so-100": "so100",
  so100_stereo: "so100",
  so100_opencv: "so100",
  so101: "so101",
  "so-101": "so101",
  aloha: "aloha",
  koch: "koch",
  kocharm: "koch",
  moss: "moss",
  lekiwi: "lekiwi",
  reachy: "reachy",
  reachy2: "reachy2",
  stretch: "stretch",
  widowx: "widowx",
  xarm: "xarm",
  franka: "franka",
  ur5: "ur5",
  g1: "g1",
  "unitree-g1": "g1",
  openarm: "openarm",
};

// Display labels for canonical robot keys (used by the facet + card chips).
export const ROBOT_DISPLAY_NAMES: Record<string, string> = {
  so100: "SO-100",
  so101: "SO-101",
  aloha: "ALOHA",
  koch: "Koch",
  moss: "Moss",
  lekiwi: "LeKiwi",
  reachy: "Reachy",
  reachy2: "Reachy 2",
  stretch: "Stretch",
  widowx: "WidowX",
  xarm: "xArm",
  franka: "Franka",
  ur5: "UR5",
  g1: "Unitree G1",
  openarm: "OpenArm",
};

// Excluded columns by dataset version.
// Reserved names from lerobot: `next.reward`, `next.done`, `next.truncated` are
// auto-populated step signals and should not be rendered as chart series.
// `subtask_index` is the v3.0 subtask pointer (maps into meta/subtasks.parquet).
export const EXCLUDED_COLUMNS = {
  V2: [
    "timestamp",
    "frame_index",
    "episode_index",
    "index",
    "task_index",
    "next.reward",
    "next.done",
    "next.truncated",
  ],
  V3: [
    "index",
    "task_index",
    "episode_index",
    "frame_index",
    "next.reward",
    "next.done",
    "next.truncated",
    "subtask_index",
  ],
} as const;

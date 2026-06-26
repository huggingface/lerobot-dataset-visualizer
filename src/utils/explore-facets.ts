/**
 * Pure, framework-free helpers powering the /explore page's client-side search,
 * faceted filtering and summary stats. Kept side-effect-free so they run cheaply
 * inside `useMemo` and are straightforward to unit-test.
 */

import type { ExploreDataset } from "@/types/dataset.types";
import { ROBOT_DISPLAY_NAMES } from "@/utils/constants";

// Shared value used for the explicit "Unknown" bucket of every facet group
// (missing size / license, or no robot / descriptive tags).
export const UNKNOWN_VALUE = "unknown";

export type FacetGroupId = "robot" | "size" | "license" | "tag";

export const FACET_GROUP_IDS: FacetGroupId[] = [
  "robot",
  "size",
  "license",
  "tag",
];

export const FACET_GROUP_LABELS: Record<FacetGroupId, string> = {
  robot: "Robot",
  size: "Size",
  license: "License",
  tag: "Tags",
};

/** Selected values per facet group. Empty set = no constraint for that group. */
export type FacetSelection = Record<FacetGroupId, Set<string>>;

export function emptySelection(): FacetSelection {
  return {
    robot: new Set(),
    size: new Set(),
    license: new Set(),
    tag: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Size buckets (1024-based)
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export interface SizeBucket {
  id: string;
  label: string;
  min: number; // inclusive
  max: number; // exclusive
}

export const SIZE_BUCKETS: SizeBucket[] = [
  { id: "lt100mb", label: "< 100 MB", min: 0, max: 100 * MB },
  { id: "100mb-1gb", label: "100 MB – 1 GB", min: 100 * MB, max: GB },
  { id: "1-10gb", label: "1 – 10 GB", min: GB, max: 10 * GB },
  { id: "10-100gb", label: "10 – 100 GB", min: 10 * GB, max: 100 * GB },
  { id: "gt100gb", label: "> 100 GB", min: 100 * GB, max: Infinity },
];

/** Map a byte count to a size-bucket id; null/undefined → the "unknown" bucket. */
export function byteBucket(bytes: number | null | undefined): string {
  if (bytes == null) return UNKNOWN_VALUE;
  for (const b of SIZE_BUCKETS) {
    if (bytes >= b.min && bytes < b.max) return b.id;
  }
  return UNKNOWN_VALUE;
}

/** Human-readable byte size (e.g. "4.2 TB"). null/undefined → "—". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const val = bytes / 1024 ** i;
  // 0–2 decimals depending on magnitude, with trailing zeros stripped.
  const num = Number(val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2));
  return `${num} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Facet value extraction & matching
// ---------------------------------------------------------------------------

/** The values a dataset contributes to a facet group (≥1; falls back to Unknown). */
function valuesFor(ds: ExploreDataset, group: FacetGroupId): string[] {
  switch (group) {
    case "robot":
      return ds.robotTags.length ? ds.robotTags : [UNKNOWN_VALUE];
    case "size":
      return [byteBucket(ds.sizeBytes)];
    case "license":
      return [ds.license ?? UNKNOWN_VALUE];
    case "tag":
      return ds.freeTags.length ? ds.freeTags : [UNKNOWN_VALUE];
  }
}

/** A dataset matches a group iff the group has no selection, or any of its values
 *  is selected (OR within a group). */
function matchesGroup(
  ds: ExploreDataset,
  group: FacetGroupId,
  selected: Set<string>,
): boolean {
  if (selected.size === 0) return true;
  return valuesFor(ds, group).some((v) => selected.has(v));
}

/** Filter datasets: AND across facet groups, OR within each group. */
export function applyFilters(
  datasets: ExploreDataset[],
  selection: FacetSelection,
): ExploreDataset[] {
  return datasets.filter((ds) =>
    FACET_GROUP_IDS.every((g) => matchesGroup(ds, g, selection[g])),
  );
}

function facetLabel(group: FacetGroupId, value: string): string {
  if (value === UNKNOWN_VALUE) return "Unknown";
  if (group === "robot") return ROBOT_DISPLAY_NAMES[value] ?? value;
  return value;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface FacetGroup {
  id: FacetGroupId;
  label: string;
  options: FacetOption[];
}

/**
 * Compute facet options with drill-down counts: each group's counts are tallied
 * over the datasets filtered by *all other* groups (not by the group's own
 * selection), so picking one value in a group doesn't zero out its siblings.
 */
export function computeFacets(
  datasets: ExploreDataset[],
  selection: FacetSelection,
): FacetGroup[] {
  return FACET_GROUP_IDS.map((group) => {
    const base = datasets.filter((ds) =>
      FACET_GROUP_IDS.every(
        (g) => g === group || matchesGroup(ds, g, selection[g]),
      ),
    );

    const counts = new Map<string, number>();
    for (const ds of base) {
      // Multi-value fields (robot/tag) contribute once per distinct value.
      for (const v of new Set(valuesFor(ds, group))) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }

    let options: FacetOption[];
    if (group === "size") {
      // Fixed bucket order, Unknown last.
      options = [
        ...SIZE_BUCKETS.map((b) => ({
          value: b.id,
          label: b.label,
          count: counts.get(b.id) ?? 0,
        })),
        {
          value: UNKNOWN_VALUE,
          label: "Unknown",
          count: counts.get(UNKNOWN_VALUE) ?? 0,
        },
      ];
    } else {
      options = [...counts.entries()]
        .map(([value, count]) => ({
          value,
          label: facetLabel(group, value),
          count,
        }))
        .sort((a, b) => {
          if (a.value === UNKNOWN_VALUE) return 1;
          if (b.value === UNKNOWN_VALUE) return -1;
          return b.count - a.count || a.label.localeCompare(b.label);
        });
    }

    return { id: group, label: FACET_GROUP_LABELS[group], options };
  });
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export interface Breakdown {
  value: string;
  label: string;
  count: number;
}

export interface ExploreStats {
  count: number;
  totalSizeBytes: number;
  withSizeCount: number; // datasets contributing to totalSizeBytes
  totalDownloads: number;
  totalLikes: number;
  licenseBreakdown: Breakdown[];
  robotBreakdown: Breakdown[];
}

function tally(datasets: ExploreDataset[], group: FacetGroupId): Breakdown[] {
  const counts = new Map<string, number>();
  for (const ds of datasets) {
    for (const v of new Set(valuesFor(ds, group))) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: facetLabel(group, value),
      count,
    }))
    .sort((a, b) => {
      if (a.value === UNKNOWN_VALUE) return 1;
      if (b.value === UNKNOWN_VALUE) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

export function computeStats(datasets: ExploreDataset[]): ExploreStats {
  let totalSizeBytes = 0;
  let withSizeCount = 0;
  let totalDownloads = 0;
  let totalLikes = 0;

  for (const ds of datasets) {
    if (ds.sizeBytes != null) {
      totalSizeBytes += ds.sizeBytes;
      withSizeCount += 1;
    }
    totalDownloads += ds.downloads;
    totalLikes += ds.likes;
  }

  return {
    count: datasets.length,
    totalSizeBytes,
    withSizeCount,
    totalDownloads,
    totalLikes,
    licenseBreakdown: tally(datasets, "license"),
    robotBreakdown: tally(datasets, "robot"),
  };
}

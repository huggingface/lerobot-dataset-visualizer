import { describe, expect, test } from "bun:test";
import type { ExploreDataset } from "@/types/dataset.types";
import {
  applyFilters,
  byteBucket,
  computeFacets,
  computeStats,
  emptySelection,
  formatBytes,
  UNKNOWN_VALUE,
  type Breakdown,
  type FacetGroup,
  type FacetGroupId,
  type FacetSelection,
} from "@/utils/explore-facets";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

function ds(partial: Partial<ExploreDataset> & { id: string }): ExploreDataset {
  return {
    downloads: 0,
    likes: 0,
    lastModified: "2026-01-01T00:00:00.000Z",
    sizeBytes: null,
    license: null,
    robotTags: [],
    freeTags: [],
    ...partial,
  };
}

function selectionOf(
  partial: Partial<Record<FacetGroupId, string[]>>,
): FacetSelection {
  const sel = emptySelection();
  for (const [g, vals] of Object.entries(partial)) {
    sel[g as FacetGroupId] = new Set(vals);
  }
  return sel;
}

function optionCount(group: FacetGroup, value: string): number {
  return group.options.find((o) => o.value === value)?.count ?? 0;
}

function toMap(breakdown: Breakdown[]): Record<string, number> {
  return Object.fromEntries(breakdown.map((b) => [b.value, b.count]));
}

// Shared fixture
const D1 = ds({
  id: "a/so100",
  robotTags: ["so100"],
  license: "mit",
  sizeBytes: 50 * MB,
  freeTags: ["tutorial"],
  downloads: 10,
  likes: 1,
});
const D2 = ds({
  id: "a/aloha",
  robotTags: ["aloha"],
  license: "apache-2.0",
  sizeBytes: 5 * GB,
  freeTags: ["manipulation"],
  downloads: 20,
  likes: 2,
});
const D3 = ds({ id: "a/unknown", downloads: 30, likes: 3 }); // all unknowns
const D4 = ds({
  id: "a/both",
  robotTags: ["so100", "aloha"],
  license: "mit",
  sizeBytes: 200 * GB,
  freeTags: ["tutorial", "manipulation"],
  downloads: 40,
  likes: 4,
});
const ALL = [D1, D2, D3, D4];

describe("byteBucket", () => {
  test("null → unknown", () => {
    expect(byteBucket(null)).toBe(UNKNOWN_VALUE);
    expect(byteBucket(undefined)).toBe(UNKNOWN_VALUE);
  });
  test("boundaries are min-inclusive / max-exclusive", () => {
    expect(byteBucket(0)).toBe("lt100mb");
    expect(byteBucket(50 * MB)).toBe("lt100mb");
    expect(byteBucket(100 * MB)).toBe("100mb-1gb");
    expect(byteBucket(GB)).toBe("1-10gb");
    expect(byteBucket(10 * GB)).toBe("10-100gb");
    expect(byteBucket(100 * GB)).toBe("gt100gb");
    expect(byteBucket(5 * TB)).toBe("gt100gb");
  });
});

describe("formatBytes", () => {
  test("nullish and zero", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
  });
  test("humanizes with stripped trailing zeros", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * MB)).toBe("100 MB");
    expect(formatBytes(2.5 * GB)).toBe("2.5 GB");
  });
});

describe("applyFilters", () => {
  test("empty selection returns all", () => {
    expect(applyFilters(ALL, emptySelection())).toEqual(ALL);
  });
  test("OR within a group", () => {
    const r = applyFilters(ALL, selectionOf({ robot: ["so100", "aloha"] }));
    expect(r.map((d) => d.id)).toEqual(["a/so100", "a/aloha", "a/both"]);
  });
  test("single value matches multi-value datasets", () => {
    const r = applyFilters(ALL, selectionOf({ robot: ["so100"] }));
    expect(r.map((d) => d.id)).toEqual(["a/so100", "a/both"]);
  });
  test("AND across groups", () => {
    const r = applyFilters(
      ALL,
      selectionOf({ robot: ["so100"], license: ["mit"] }),
    );
    expect(r.map((d) => d.id)).toEqual(["a/so100", "a/both"]);
  });
  test("unknown buckets are selectable", () => {
    expect(
      applyFilters(ALL, selectionOf({ size: [UNKNOWN_VALUE] })).map(
        (d) => d.id,
      ),
    ).toEqual(["a/unknown"]);
    expect(
      applyFilters(ALL, selectionOf({ license: [UNKNOWN_VALUE] })).map(
        (d) => d.id,
      ),
    ).toEqual(["a/unknown"]);
    expect(
      applyFilters(ALL, selectionOf({ robot: [UNKNOWN_VALUE] })).map(
        (d) => d.id,
      ),
    ).toEqual(["a/unknown"]);
  });
  test("tag filtering", () => {
    expect(
      applyFilters(ALL, selectionOf({ tag: ["tutorial"] })).map((d) => d.id),
    ).toEqual(["a/so100", "a/both"]);
  });
});

describe("computeFacets", () => {
  test("counts over the full set with no selection", () => {
    const facets = computeFacets(ALL, emptySelection());
    const robot = facets.find((f) => f.id === "robot")!;
    expect(optionCount(robot, "so100")).toBe(2);
    expect(optionCount(robot, "aloha")).toBe(2);
    expect(optionCount(robot, UNKNOWN_VALUE)).toBe(1);
  });

  test("sibling option keeps its count when another in the same group is selected (drill-down)", () => {
    const facets = computeFacets(ALL, selectionOf({ robot: ["so100"] }));
    const robot = facets.find((f) => f.id === "robot")!;
    // robot facet ignores its own selection → aloha still 2
    expect(optionCount(robot, "aloha")).toBe(2);
    // but the license facet IS narrowed by the robot selection (d1, d4 → both mit)
    const license = facets.find((f) => f.id === "license")!;
    expect(optionCount(license, "mit")).toBe(2);
    expect(optionCount(license, "apache-2.0")).toBe(0);
  });

  test("size facet always lists every bucket in order, Unknown last", () => {
    const facets = computeFacets(ALL, emptySelection());
    const size = facets.find((f) => f.id === "size")!;
    expect(size.options.map((o) => o.value)).toEqual([
      "lt100mb",
      "100mb-1gb",
      "1-10gb",
      "10-100gb",
      "gt100gb",
      UNKNOWN_VALUE,
    ]);
  });
});

describe("computeStats", () => {
  test("totals and breakdowns", () => {
    const stats = computeStats(ALL);
    expect(stats.count).toBe(4);
    expect(stats.totalSizeBytes).toBe(50 * MB + 5 * GB + 200 * GB);
    expect(stats.withSizeCount).toBe(3); // D3 has no size
    expect(stats.totalDownloads).toBe(100);
    expect(stats.totalLikes).toBe(10);
    expect(toMap(stats.licenseBreakdown)).toEqual({
      mit: 2,
      "apache-2.0": 1,
      [UNKNOWN_VALUE]: 1,
    });
    expect(toMap(stats.robotBreakdown)).toEqual({
      so100: 2,
      aloha: 2,
      [UNKNOWN_VALUE]: 1,
    });
  });

  test("Unknown is sorted last in breakdowns", () => {
    const stats = computeStats(ALL);
    expect(
      stats.licenseBreakdown[stats.licenseBreakdown.length - 1].value,
    ).toBe(UNKNOWN_VALUE);
  });
});

import { describe, expect, test } from "bun:test";
import {
  groupRowBySuffix,
  buildSuffixGroupsMap,
  computeGroupStats,
  groupByScale,
  flattenScaleGroups,
  processChartDataGroups,
} from "@/utils/dataProcessing";
import { CHART_CONFIG } from "@/utils/constants";

const DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER; // " | "

// ---------------------------------------------------------------------------
// groupRowBySuffix
// ---------------------------------------------------------------------------
describe("groupRowBySuffix", () => {
  test("passes through timestamp unchanged", () => {
    const result = groupRowBySuffix({ timestamp: 1.5 });
    expect(result.timestamp).toBe(1.5);
  });

  test("keeps single-prefix suffix keys as flat entries with full original name", () => {
    // `action | 0`, `action | 1`, `action | 2` each have a UNIQUE prefix per suffix,
    // so they stay flat (no nesting). Nesting only occurs when multiple prefixes
    // share the same numeric suffix (e.g. state | 0 AND action | 0).
    const row = {
      [`action${DELIM}0`]: 0.1,
      [`action${DELIM}1`]: 0.2,
      [`action${DELIM}2`]: 0.3,
      timestamp: 0,
    };
    const result = groupRowBySuffix(row);
    expect(result[`action${DELIM}0`]).toBe(0.1);
    expect(result[`action${DELIM}1`]).toBe(0.2);
    expect(result[`action${DELIM}2`]).toBe(0.3);
  });

  test("keeps keys without delimiter at top level", () => {
    const row = { progress: 0.75, timestamp: 2.0 };
    const result = groupRowBySuffix(row);
    expect(result["progress"]).toBe(0.75);
  });

  test("preserves single-member suffix as full original key", () => {
    // A key like "observation.state | 0" that is alone in its suffix group
    // should remain at the top level with its full original name
    const row = { [`solo_col${DELIM}joint`]: 1.0 };
    const result = groupRowBySuffix(row);
    expect(result[`solo_col${DELIM}joint`]).toBe(1.0);
  });

  test("groups by suffix when multiple prefixes share the same suffix (v2.x state+action)", () => {
    // `observation.state | 0` and `action | 0` both have suffix "0",
    // so they are grouped under the key "0" as a nested object { "observation.state": ..., "action": ... }.
    const row = {
      [`observation.state${DELIM}0`]: 0.1,
      [`observation.state${DELIM}1`]: 0.2,
      [`action${DELIM}0`]: 0.5,
      [`action${DELIM}1`]: 0.6,
      timestamp: 0.5,
    };
    const result = groupRowBySuffix(row);
    // Both suffix "0" groups: observation.state and action
    const group0 = result["0"] as Record<string, number>;
    const group1 = result["1"] as Record<string, number>;
    expect(group0["observation.state"]).toBe(0.1);
    expect(group0["action"]).toBe(0.5);
    expect(group1["observation.state"]).toBe(0.2);
    expect(group1["action"]).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// buildSuffixGroupsMap
// ---------------------------------------------------------------------------
describe("buildSuffixGroupsMap", () => {
  test("groups keys by their suffix", () => {
    const keys = [
      `action${DELIM}0`,
      `action${DELIM}1`,
      `observation.state${DELIM}0`,
    ];
    const map = buildSuffixGroupsMap(keys);
    expect(map["action"]).toBeUndefined(); // suffix is "0" and "1"
    expect(map["0"]).toContain(`action${DELIM}0`);
    expect(map["0"]).toContain(`observation.state${DELIM}0`);
    expect(map["1"]).toContain(`action${DELIM}1`);
  });

  test("keys without delimiter fall back to the key itself", () => {
    const map = buildSuffixGroupsMap(["progress"]);
    expect(map["progress"]).toEqual(["progress"]);
  });

  test("returns empty object for empty input", () => {
    expect(buildSuffixGroupsMap([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// computeGroupStats
// ---------------------------------------------------------------------------
describe("computeGroupStats", () => {
  test("computes correct min and max across all rows for each group", () => {
    const chartData = [
      { "action | 0": 1.0, "action | 1": -2.0 },
      { "action | 0": 3.0, "action | 1": 0.5 },
    ];
    const groups = [["action | 0", "action | 1"]];
    const stats = computeGroupStats(chartData, groups);
    expect(stats["action | 0"].min).toBe(-2.0);
    expect(stats["action | 0"].max).toBe(3.0);
  });

  test("ignores NaN values", () => {
    const chartData = [{ col: NaN }, { col: 5 }, { col: 2 }];
    const stats = computeGroupStats(chartData, [["col"]]);
    expect(stats["col"].min).toBe(2);
    expect(stats["col"].max).toBe(5);
  });

  test("returns Infinity/-Infinity for all-NaN group (group skipped in groupByScale)", () => {
    const chartData = [{ col: NaN }];
    const stats = computeGroupStats(chartData, [["col"]]);
    expect(stats["col"].min).toBe(Infinity);
    expect(stats["col"].max).toBe(-Infinity);
  });
});

// ---------------------------------------------------------------------------
// groupByScale
// ---------------------------------------------------------------------------
describe("groupByScale", () => {
  test("groups series with similar scale together", () => {
    // Two series both in range ~[0, 1] — should be grouped
    const suffixGroups = [["a"], ["b"]];
    const stats = {
      a: { min: 0.1, max: 1.0 },
      b: { min: 0.2, max: 0.9 },
    };
    const result = groupByScale(suffixGroups, stats);
    const groups = Object.values(result);
    // Both a and b have similar log-scale range, expect them merged
    expect(groups.some((g) => g.length === 2)).toBe(true);
  });

  test("keeps series with vastly different scales separate", () => {
    // One series in [0,1], another in [0, 1000]
    const suffixGroups = [["small"], ["large"]];
    const stats = {
      small: { min: 0.001, max: 1.0 },
      large: { min: 100, max: 1000 },
    };
    const result = groupByScale(suffixGroups, stats);
    // Each should be in its own group
    expect(Object.keys(result).length).toBe(2);
  });

  test("skips groups with non-finite stats", () => {
    const suffixGroups = [["bad"]];
    const stats = { bad: { min: Infinity, max: -Infinity } };
    const result = groupByScale(suffixGroups, stats);
    expect(Object.keys(result).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flattenScaleGroups
// ---------------------------------------------------------------------------
describe("flattenScaleGroups", () => {
  test("returns each scale group as a flat array of keys", () => {
    const scaleGroups = { a: [["a", "b"], ["c"]] };
    const result = flattenScaleGroups(scaleGroups);
    expect(result).toEqual([["a", "b", "c"]]);
  });

  test("splits large groups exceeding MAX_SERIES_PER_GROUP", () => {
    const MAX = CHART_CONFIG.MAX_SERIES_PER_GROUP; // 6
    const bigGroup = Array.from({ length: MAX + 2 }, (_, i) => [`key_${i}`]);
    const scaleGroups = { key_0: bigGroup };
    const result = flattenScaleGroups(scaleGroups);
    // Should be split into 2 sub-groups
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(MAX);
    expect(result[1].length).toBe(2);
  });

  test("groups with more sub-arrays come first (sorted by length desc)", () => {
    const scaleGroups = {
      a: [["a"]], // 1 sub-group
      b: [["b"], ["c"]], // 2 sub-groups
    };
    const result = flattenScaleGroups(scaleGroups);
    // b (2 sub-groups) should come before a (1 sub-group)
    expect(result[0]).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// processChartDataGroups — end-to-end pipeline
// ---------------------------------------------------------------------------
describe("processChartDataGroups", () => {
  test("returns an empty array for empty chart data", () => {
    const result = processChartDataGroups(["timestamp"], []);
    expect(result).toEqual([]);
  });

  test("groups v2.x style action+state series correctly", () => {
    const seriesNames = [
      "timestamp",
      `observation.state${DELIM}0`,
      `observation.state${DELIM}1`,
      `action${DELIM}0`,
      `action${DELIM}1`,
    ];
    const chartData = [
      {
        timestamp: 0,
        [`observation.state${DELIM}0`]: 0.1,
        [`observation.state${DELIM}1`]: 0.2,
        [`action${DELIM}0`]: 0.5,
        [`action${DELIM}1`]: 0.6,
      },
      {
        timestamp: 0.1,
        [`observation.state${DELIM}0`]: 0.15,
        [`observation.state${DELIM}1`]: 0.25,
        [`action${DELIM}0`]: 0.55,
        [`action${DELIM}1`]: 0.65,
      },
    ];
    const result = processChartDataGroups(seriesNames, chartData);
    // All four series share similar scale, so likely merged into 1-2 groups
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Each element is an array of keys
    const allKeys = result.flat();
    expect(allKeys).toContain(`observation.state${DELIM}0`);
    expect(allKeys).toContain(`action${DELIM}0`);
  });

  test("handles single series without delimiter", () => {
    const seriesNames = ["timestamp", "progress"];
    const chartData = [
      { timestamp: 0, progress: 0.0 },
      { timestamp: 1, progress: 0.5 },
      { timestamp: 2, progress: 1.0 },
    ];
    const result = processChartDataGroups(seriesNames, chartData);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("progress");
  });
});

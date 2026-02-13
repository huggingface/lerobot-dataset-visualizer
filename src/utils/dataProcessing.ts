/**
 * Data processing utilities for chart data grouping and transformation
 * Consolidates duplicated logic from fetch-data.ts
 */

import { CHART_CONFIG, THRESHOLDS } from "./constants";
import type { GroupStats } from "@/types";

/**
 * Groups row keys by suffix using delimiter
 * Consolidates logic from lines 407-438 and 962-993 in fetch-data.ts
 *
 * @param row - Row data with numeric values
 * @returns Grouped row data with nested structure for multi-key groups
 */
export function groupRowBySuffix(
  row: Record<string, number>,
): Record<string, number | Record<string, number>> {
  const result: Record<string, number | Record<string, number>> = {};
  const suffixGroups: Record<string, Record<string, number>> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key === "timestamp") {
      result["timestamp"] = value;
      continue;
    }

    const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
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
      const fullName = `${keys[0]}${CHART_CONFIG.SERIES_NAME_DELIMITER}${suffix}`;
      result[fullName] = group[keys[0]];
    } else {
      result[suffix] = group;
    }
  }

  return result;
}

/**
 * Build suffix groups map from numeric keys
 * Consolidates logic from lines 328-335 and 880-887 in fetch-data.ts
 *
 * @param numericKeys - Array of numeric column keys (excluding timestamp)
 * @returns Map of suffix to array of keys with that suffix
 */
export function buildSuffixGroupsMap(
  numericKeys: string[],
): Record<string, string[]> {
  const suffixGroupsMap: Record<string, string[]> = {};

  for (const key of numericKeys) {
    const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
    const suffix = parts[1] || parts[0]; // fallback to key if no delimiter
    if (!suffixGroupsMap[suffix]) suffixGroupsMap[suffix] = [];
    suffixGroupsMap[suffix].push(key);
  }

  return suffixGroupsMap;
}

/**
 * Compute min/max statistics for suffix groups
 * Consolidates logic from lines 338-353 and 890-905 in fetch-data.ts
 *
 * @param chartData - Array of chart data rows
 * @param suffixGroups - Array of suffix groups (each group is an array of keys)
 * @returns Map of group ID to min/max statistics
 */
export function computeGroupStats(
  chartData: Record<string, number>[],
  suffixGroups: string[][],
): Record<string, GroupStats> {
  const groupStats: Record<string, GroupStats> = {};

  suffixGroups.forEach((group) => {
    let min = Infinity;
    let max = -Infinity;

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

  return groupStats;
}

/**
 * Group suffix groups by similar scale using logarithmic comparison
 * Consolidates logic from lines 356-387 and 907-945 in fetch-data.ts
 *
 * This complex algorithm groups data series that have similar scales together,
 * making charts more readable by avoiding mixing vastly different value ranges.
 *
 * @param suffixGroups - Array of suffix groups to analyze
 * @param groupStats - Statistics for each group
 * @returns Map of group ID to array of suffix groups with similar scales
 */
export function groupByScale(
  suffixGroups: string[][],
  groupStats: Record<string, GroupStats>,
): Record<string, string[][]> {
  const scaleGroups: Record<string, string[][]> = {};
  const used = new Set<string>();

  for (const group of suffixGroups) {
    const groupId = group[0];
    if (used.has(groupId)) continue;

    const { min, max } = groupStats[groupId];
    if (!isFinite(min) || !isFinite(max)) continue;

    const logMin = Math.log10(Math.abs(min) + THRESHOLDS.EPSILON);
    const logMax = Math.log10(Math.abs(max) + THRESHOLDS.EPSILON);
    const unit: string[][] = [group];
    used.add(groupId);

    for (const other of suffixGroups) {
      const otherId = other[0];
      if (used.has(otherId) || otherId === groupId) continue;

      const { min: omin, max: omax } = groupStats[otherId];
      if (!isFinite(omin) || !isFinite(omax) || omin === omax) continue;

      const ologMin = Math.log10(Math.abs(omin) + THRESHOLDS.EPSILON);
      const ologMax = Math.log10(Math.abs(omax) + THRESHOLDS.EPSILON);

      if (
        Math.abs(logMin - ologMin) <= THRESHOLDS.SCALE_GROUPING &&
        Math.abs(logMax - ologMax) <= THRESHOLDS.SCALE_GROUPING
      ) {
        unit.push(other);
        used.add(otherId);
      }
    }

    scaleGroups[groupId] = unit;
  }

  return scaleGroups;
}

/**
 * Flatten scale groups into chart groups with size limits
 * Consolidates logic from lines 388-404 and 946-962 in fetch-data.ts
 *
 * Large groups are split into subgroups to avoid overcrowded charts.
 *
 * @param scaleGroups - Map of scale groups
 * @returns Array of chart groups (each group is an array of series keys)
 */
export function flattenScaleGroups(
  scaleGroups: Record<string, string[][]>,
): string[][] {
  return Object.values(scaleGroups)
    .sort((a, b) => b.length - a.length)
    .flatMap((suffixGroupArr) => {
      const merged = suffixGroupArr.flat();
      if (merged.length > CHART_CONFIG.MAX_SERIES_PER_GROUP) {
        const subgroups: string[][] = [];
        for (
          let i = 0;
          i < merged.length;
          i += CHART_CONFIG.MAX_SERIES_PER_GROUP
        ) {
          subgroups.push(
            merged.slice(i, i + CHART_CONFIG.MAX_SERIES_PER_GROUP),
          );
        }
        return subgroups;
      }
      return [merged];
    });
}

/**
 * Complete pipeline to process chart data into organized groups
 * Combines all the above functions into a single pipeline
 *
 * @param seriesNames - All series names including timestamp
 * @param chartData - Array of chart data rows
 * @returns Array of chart groups ready for visualization
 */
export function processChartDataGroups(
  seriesNames: string[],
  chartData: Record<string, number>[],
): string[][] {
  // 1. Build suffix groups
  const numericKeys = seriesNames.filter((k) => k !== "timestamp");
  const suffixGroupsMap = buildSuffixGroupsMap(numericKeys);
  const suffixGroups = Object.values(suffixGroupsMap);

  // 2. Compute statistics
  const groupStats = computeGroupStats(chartData, suffixGroups);

  // 3. Group by scale
  const scaleGroups = groupByScale(suffixGroups, groupStats);

  // 4. Flatten into chart groups
  return flattenScaleGroups(scaleGroups);
}

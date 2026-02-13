/**
 * Chart and data visualization type definitions
 */

// Chart data point structure
export interface ChartDataPoint {
  timestamp: number;
  [key: string]: number | Record<string, number>; // Hierarchical data
}

// Chart data group
export type ChartDataGroup = ChartDataPoint[];

// Series column definition
export interface SeriesColumn {
  key: string;
  value: string[]; // Series names
}

// Group statistics for scale calculation
export interface GroupStats {
  min: number;
  max: number;
}

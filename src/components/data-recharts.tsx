"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTime, useTimeControls } from "../context/time-context";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

type ChartRow = Record<string, number | Record<string, number>>;

type DataGraphProps = {
  data: ChartRow[][];
  onChartsReady?: () => void;
};

const SERIES_NAME_DELIMITER = " | ";

const CHART_COLORS = [
  "#f97316",
  "#3b82f6",
  "#22c55e",
  "#ef4444",
  "#a855f7",
  "#eab308",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#6366f1",
  "#84cc16",
];

/// Plot-area geometry, shared by the chart and the playback cursor drawn over it.
const CHART_MARGIN = { top: 12, right: 12, left: -8, bottom: 8 };
const Y_AXIS_WIDTH = 55;
const X_AXIS_HEIGHT = 30;

/**
 * The time under the pointer, shared by every chart's legend. A store rather than state, so moving
 * the pointer re-renders the legends only, not every chart.
 */
type HoverStore = {
  get: () => number | null;
  set: (t: number | null) => void;
  subscribe: (cb: () => void) => () => void;
};

function createHoverStore(): HoverStore {
  let time: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set: (t) => {
      if (t === time) return;
      time = t;
      listeners.forEach((cb) => cb());
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Index of the first point at or after `time`, or the last point. */
function closestDataIndex(chartData: Record<string, number>[], time: number) {
  if (!chartData.length) return 0;
  const idx = chartData.findIndex((point) => point.timestamp >= time);
  return idx !== -1 ? idx : chartData.length - 1;
}

/**
 * Drawn over the chart instead of as a Recharts ReferenceLine: a ReferenceLine
 * makes the whole chart re-render on every playback tick.
 */
function PlaybackCursor({ start, end }: { start: number; end: number }) {
  const { currentTime } = useTime();
  if (end <= start) return null;
  const fraction = (currentTime - start) / (end - start);
  if (fraction < 0 || fraction > 1) return null;
  const left = CHART_MARGIN.left + Y_AXIS_WIDTH;
  return (
    <div
      className="pointer-events-none absolute w-[1.5px] bg-[var(--playhead)] opacity-70"
      style={{
        top: CHART_MARGIN.top,
        bottom: CHART_MARGIN.bottom + X_AXIS_HEIGHT,
        left: `calc(${left}px + (100% - ${left + CHART_MARGIN.right}px) * ${fraction})`,
      }}
    />
  );
}

function mergeGroups(data: ChartRow[][]): ChartRow[] {
  if (data.length <= 1) return data[0] ?? [];
  const maxLen = Math.max(...data.map((g) => g.length));
  const merged: ChartRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: ChartRow = {};
    for (const group of data) {
      const src = group[i];
      if (!src) continue;
      for (const [k, v] of Object.entries(src)) {
        if (k === "timestamp") {
          row[k] = v;
          continue;
        }
        row[k] = v;
      }
    }
    merged.push(row);
  }
  return merged;
}

export const DataRecharts = React.memo(
  ({ data, onChartsReady }: DataGraphProps) => {
    const [hoverStore] = useState(createHoverStore);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
      if (typeof onChartsReady === "function") onChartsReady();
    }, [onChartsReady]);

    const combinedData = useMemo(
      () => (expanded ? mergeGroups(data) : []),
      [data, expanded],
    );

    if (!Array.isArray(data) || data.length === 0) return null;

    return (
      <div>
        {data.length > 1 && (
          <div className="flex justify-end mb-2">
            <button
              onClick={() => setExpanded((v) => !v)}
              className={`btn ${expanded ? "btn-active" : ""}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {expanded ? (
                  <>
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                ) : (
                  <>
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                )}
              </svg>
              {expanded ? "Split charts" : "Combine all"}
            </button>
          </div>
        )}

        {expanded ? (
          <SingleDataGraph data={combinedData} hoverStore={hoverStore} tall />
        ) : (
          <div className="grid md:grid-cols-2 grid-cols-1 gap-4">
            {data.map((group, idx) => (
              <SingleDataGraph key={idx} data={group} hoverStore={hoverStore} />
            ))}
          </div>
        )}
      </div>
    );
  },
);

/** Series toggles with each series' value at the hovered time, or the playback time. */
function ChartLegend({
  chartData,
  groups,
  singles,
  groupColorMap,
  visibleKeys,
  setVisibleKeys,
  hoverStore,
}: {
  chartData: Record<string, number>[];
  groups: Record<string, string[]>;
  singles: string[];
  groupColorMap: Record<string, string>;
  visibleKeys: string[];
  setVisibleKeys: React.Dispatch<React.SetStateAction<string[]>>;
  hoverStore: HoverStore;
}) {
  const { currentTime } = useTime();
  const hoveredTime = useSyncExternalStore(
    hoverStore.subscribe,
    hoverStore.get,
    hoverStore.get,
  );
  const closestIndex = closestDataIndex(
    chartData,
    hoveredTime != null ? hoveredTime : currentTime,
  );
  const currentData = chartData[closestIndex] || {};

  const isGroupChecked = (group: string) =>
    groups[group].every((k) => visibleKeys.includes(k));
  const isGroupIndeterminate = (group: string) =>
    groups[group].some((k) => visibleKeys.includes(k)) &&
    !isGroupChecked(group);

  const handleGroupCheckboxChange = (group: string) => {
    if (isGroupChecked(group)) {
      // Uncheck all children
      setVisibleKeys((prev) => prev.filter((k) => !groups[group].includes(k)));
    } else {
      // Check all children
      setVisibleKeys((prev) =>
        Array.from(new Set([...prev, ...groups[group]])),
      );
    }
  };

  const handleCheckboxChange = (key: string) => {
    setVisibleKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 px-1 pt-2">
      {Object.entries(groups).map(([group, children]) => {
        const color = groupColorMap[group];
        return (
          <div key={group}>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isGroupChecked(group)}
                ref={(el) => {
                  if (el) el.indeterminate = isGroupIndeterminate(group);
                }}
                onChange={() => handleGroupCheckboxChange(group)}
                className="size-3"
                style={{ accentColor: color }}
              />
              <span className="text-xs font-semibold text-fg">{group}</span>
            </label>
            <div className="pl-5 flex flex-col gap-0.5 mt-0.5">
              {children.map((key) => {
                const label = key.split(SERIES_NAME_DELIMITER).pop() ?? key;
                return (
                  <label
                    key={key}
                    className="flex items-center gap-1.5 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={visibleKeys.includes(key)}
                      onChange={() => handleCheckboxChange(key)}
                      className="size-2.5"
                      style={{ accentColor: color }}
                    />
                    <span
                      className={`text-xs ${visibleKeys.includes(key) ? "text-fg-soft" : "text-fg-faint"}`}
                    >
                      {label}
                    </span>
                    <span
                      className={`text-xs font-mono tabular-nums ml-1 ${visibleKeys.includes(key) ? "text-accent-fg/80" : "text-fg-faint"}`}
                    >
                      {typeof currentData[key] === "number"
                        ? currentData[key].toFixed(2)
                        : "–"}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {singles.map((key) => {
        const color = groupColorMap[key];
        return (
          <label
            key={key}
            className="flex items-center gap-1.5 cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={visibleKeys.includes(key)}
              onChange={() => handleCheckboxChange(key)}
              className="size-3"
              style={{ accentColor: color }}
            />
            <span
              className={`text-xs ${visibleKeys.includes(key) ? "text-fg" : "text-fg-faint"}`}
            >
              {key}
            </span>
            <span
              className={`text-xs font-mono tabular-nums ml-1 ${visibleKeys.includes(key) ? "text-accent-fg/80" : "text-fg-faint"}`}
            >
              {typeof currentData[key] === "number"
                ? currentData[key].toFixed(2)
                : "–"}
            </span>
          </label>
        );
      })}
    </div>
  );
}

const SingleDataGraph = React.memo(
  ({
    data,
    hoverStore,
    tall,
  }: {
    data: ChartRow[];
    hoverStore: HoverStore;
    tall?: boolean;
  }) => {
    const { seek } = useTimeControls();
    const flattenRow = useCallback(
      (row: Record<string, number | Record<string, number>>, prefix = "") => {
        const result: Record<string, number> = {};
        for (const [key, value] of Object.entries(row)) {
          // Special case: if this is a group value that is a primitive, assign to prefix.key
          if (typeof value === "number") {
            if (prefix) {
              result[`${prefix}${SERIES_NAME_DELIMITER}${key}`] = value;
            } else {
              result[key] = value;
            }
          } else if (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            // If it's an object, recurse
            Object.assign(
              result,
              flattenRow(
                value,
                prefix ? `${prefix}${SERIES_NAME_DELIMITER}${key}` : key,
              ),
            );
          }
        }
        if ("timestamp" in row && typeof row["timestamp"] === "number") {
          result["timestamp"] = row["timestamp"];
        }
        return result;
      },
      [],
    );

    // Flatten all rows for recharts
    const chartData = useMemo(() => data.map((row) => flattenRow(row)), [data]);

    // dataKeys is purely derived from chartData — compute it during render,
    // not via a useState + useEffect that would force an extra render and
    // briefly leak the previous chart's keys after `data` changes.
    // Vercel rule: rerender-derived-state-no-effect.
    const dataKeys = useMemo(() => {
      const first = chartData[0];
      if (!first) return [];
      return Object.keys(first).filter((k) => k !== "timestamp");
    }, [chartData]);

    // visibleKeys IS user-facing state (column toggles). Reset it whenever
    // the underlying schema changes — keying off the joined dataKeys string
    // catches both episode navigations and combine/split toggles.
    const dataKeysSig = dataKeys.join("|");
    const [visibleKeys, setVisibleKeys] = useState<string[]>(dataKeys);
    const lastSigRef = useRef(dataKeysSig);
    if (lastSigRef.current !== dataKeysSig) {
      lastSigRef.current = dataKeysSig;
      // Setting state during render is fine here — React schedules a
      // re-render and discards the in-progress one. This pattern is
      // documented as "Storing information from previous renders".
      setVisibleKeys(dataKeys);
    }

    const { groups, singles, groupColorMap } = useMemo(() => {
      const grouped: Record<string, string[]> = {};
      const singleList: string[] = [];
      dataKeys.forEach((key) => {
        const parts = key.split(SERIES_NAME_DELIMITER);
        if (parts.length > 1) {
          const group = parts[0];
          if (!grouped[group]) grouped[group] = [];
          grouped[group].push(key);
        } else {
          singleList.push(key);
        }
      });

      const allGroups = [...Object.keys(grouped), ...singleList];
      const colorMap: Record<string, string> = {};
      allGroups.forEach((group, idx) => {
        colorMap[group] = CHART_COLORS[idx % CHART_COLORS.length];
      });
      return { groups: grouped, singles: singleList, groupColorMap: colorMap };
    }, [dataKeys]);

    const handleMouseLeave = () => hoverStore.set(null);

    const handleClick = (
      data: { activePayload?: { payload: { timestamp: number } }[] } | null,
    ) => {
      if (data?.activePayload?.length) {
        seek(data.activePayload[0].payload.timestamp);
      }
    };

    // Derive chart title from the grouped feature names
    const chartTitle = useMemo(() => {
      const featureNames = Object.keys(groups);
      if (featureNames.length > 0) {
        const suffixes = featureNames.map((g) => {
          const parts = g.split(SERIES_NAME_DELIMITER);
          return parts[parts.length - 1];
        });
        return suffixes.join(", ");
      }
      return singles.join(", ");
    }, [groups, singles]);

    return (
      <div className="w-full bg-[var(--surface-1)]/40 rounded-lg border border-line p-3">
        {chartTitle && (
          <p
            className="text-xs font-medium text-fg-soft mb-1 px-1 truncate"
            title={chartTitle}
          >
            {chartTitle}
          </p>
        )}
        <div
          className={`relative w-full ${tall ? "h-[500px]" : "h-72"}`}
          onMouseLeave={handleMouseLeave}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              syncId="episode-sync"
              margin={CHART_MARGIN}
              onClick={handleClick}
              onMouseMove={(state) => {
                const payload = state?.activePayload?.[0]?.payload as
                  | { timestamp?: number }
                  | undefined;
                hoverStore.set(payload?.timestamp ?? null);
              }}
              onMouseLeave={handleMouseLeave}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--chart-grid)"
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="timestamp"
                domain={[
                  chartData.at(0)?.timestamp ?? 0,
                  chartData.at(-1)?.timestamp ?? 0,
                ]}
                tickFormatter={(v: number) => `${v.toFixed(1)}s`}
                stroke="var(--chart-axis)"
                tick={{ fontSize: 12, fill: "var(--fg-muted)" }}
                minTickGap={30}
                height={X_AXIS_HEIGHT}
                allowDataOverflow={true}
              />
              <YAxis
                domain={["auto", "auto"]}
                stroke="var(--chart-axis)"
                tick={{ fontSize: 12, fill: "var(--fg-muted)" }}
                width={Y_AXIS_WIDTH}
                allowDataOverflow={true}
                tickFormatter={(v: number) => {
                  if (v === 0) return "0";
                  const abs = Math.abs(v);
                  if (abs < 0.01 || abs >= 10000) return v.toExponential(1);
                  return Number(v.toFixed(2)).toString();
                }}
              />

              <Tooltip content={() => null} isAnimationActive={false} />

              {dataKeys.map((key) => {
                const group = key.includes(SERIES_NAME_DELIMITER)
                  ? key.split(SERIES_NAME_DELIMITER)[0]
                  : key;
                const color = groupColorMap[group];
                let strokeDasharray: string | undefined = undefined;
                if (groups[group] && groups[group].length > 1) {
                  const idxInGroup = groups[group].indexOf(key);
                  if (idxInGroup > 0) strokeDasharray = "5 5";
                }
                return (
                  visibleKeys.includes(key) && (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={key}
                      stroke={color}
                      strokeDasharray={strokeDasharray}
                      dot={false}
                      activeDot={false}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                  )
                );
              })}
            </LineChart>
          </ResponsiveContainer>
          <PlaybackCursor
            start={chartData.at(0)?.timestamp ?? 0}
            end={chartData.at(-1)?.timestamp ?? 0}
          />
        </div>
        <ChartLegend
          chartData={chartData}
          groups={groups}
          singles={singles}
          groupColorMap={groupColorMap}
          visibleKeys={visibleKeys}
          setVisibleKeys={setVisibleKeys}
          hoverStore={hoverStore}
        />
      </div>
    );
  },
); // End React.memo

SingleDataGraph.displayName = "SingleDataGraph";
DataRecharts.displayName = "DataGraph";
export default DataRecharts;

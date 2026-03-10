"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTime, useTimeControl } from "../context/time-context";
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
    const [hoveredTime, setHoveredTime] = useState<number | null>(null);
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
              className={`text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 ${
                expanded
                  ? "bg-orange-500/20 text-orange-400 border border-orange-500/40"
                  : "bg-slate-800/60 text-slate-400 hover:text-slate-200 border border-slate-700/50"
              }`}
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
          <SingleDataGraph
            data={combinedData}
            hoveredTime={hoveredTime}
            setHoveredTime={setHoveredTime}
            tall
          />
        ) : (
          <div className="grid md:grid-cols-2 grid-cols-1 gap-4">
            {data.map((group, idx) => (
              <SingleDataGraph
                key={idx}
                data={group}
                hoveredTime={hoveredTime}
                setHoveredTime={setHoveredTime}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);

const SingleDataGraph = React.memo(
  ({
    data,
    hoveredTime,
    setHoveredTime,
    tall,
  }: {
    data: ChartRow[];
    hoveredTime: number | null;
    setHoveredTime: (t: number | null) => void;
    tall?: boolean;
  }) => {
    const { setCurrentTime } = useTime();
    const { subscribe } = useTimeControl();
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
    const chartData = useMemo(
      () => data.map((row) => flattenRow(row)),
      [data, flattenRow],
    );
    const [dataKeys, setDataKeys] = useState<string[]>([]);
    const [visibleKeys, setVisibleKeys] = useState<string[]>([]);

    useEffect(() => {
      if (!chartData || chartData.length === 0) return;
      // Get all keys except timestamp from the first row
      const keys = Object.keys(chartData[0]).filter((k) => k !== "timestamp");
      setDataKeys(keys);
      setVisibleKeys(keys);
    }, [chartData]);

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

    // Find the closest data point to the current time for highlighting
    const findClosestDataIndex = (time: number) => {
      if (!chartData.length) return 0;
      const idx = chartData.findIndex((point) => point.timestamp >= time);
      if (idx !== -1) return idx;
      return chartData.length - 1;
    };

    // ── Imperative cursor ────────────────────────────────────────────────────
    // Instead of a Recharts ReferenceLine (which re-renders the entire SVG on
    // every time update), we overlay a plain div and move it via style.left.
    const containerRef = useRef<HTMLDivElement>(null);
    const cursorRef = useRef<HTMLDivElement>(null);
    const plotBoundsRef = useRef({ left: 0, width: 0, top: 0, height: 0 });

    const minTime = useMemo(() => chartData[0]?.timestamp ?? 0, [chartData]);
    const maxTime = useMemo(
      () => chartData[chartData.length - 1]?.timestamp ?? 1,
      [chartData],
    );
    const minTimeRef = useRef(minTime);
    const maxTimeRef = useRef(maxTime);
    useEffect(() => {
      minTimeRef.current = minTime;
      maxTimeRef.current = maxTime;
    }, [minTime, maxTime]);

    const chartDataRef = useRef(chartData);
    useEffect(() => { chartDataRef.current = chartData; }, [chartData]);

    // Measure the cartesian-grid element to know the exact plot-area bounds.
    const measurePlot = useCallback(() => {
      const cont = containerRef.current;
      if (!cont) return;
      const grid = cont.querySelector(".recharts-cartesian-grid");
      if (!grid) return;
      const gr = grid.getBoundingClientRect();
      const cr = cont.getBoundingClientRect();
      plotBoundsRef.current = {
        left: gr.left - cr.left,
        width: gr.width,
        top: gr.top - cr.top,
        height: gr.height,
      };
    }, []);

    useLayoutEffect(() => {
      const id = setTimeout(measurePlot, 50);
      return () => clearTimeout(id);
    }, [measurePlot, chartData, dataKeys]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(measurePlot);
      ro.observe(el);
      return () => ro.disconnect();
    }, [measurePlot]);

    // ── Imperative legend values ─────────────────────────────────────────────
    const legendValueRefs = useRef(new Map<string, HTMLSpanElement | null>());
    const hoveredTimeRef = useRef(hoveredTime);
    useEffect(() => { hoveredTimeRef.current = hoveredTime; }, [hoveredTime]);

    const updateLegendValues = useCallback((time: number) => {
      const idx = findClosestDataIndex(time);
      const row = chartDataRef.current[idx] || {};
      legendValueRefs.current.forEach((el, key) => {
        if (el) {
          el.textContent =
            typeof row[key] === "number"
              ? (row[key] as number).toFixed(3)
              : "–";
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (hoveredTime !== null) updateLegendValues(hoveredTime);
    }, [hoveredTime, updateLegendValues]);

    // ── Subscribe: move cursor div + update legend on every time tick ────────
    const latestTimeRef = useRef(0);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      return subscribe((t) => {
        latestTimeRef.current = t;

        if (cursorRef.current && plotBoundsRef.current.width > 0) {
          const { left, width, top, height } = plotBoundsRef.current;
          const tMin = minTimeRef.current;
          const tMax = maxTimeRef.current;
          const p =
            tMax > tMin
              ? Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin)))
              : 0;
          const cur = cursorRef.current;
          cur.style.left = `${left + p * width}px`;
          cur.style.top = `${top}px`;
          cur.style.height = `${height}px`;
          cur.style.display = "block";
        }

        if (hoveredTimeRef.current === null) updateLegendValues(t);

        // Settle: snap to exact position 100 ms after movement stops
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
          if (cursorRef.current && plotBoundsRef.current.width > 0) {
            const { left, width, top, height } = plotBoundsRef.current;
            const tMin = minTimeRef.current;
            const tMax = maxTimeRef.current;
            const p =
              tMax > tMin
                ? Math.max(0, Math.min(1, (latestTimeRef.current - tMin) / (tMax - tMin)))
                : 0;
            cursorRef.current.style.left = `${left + p * width}px`;
            cursorRef.current.style.top = `${top}px`;
            cursorRef.current.style.height = `${height}px`;
          }
          if (hoveredTimeRef.current === null) updateLegendValues(latestTimeRef.current);
        }, 100);
      });
    }, [subscribe, updateLegendValues]);

    const handleMouseLeave = () => {
      setHoveredTime(null);
    };

    const handleClick = (
      data: { activePayload?: { payload: { timestamp: number } }[] } | null,
    ) => {
      if (data?.activePayload?.length) {
        setCurrentTime(data.activePayload[0].payload.timestamp);
      }
    };

    // Custom legend — series value spans are updated imperatively via
    // legendValueRefs so the legend never re-renders on time updates.
    const CustomLegend = () => {
      const isGroupChecked = (group: string) =>
        groups[group].every((k) => visibleKeys.includes(k));
      const isGroupIndeterminate = (group: string) =>
        groups[group].some((k) => visibleKeys.includes(k)) &&
        !isGroupChecked(group);

      const handleGroupCheckboxChange = (group: string) => {
        if (isGroupChecked(group)) {
          // Uncheck all children
          setVisibleKeys((prev) =>
            prev.filter((k) => !groups[group].includes(k)),
          );
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
                  <span className="text-xs font-semibold text-slate-200">
                    {group}
                  </span>
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
                          className={`text-xs ${visibleKeys.includes(key) ? "text-slate-300" : "text-slate-500"}`}
                        >
                          {label}
                        </span>
                        <span
                          ref={(el) => legendValueRefs.current.set(key, el)}
                          className={`text-xs font-mono tabular-nums ml-1 ${visibleKeys.includes(key) ? "text-orange-300/80" : "text-slate-600"}`}
                        >
                          –
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
                  className={`text-xs ${visibleKeys.includes(key) ? "text-slate-200" : "text-slate-500"}`}
                >
                  {key}
                </span>
                <span
                  ref={(el) => legendValueRefs.current.set(key, el)}
                  className={`text-xs font-mono tabular-nums ml-1 ${visibleKeys.includes(key) ? "text-orange-300/80" : "text-slate-600"}`}
                >
                  –
                </span>
              </label>
            );
          })}
        </div>
      );
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
      <div className="w-full bg-slate-800/40 rounded-lg border border-slate-700/50 p-3">
        {chartTitle && (
          <p
            className="text-xs font-medium text-slate-300 mb-1 px-1 truncate"
            title={chartTitle}
          >
            {chartTitle}
          </p>
        )}
        {/* Relative wrapper so the imperative cursor div can be positioned
            inside the chart area without affecting Recharts' own layout. */}
        <div
          ref={containerRef}
          className={`relative w-full ${tall ? "h-[500px]" : "h-72"}`}
          onMouseLeave={handleMouseLeave}
        >
          {/* Cursor line — moved imperatively by the subscribe callback.
              display:none until the first time update fires. */}
          <div
            ref={cursorRef}
            style={{
              display: "none",
              position: "absolute",
              width: 2,
              background: "#f97316",
              opacity: 0.7,
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              syncId="episode-sync"
              margin={{ top: 12, right: 12, left: -8, bottom: 8 }}
              onClick={handleClick}
              onMouseMove={(state) => {
                const payload = state?.activePayload?.[0]?.payload as
                  | { timestamp?: number }
                  | undefined;
                setHoveredTime(payload?.timestamp ?? null);
              }}
              onMouseLeave={handleMouseLeave}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#334155"
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="linear"
                domain={[
                  chartData.at(0)?.timestamp ?? 0,
                  chartData.at(-1)?.timestamp ?? 0,
                ]}
                tickFormatter={(v: number) => `${v.toFixed(1)}s`}
                stroke="#64748b"
                tick={{ fontSize: 12, fill: "#94a3b8" }}
                minTickGap={30}
                allowDataOverflow={true}
              />
              <YAxis
                domain={["auto", "auto"]}
                stroke="#64748b"
                tick={{ fontSize: 12, fill: "#94a3b8" }}
                width={55}
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
        </div>
        <CustomLegend />
      </div>
    );
  },
); // End React.memo

SingleDataGraph.displayName = "SingleDataGraph";
DataRecharts.displayName = "DataGraph";
export default DataRecharts;

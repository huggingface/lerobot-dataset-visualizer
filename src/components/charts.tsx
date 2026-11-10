"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Charts for the analysis tabs, drawn as plain SVG at the size of their container. Marks take the
 * series tokens (`--series-N`), grids and axes the chart tokens, text the text tokens.
 */

/** The width of an element, kept current as it resizes; 0 until it is first measured. */
export function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round tick values covering `[0, max]`: at most `count` steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ??
    rough;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step) {
    // Sums of 0.1-style steps drift: 0.30000000000000004.
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export type HistogramBin = {
  lo: number;
  hi: number;
  count: number;
};

const MARGIN = { top: 20, right: 10, bottom: 24, left: 38 };

/** A bar from the baseline up, rounded at its data end and square at the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/**
 * A histogram: one bar per bin, a readout on hover or focus, and, with `onSelect`, bins that can
 * be picked. The same numbers are in a table for screen readers.
 */
export function Histogram({
  bins,
  height = 190,
  formatValue,
  describeCount,
  marker,
  selected = null,
  onSelect,
  ariaLabel,
}: {
  bins: HistogramBin[];
  height?: number;
  /** A bin edge or marker value, with its unit: `4.5 s`. */
  formatValue: (value: number) => string;
  /** What a bar's height counts: `16 episodes`. */
  describeCount: (count: number) => string;
  marker?: { value: number; label: string };
  selected?: number | null;
  onSelect?: (index: number | null) => void;
  ariaLabel: string;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);
  /** The bin holding keyboard focus, to mark it; a mouse click focuses too but needs no mark. */
  const [focused, setFocused] = useState<number | null>(null);

  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  const yTicks = niceTicks(maxCount, 3);
  const yMax = yTicks[yTicks.length - 1] || 1;

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const lo = bins[0]?.lo ?? 0;
  const hi = bins[bins.length - 1]?.hi ?? 1;
  // Every length the same: a single bar in the middle rather than a zero-width axis.
  const flat = hi === lo;
  const xOf = (value: number) =>
    MARGIN.left + (flat ? 0.5 : (value - lo) / (hi - lo)) * plotWidth;
  const yOf = (count: number) =>
    MARGIN.top + plotHeight - (count / yMax) * plotHeight;
  const slot = (bin: HistogramBin) =>
    flat
      ? { x: MARGIN.left + plotWidth * 0.35, width: plotWidth * 0.3 }
      : { x: xOf(bin.lo), width: xOf(bin.hi) - xOf(bin.lo) };

  // Bin edges as x ticks, thinned so their labels do not touch.
  const edgeStep = Math.max(
    1,
    Math.ceil((bins.length * 64) / (plotWidth || 1)),
  );
  const range = (bin: HistogramBin) =>
    flat
      ? formatValue(bin.lo)
      : `${formatValue(bin.lo)} – ${formatValue(bin.hi)}`;
  const share = (count: number) =>
    total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";

  const active = hovered ?? null;
  const activeBin = active !== null ? bins[active] : null;
  const activeSlot = activeBin ? slot(activeBin) : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="group"
          aria-label={ariaLabel}
          className="block"
        >
          {/* Grid and count axis */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={yOf(tick)}
                y2={yOf(tick)}
                stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 6}
                y={yOf(tick)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                className="fill-fg-muted tabular"
              >
                {tick}
              </text>
            </g>
          ))}

          {/* Bars: a 2px gap of surface between neighbours, no outline. */}
          {bins.map((bin, i) => {
            if (bin.count === 0) return null;
            const { x, width: w } = slot(bin);
            const y = yOf(bin.count);
            const dimmed = selected !== null && selected !== i;
            return (
              <path
                key={i}
                d={barPath(
                  x + 1,
                  y,
                  Math.max(1, w - 2),
                  MARGIN.top + plotHeight - y,
                )}
                fill={selected === i ? "var(--accent)" : "var(--series-1)"}
                opacity={active === i ? 1 : dimmed ? 0.45 : 0.85}
              />
            );
          })}

          {/* Bin edges */}
          {!flat &&
            bins.map((bin, i) =>
              i % edgeStep === 0 ? (
                <text
                  key={i}
                  x={xOf(bin.lo)}
                  y={height - 7}
                  textAnchor={i === 0 ? "start" : "middle"}
                  fontSize={11}
                  className="fill-fg-muted tabular"
                >
                  {formatValue(bin.lo)}
                </text>
              ) : null,
            )}
          {flat && (
            <text
              x={MARGIN.left + plotWidth / 2}
              y={height - 7}
              textAnchor="middle"
              fontSize={11}
              className="fill-fg-muted tabular"
            >
              {formatValue(lo)}
            </text>
          )}

          {/* Reference value (the median) */}
          {marker && !flat && marker.value >= lo && marker.value <= hi && (
            <g pointerEvents="none">
              <line
                x1={xOf(marker.value)}
                x2={xOf(marker.value)}
                y1={MARGIN.top - 4}
                y2={MARGIN.top + plotHeight}
                stroke="var(--fg-soft)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={xOf(marker.value)}
                y={10}
                textAnchor={
                  xOf(marker.value) > MARGIN.left + plotWidth * 0.8
                    ? "end"
                    : xOf(marker.value) < MARGIN.left + plotWidth * 0.2
                      ? "start"
                      : "middle"
                }
                fontSize={11}
                className="fill-fg-soft tabular"
              >
                {marker.label}
              </text>
            </g>
          )}

          {focused !== null && bins[focused] && (
            <rect
              x={slot(bins[focused]).x + 1}
              y={MARGIN.top + plotHeight + 2}
              width={Math.max(1, slot(bins[focused]).width - 2)}
              height={2}
              rx={1}
              fill="var(--accent)"
              pointerEvents="none"
            />
          )}

          {/* Hit areas: the whole column, so an empty or short bin is as easy to reach. */}
          {bins.map((bin, i) => {
            const { x, width: w } = slot(bin);
            const label = `${range(bin)}: ${describeCount(bin.count)}`;
            return (
              <rect
                key={i}
                x={x}
                y={MARGIN.top}
                width={Math.max(1, w)}
                height={plotHeight}
                fill="transparent"
                className={`outline-none ${onSelect ? "cursor-pointer" : ""}`}
                tabIndex={0}
                role={onSelect ? "button" : "img"}
                aria-label={label}
                aria-pressed={onSelect ? selected === i : undefined}
                onPointerEnter={() => setHovered(i)}
                onPointerLeave={() => setHovered((h) => (h === i ? null : h))}
                onFocus={(e) => {
                  setHovered(i);
                  if (e.currentTarget.matches(":focus-visible")) setFocused(i);
                }}
                onBlur={() => {
                  setHovered((h) => (h === i ? null : h));
                  setFocused((f) => (f === i ? null : f));
                }}
                onClick={() => onSelect?.(selected === i ? null : i)}
                onKeyDown={(e) => {
                  if (!onSelect || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  // The viewer plays and pauses on Space; this press picks a bin.
                  e.stopPropagation();
                  onSelect(selected === i ? null : i);
                }}
              />
            );
          })}
        </svg>
      )}

      {activeBin && activeSlot && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-[var(--surface-2)] px-2 py-1 text-xs shadow-lg"
          style={{
            left: Math.min(
              Math.max(activeSlot.x + activeSlot.width / 2, 70),
              width - 70,
            ),
            top: Math.max(0, yOf(activeBin.count) - 44),
          }}
        >
          <p className="font-semibold text-fg tabular">
            {describeCount(activeBin.count)}
            <span className="ml-1.5 font-normal text-fg-muted">
              {share(activeBin.count)}
            </span>
          </p>
          <p className="text-fg-muted tabular">{range(activeBin)}</p>
        </div>
      )}

      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>Range</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin, i) => (
            <tr key={i}>
              <td>{range(bin)}</td>
              <td>{describeCount(bin.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Where a statistic's spread sits on a shared scale: the full range as a pale bar, one standard
 * deviation either side of the mean as a solid one, the mean as a tick.
 */
export function RangeBar({
  min,
  max,
  mean,
  std,
  scaleMin,
  scaleMax,
  label,
}: {
  min: number;
  max: number;
  mean: number;
  std: number;
  scaleMin: number;
  scaleMax: number;
  label: string;
}) {
  const span = scaleMax - scaleMin || 1;
  const at = (value: number) =>
    Math.max(0, Math.min(100, ((value - scaleMin) / span) * 100));
  const bandLo = at(Math.max(min, mean - std));
  const bandHi = at(Math.min(max, mean + std));
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className="relative h-3 w-full min-w-24"
    >
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--chart-grid)]" />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--series-1)] opacity-30"
        style={{
          left: `${at(min)}%`,
          width: `${Math.max(0.5, at(max) - at(min))}%`,
        }}
      />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--series-1)]"
        style={{
          left: `${bandLo}%`,
          width: `${Math.max(0.5, bandHi - bandLo)}%`,
        }}
      />
      <div
        className="absolute top-0 h-3 w-0.5 -translate-x-1/2 rounded-full bg-[var(--fg)]"
        style={{ left: `${at(mean)}%` }}
      />
    </div>
  );
}

/**
 * How series number `index` is drawn. Eight hues, in their fixed order; past the eighth the same
 * hues come round dashed, so a ninth series is still told from the first by more than position.
 * Past sixteen there is nothing left to tell them apart with: those are drawn muted.
 */
export function seriesStyle(index: number): {
  color: string;
  dash: string | undefined;
} {
  if (index >= 16) return { color: "var(--fg-faint)", dash: "2 3" };
  return {
    color: `var(--series-${(index % 8) + 1})`,
    dash: index >= 8 ? "6 4" : undefined,
  };
}

/** A legend entry's key: a short stroke drawn the way the series is. */
export function LineKey({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="18" height="6" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        x2="17"
        y1="3"
        y2="3"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

/**
 * The legend of a line chart. Pointing at (or focusing) an entry reports it through `onHighlight`,
 * so the chart can lift that line out of the others.
 */
export function SeriesLegend({
  series,
  highlighted,
  onHighlight,
}: {
  series: { name: string; color: string; dash?: string; note?: string }[];
  highlighted?: string | null;
  onHighlight?: (name: string | null) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-1">
      {series.map(({ name, color, dash, note }) => (
        <li key={name}>
          <button
            type="button"
            tabIndex={onHighlight ? 0 : -1}
            onPointerEnter={() => onHighlight?.(name)}
            onPointerLeave={() => onHighlight?.(null)}
            onFocus={() => onHighlight?.(name)}
            onBlur={() => onHighlight?.(null)}
            className={`flex items-center gap-1.5 rounded text-xs transition-opacity ${
              onHighlight ? "cursor-default" : "pointer-events-none"
            } ${highlighted && highlighted !== name ? "opacity-40" : ""}`}
          >
            <LineKey color={color} dash={dash} />
            <span className="text-fg-muted">
              {name}
              {note && <span className="ml-1 text-fg-faint">{note}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One hue, light to dark: the steps a magnitude is coloured with. */
const SEQUENTIAL = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
].map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

/** The palest step the dark theme uses: the two beyond it glare against a dark page. */
const DARK_PALEST = 2;

/**
 * The colour of magnitude `t` in [0, 1]. Zero is the step nearest the surface, so "nothing" recedes
 * into the background in either theme: pale on light, deep on dark.
 */
export function sequentialColor(t: number, theme: "light" | "dark"): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const last = SEQUENTIAL.length - 1;
  const position =
    theme === "dark" ? last - clamped * (last - DARK_PALEST) : clamped * last;
  const lower = Math.floor(position);
  const upper = Math.min(SEQUENTIAL.length - 1, lower + 1);
  const mix = position - lower;
  const channel = (c: number) =>
    Math.round(
      SEQUENTIAL[lower][c] +
        (SEQUENTIAL[upper][c] - SEQUENTIAL[lower][c]) * mix,
    );
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

const HEATMAP_LABEL_WIDTH = 132;

/**
 * A grid of magnitudes: one row per label, one column per step along x, coloured from zero to the
 * largest value. Pointing at a cell reads it out.
 */
export function Heatmap({
  rows,
  theme,
  xTicks,
  xLabel,
  formatValue,
  describeColumn,
  legend,
  ariaLabel,
}: {
  rows: { label: string; values: number[] }[];
  theme: "light" | "dark";
  /** Positions along x, as fractions of the width, with their labels. */
  xTicks: { at: number; label: string }[];
  xLabel: string;
  formatValue: (value: number) => string;
  /** What column `index` stands for, in the readout: `at 40% of the episode`. */
  describeColumn: (index: number) => string;
  /** What the colour measures, for the scale. */
  legend: string;
  ariaLabel: string;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<{ row: number; col: number } | null>(
    null,
  );
  const columns = rows[0]?.values.length ?? 0;
  const max = Math.max(...rows.flatMap((row) => row.values), 0);
  const rowHeight = rows.length <= 8 ? 26 : rows.length <= 16 ? 20 : 14;
  const plotWidth = Math.max(0, width - HEATMAP_LABEL_WIDTH - 4);
  const cellWidth = columns > 0 ? plotWidth / columns : 0;
  const plotHeight = rows.length * rowHeight;
  const height = plotHeight + 34;
  const colorOf = (value: number) =>
    sequentialColor(max > 0 ? value / max : 0, theme);
  const cell = hovered ? rows[hovered.row].values[hovered.col] : 0;

  return (
    <div className="space-y-2">
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel}
            className="block"
            onPointerLeave={() => setHovered(null)}
          >
            {rows.map((row, r) => (
              <g key={row.label}>
                <text
                  x={HEATMAP_LABEL_WIDTH - 8}
                  y={r * rowHeight + rowHeight / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={Math.min(12, rowHeight - 3)}
                  className={hovered?.row === r ? "fill-fg" : "fill-fg-muted"}
                >
                  {row.label.length > 18
                    ? `${row.label.slice(0, 17)}…`
                    : row.label}
                  <title>{row.label}</title>
                </text>
                {row.values.map((value, c) => (
                  <rect
                    key={c}
                    x={HEATMAP_LABEL_WIDTH + c * cellWidth}
                    y={r * rowHeight}
                    // A hairline of surface between cells, rather than an outline around each.
                    width={Math.max(0.5, cellWidth - 1)}
                    height={rowHeight - 1}
                    fill={colorOf(value)}
                    onPointerEnter={() => setHovered({ row: r, col: c })}
                  />
                ))}
              </g>
            ))}
            {hovered && (
              <rect
                x={HEATMAP_LABEL_WIDTH + hovered.col * cellWidth - 0.5}
                y={hovered.row * rowHeight - 0.5}
                width={cellWidth}
                height={rowHeight}
                fill="none"
                stroke="var(--fg)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            )}
            {xTicks.map(({ at, label }) => (
              <text
                key={label}
                x={HEATMAP_LABEL_WIDTH + at * plotWidth}
                y={plotHeight + 14}
                textAnchor={at <= 0 ? "start" : at >= 1 ? "end" : "middle"}
                fontSize={11}
                className="fill-fg-muted tabular"
              >
                {label}
              </text>
            ))}
            <text
              x={HEATMAP_LABEL_WIDTH + plotWidth / 2}
              y={plotHeight + 30}
              textAnchor="middle"
              fontSize={11}
              className="fill-fg-faint"
            >
              {xLabel}
            </text>
          </svg>
        )}
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-[var(--surface-2)] px-2 py-1 text-xs shadow-lg"
            style={{
              left: Math.min(
                Math.max(
                  HEATMAP_LABEL_WIDTH + (hovered.col + 0.5) * cellWidth,
                  90,
                ),
                width - 90,
              ),
              top:
                hovered.row * rowHeight > 46
                  ? hovered.row * rowHeight - 46
                  : (hovered.row + 1) * rowHeight + 4,
            }}
          >
            <p className="font-semibold text-fg tabular">{formatValue(cell)}</p>
            <p className="text-fg-muted">
              {rows[hovered.row].label} · {describeColumn(hovered.col)}
            </p>
          </div>
        )}
      </div>

      {/* The scale: what the colour measures, from nothing to the largest value drawn. */}
      <div
        className="flex items-center gap-2 text-[11px] text-fg-muted"
        style={{ paddingLeft: HEATMAP_LABEL_WIDTH }}
      >
        <span className="tabular">{formatValue(0)}</span>
        <div
          className="h-2 w-32 rounded-sm"
          style={{
            background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
              .map((t) => sequentialColor(t, theme))
              .join(", ")})`,
          }}
        />
        <span className="tabular">{formatValue(max)}</span>
        <span className="ml-1 text-fg-faint">{legend}</span>
      </div>

      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>Row</th>
            <th>Lowest</th>
            <th>Mean</th>
            <th>Highest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{formatValue(Math.min(...row.values))}</td>
              <td>
                {formatValue(
                  row.values.reduce((a, b) => a + b, 0) /
                    (row.values.length || 1),
                )}
              </td>
              <td>{formatValue(Math.max(...row.values))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bins covering `values` with round edges (a width of 1, 2, 2.5 or 5 × 10ⁿ), about `target` of
 * them, for the shared Histogram.
 */
export function roundBins(values: number[], target: number): HistogramBin[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max === min) return [{ lo: min, hi: max, count: values.length }];
  const rough = (max - min) / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const width =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((w) => w >= rough) ??
    rough;
  const lo = Math.floor(min / width) * width;
  // One more bin when the largest value sits exactly on an edge, so it has a bin to fall in.
  const count = Math.max(1, Math.floor((max - lo) / width) + 1);
  const edge = (i: number) => Number((lo + i * width).toPrecision(12));
  const bins = Array.from({ length: count }, (_, i) => ({
    lo: edge(i),
    hi: edge(i + 1),
    count: 0,
  }));
  for (const value of values) bins[roundBinIndex(value, bins)].count++;
  return bins;
}

/** Which of `roundBins`' bins a value falls in. */
export function roundBinIndex(value: number, bins: HistogramBin[]): number {
  if (bins.length <= 1) return 0;
  const width = bins[0].hi - bins[0].lo;
  return Math.max(
    0,
    Math.min(bins.length - 1, Math.floor((value - bins[0].lo) / width)),
  );
}

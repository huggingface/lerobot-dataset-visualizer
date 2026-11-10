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

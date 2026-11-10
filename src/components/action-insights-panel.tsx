"use client";

import React, { useMemo, useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { CHART_CONFIG } from "@/utils/constants";
import type {
  CrossEpisodeVarianceData,
  AggAutocorrelation,
  SpeedDistEntry,
  AggAlignment,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import {
  Heatmap,
  Histogram,
  LineKey,
  SeriesLegend,
  roundBinIndex,
  roundBins,
  seriesStyle,
} from "@/components/charts";
import {
  EpisodeLink,
  FlagAllButton,
  InlineLoading,
  PageHeader,
  StatCard,
  Switch,
  crossEpisodeLoadingLabel,
} from "@/components/ui";
import { useTheme } from "@/utils/theme";

const FullscreenCtx = React.createContext(false);
const useIsFullscreen = () => React.useContext(FullscreenCtx);

function InfoToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-0.5 rounded-full text-fg-faint hover:text-fg-soft transition-colors shrink-0"
        title="Toggle description"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </>
  );
}

function FullscreenWrapper({ children }: { children: React.ReactNode }) {
  const [fs, setFs] = useState(false);

  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFs(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fs]);

  return (
    <div className="relative">
      <button
        onClick={() => setFs((v) => !v)}
        className="absolute top-3 right-3 z-10 p-1.5 rounded bg-fill hover:bg-fill-strong text-fg-muted hover:text-fg transition-colors backdrop-blur-sm"
        title={fs ? "Exit fullscreen" : "Fullscreen"}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {fs ? (
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
      </button>
      {fs ? (
        <div className="fixed inset-0 z-50 bg-[var(--bg)]/95 overflow-auto p-6">
          <button
            onClick={() => setFs(false)}
            className="fixed top-4 right-4 z-50 p-2 rounded bg-fill hover:bg-fill-strong text-fg-soft hover:text-fg transition-colors"
            title="Exit fullscreen (Esc)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <div className="max-w-7xl mx-auto">
            <FullscreenCtx.Provider value={true}>
              {children}
            </FullscreenCtx.Provider>
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/// Axis and grid styling shared by the line charts: recessive, like the Episodes tab's.
const AXIS_TICK = { fontSize: 12, fill: "var(--fg-muted)" };
const AXIS_LABEL = { fontSize: 12, fill: "var(--fg-muted)" };
const SECTION =
  "bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line space-y-4";

/** Tick positions from `from` to `to` in steps of `step`, without floating-point drift. */
function steps(from: number, to: number, step: number): number[] {
  const ticks: number[] = [];
  for (let value = from; value <= to + step * 1e-6; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

/**
 * A correlation axis reaching down to `lowest`: the domain stops at the quarter below the data, and
 * the ticks sit on halves (quarters when everything is positive), so no label is an odd number.
 */
function correlationAxis(lowest: number): {
  domain: [number, number];
  ticks: number[];
} {
  const floor = Math.floor(Math.min(lowest, 0) / 0.25) * 0.25;
  const step = floor < 0 ? 0.5 : 0.25;
  return {
    domain: [floor, 1],
    ticks: steps(Math.ceil(floor / step) * step, 1, step),
  };
}

/** Lag ticks at round numbers, a handful whatever the horizon. */
function lagStep(span: number): number {
  return span <= 30 ? 5 : span <= 60 ? 10 : 20;
}

/**
 * The readout under the pointer: every series at that lag, its key beside its name, the value
 * leading. Names stay in text colours; the key carries the series colour.
 */
function LineTooltip({
  active,
  payload,
  label,
  formatLabel,
  series,
}: {
  active?: boolean;
  payload?: { name?: string | number; value?: number | string }[];
  label?: number | string;
  formatLabel: (label: number) => string;
  series: { name: string; color: string; dash?: string }[];
}) {
  if (!active || !payload?.length) return null;
  const values = new Map(
    payload.map((item) => [String(item.name), item.value]),
  );
  return (
    <div className="rounded-md border border-line-strong bg-[var(--surface-2)] px-2.5 py-1.5 text-xs shadow-lg">
      <p className="mb-1 text-fg-muted tabular">{formatLabel(Number(label))}</p>
      <ul className="space-y-0.5">
        {series.map(({ name, color, dash }) => {
          const value = values.get(name);
          if (typeof value !== "number") return null;
          return (
            <li key={name} className="flex items-center gap-2">
              <LineKey color={color} dash={dash} />
              <span className="text-fg-muted">{name}</span>
              <span className="ml-auto pl-4 font-semibold text-fg tabular">
                {value.toFixed(3)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function shortName(key: string): string {
  const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
  return parts.length > 1 ? parts[parts.length - 1] : key;
}

function getActionKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter((k) => k.startsWith("action") && k !== "timestamp")
    .sort();
}

function getStateKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter(
      (k) =>
        k.includes("state") && k !== "timestamp" && !k.startsWith("action"),
    )
    .sort();
}

// ─── Autocorrelation ─────────────────────────────────────────────

function computeAutocorrelation(values: number[], maxLag: number): number[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - mean);
  const variance = centered.reduce((a, v) => a + v * v, 0);
  if (variance === 0) return Array(maxLag).fill(0);

  const result: number[] = [];
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let t = 0; t < n - lag; t++) sum += centered[t] * centered[t + lag];
    result.push(sum / variance);
  }
  return result;
}

function findDecorrelationLag(acf: number[], threshold = 0.5): number | null {
  const idx = acf.findIndex((v) => v < threshold);
  return idx >= 0 ? idx + 1 : null;
}

function AutocorrelationSection({
  data,
  fps,
  agg,
  numEpisodes,
  scopeLabel,
}: {
  data: Record<string, number>[];
  fps: number;
  agg?: AggAutocorrelation | null;
  numEpisodes?: number;
  /** What the chart covers when it is not the dataset: `episode 12`. */
  scopeLabel: string;
}) {
  const isFs = useIsFullscreen();
  const actionKeys = useMemo(
    () => (data.length > 0 ? getActionKeys(data[0]) : []),
    [data],
  );
  const maxLag = useMemo(
    () => Math.min(Math.floor(data.length / 2), 100),
    [data],
  );

  const fallback = useMemo(() => {
    if (agg) return null;
    if (actionKeys.length === 0 || maxLag < 2)
      return { chartData: [], suggestedChunk: null, shortKeys: [] as string[] };

    const acfs = actionKeys.map((key) => {
      const values = data.map((row) => row[key] ?? 0);
      return computeAutocorrelation(values, maxLag);
    });

    const rows = Array.from({ length: maxLag }, (_, lag) => {
      const row: Record<string, number> = {
        lag: lag + 1,
        time: (lag + 1) / fps,
      };
      actionKeys.forEach((key, ki) => {
        row[shortName(key)] = acfs[ki][lag];
      });
      return row;
    });

    const lags = acfs
      .map((acf) => findDecorrelationLag(acf, 0.5))
      .filter(Boolean) as number[];
    const suggested =
      lags.length > 0
        ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)]
        : null;

    return {
      chartData: rows,
      suggestedChunk: suggested,
      shortKeys: actionKeys.map(shortName),
    };
  }, [data, actionKeys, maxLag, fps, agg]);

  const { chartData, suggestedChunk, shortKeys } = agg ??
    fallback ?? { chartData: [], suggestedChunk: null, shortKeys: [] };
  const isAgg = !!agg;
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const series = useMemo(
    () => shortKeys.map((name, i) => ({ name, ...seriesStyle(i) })),
    [shortKeys],
  );
  const lagCount = chartData.length;
  const yAxis = useMemo(() => {
    let min = 0;
    for (const row of chartData)
      for (const k of shortKeys) {
        const v = row[k];
        if (typeof v === "number" && v < min) min = v;
      }
    return correlationAxis(min);
  }, [chartData, shortKeys]);
  const xTicks = useMemo(() => {
    const step = lagStep(lagCount);
    return [1, ...steps(step, lagCount, step)];
  }, [lagCount]);

  if (shortKeys.length === 0)
    return <p className="text-fg-faint italic">No action columns found.</p>;

  return (
    <div className={SECTION}>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">
            Action Autocorrelation
            <span className="text-xs text-fg-faint ml-2 font-normal">
              {isAgg ? `${numEpisodes} episodes sampled` : scopeLabel}
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-fg-muted">
              Shows how correlated each action dimension is with itself over
              increasing time lags. Where autocorrelation drops below 0.5
              suggests a{" "}
              <span className="text-accent-fg font-medium">
                natural action chunk boundary
              </span>{" "}
              — actions beyond this lag are essentially independent, so
              executing them open-loop offers diminishing returns.
              <br />
              <span className="text-fg-faint">
                Grounded in the theoretical result that chunk length should
                scale logarithmically with system stability constants (
                <a
                  href="https://arxiv.org/abs/2507.09061"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Zhang et al., 2025
                </a>
                , Theorem 1).
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {suggestedChunk && (
        <div className="flex items-center gap-3 bg-accent/10 border border-accent/30 rounded-md px-4 py-2.5">
          <span className="text-accent-fg font-bold text-lg tabular-nums">
            {suggestedChunk}
          </span>
          <div>
            <p className="text-sm text-accent-fg font-medium">
              Suggested chunk length: {suggestedChunk} steps (
              {(suggestedChunk / fps).toFixed(2)}s)
            </p>
            <p className="text-xs text-fg-muted">
              Median lag where autocorrelation drops below 0.5 across action
              dimensions
            </p>
          </div>
        </div>
      )}

      <div className={isFs ? "h-[500px]" : "h-64"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            key={isAgg ? "agg" : "ep"}
            data={chartData}
            margin={{ top: 18, right: 28, left: 0, bottom: 20 }}
          >
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="lag"
              type="number"
              domain={[1, Math.max(2, lagCount)]}
              ticks={xTicks}
              stroke="var(--chart-axis)"
              tick={AXIS_TICK}
              tickLine={false}
              label={{
                value: "Lag (frames)",
                position: "insideBottom",
                offset: -12,
                ...AXIS_LABEL,
              }}
            />
            <YAxis
              domain={yAxis.domain}
              ticks={yAxis.ticks}
              interval={0}
              stroke="var(--chart-axis)"
              tick={AXIS_TICK}
              tickLine={false}
              width={44}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: "var(--chart-axis)" }}
              content={
                <LineTooltip
                  series={series}
                  formatLabel={(lag) =>
                    `Lag ${lag} · ${(lag / fps).toFixed(2)}s`
                  }
                />
              }
            />
            {/* The threshold the suggestion is read off, labelled where it meets the edge. */}
            <ReferenceLine
              y={0.5}
              stroke="var(--fg-faint)"
              strokeDasharray="4 4"
              label={{
                value: "0.5",
                position: "right",
                fontSize: 11,
                fill: "var(--fg-muted)",
              }}
            />
            {suggestedChunk && (
              <ReferenceLine
                x={suggestedChunk}
                stroke="var(--accent)"
                label={{
                  value: `chunk ${suggestedChunk}`,
                  position: "top",
                  fontSize: 11,
                  fill: "var(--accent-fg)",
                }}
              />
            )}
            {series.map(({ name, color, dash }) => (
              <Line
                key={name}
                dataKey={name}
                name={name}
                stroke={color}
                strokeDasharray={dash}
                strokeWidth={
                  highlighted === name ? 3 : series.length > 8 ? 1.5 : 2
                }
                strokeOpacity={highlighted && highlighted !== name ? 0.15 : 1}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SeriesLegend
        series={series}
        highlighted={highlighted}
        onHighlight={setHighlighted}
      />
    </div>
  );
}

// ─── Cross-Episode Variance Heatmap ──────────────────────────────

function VarianceHeatmap({
  data,
  loading,
  progress,
}: {
  data: CrossEpisodeVarianceData | null;
  loading: boolean;
  progress?: { done: number; total: number } | null;
}) {
  const theme = useTheme();

  // Spread across episodes as a share of each motor's range, so a gripper in percent and a joint
  // in radians are on one scale. The raw variance let the widest-ranging motor set the colours.
  const rows = useMemo(() => {
    if (!data) return [];
    return data.actionNames.map((name, d) => {
      const range = data.aggVelocity[d]?.motorRange || 1;
      return {
        label: shortName(name),
        values: data.variance.map((bin) => Math.sqrt(bin[d]) / range),
      };
    });
  }, [data]);

  if (loading) {
    return (
      <div className={SECTION}>
        <h3 className="text-sm font-semibold text-fg">
          Cross-Episode Action Variance
        </h3>
        <InlineLoading label={crossEpisodeLoadingLabel(progress)} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className={SECTION}>
        <h3 className="text-sm font-semibold text-fg">
          Cross-Episode Action Variance
        </h3>
        <p className="text-fg-faint italic text-sm">
          Not enough episodes or no action data to compute variance.
        </p>
      </div>
    );
  }
  const { timeBins, numEpisodes } = data;

  return (
    <div className={SECTION}>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">
            Cross-Episode Action Variance
            <span className="text-xs text-fg-faint ml-2 font-normal">
              {numEpisodes} episodes sampled
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-fg-muted">
              How much each action dimension differs between episodes at the
              same point of their progress: the standard deviation across
              episodes, as a share of that motor&apos;s range.{" "}
              <span className="text-fg font-medium">High-variance regions</span>{" "}
              indicate multi-modal or inconsistent demonstrations — generative
              policies (diffusion, flow-matching) and action chunking help here
              by modeling multiple modes.{" "}
              <span className="text-fg font-medium">Low-variance regions</span>{" "}
              indicate consistent behavior across demonstrations.
              <br />
              <span className="text-fg-faint">
                Relates to the &quot;coverage&quot; discussion in{" "}
                <a
                  href="https://arxiv.org/abs/2507.09061"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Zhang et al. (2025)
                </a>{" "}
                — regions with low variance may lack the exploratory coverage
                needed to prevent compounding errors (Section 4).
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <Heatmap
        rows={rows}
        theme={theme}
        ariaLabel="Spread of each action dimension across episodes, by episode progress"
        xLabel="Episode progress"
        xTicks={[0, 0.25, 0.5, 0.75, 1].map((at) => ({
          at,
          label: `${at * 100}%`,
        }))}
        formatValue={(value) => `${(value * 100).toFixed(1)}%`}
        describeColumn={(i) =>
          `at ${Math.round(timeBins[i] * 100)}% of the episode`
        }
        legend="std across episodes, as a share of the motor's range"
      />
    </div>
  );
}

// ─── Demonstrator Speed Variance ────────────────────────────────

const SPEED_EPISODES_SHOWN = 80;

function SpeedVarianceSection({
  distribution,
  numEpisodes,
}: {
  distribution: SpeedDistEntry[];
  numEpisodes: number;
}) {
  const [selectedBin, setSelectedBin] = useState<number | null>(null);
  const { mean, std, cv, median, bins, verdict } = useMemo(() => {
    const sp = distribution.map((d) => d.speed).sort((a, b) => a - b);
    const m = sp.reduce((a, b) => a + b, 0) / sp.length;
    const s = Math.sqrt(sp.reduce((a, v) => a + (v - m) ** 2, 0) / sp.length);
    const c = m > 0 ? s / m : 0;

    let v: { label: string; color: string; tip: string };
    if (c < 0.2)
      v = {
        label: "Consistent",
        color: "text-good-fg",
        tip: "Demonstrators execute at similar speeds — no velocity normalization needed.",
      };
    else if (c < 0.4)
      v = {
        label: "Moderate variance",
        color: "text-warning-fg",
        tip: "Some speed variation across demonstrators. Consider velocity normalization for best results.",
      };
    else
      v = {
        label: "High variance",
        color: "text-critical-fg",
        tip: "Large speed differences between demonstrations. Velocity normalization before training is strongly recommended.",
      };

    return {
      mean: m,
      std: s,
      cv: c,
      median: sp[Math.floor(sp.length / 2)],
      bins: roundBins(sp, Math.min(30, Math.ceil(Math.sqrt(sp.length)))),
      verdict: v,
    };
  }, [distribution]);

  const inBin = useMemo(
    () =>
      selectedBin === null
        ? []
        : distribution
            .filter((d) => roundBinIndex(d.speed, bins) === selectedBin)
            .sort((a, b) => a.speed - b.speed),
    [distribution, bins, selectedBin],
  );

  if (distribution.length < 3) return null;
  const selected = selectedBin !== null ? bins[selectedBin] : null;

  return (
    <div className={SECTION}>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">
            Demonstrator Speed Variance
            <span className="text-xs text-fg-faint ml-2 font-normal">
              {numEpisodes} episodes
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-fg-muted">
              Distribution of average execution speed (mean ‖Δa<sub>t</sub>‖ per
              frame) across all episodes. Different human demonstrators often
              execute at{" "}
              <span className="text-accent-fg">different speeds</span>
              , creating artificial multimodality in the action distribution
              that confuses the policy. A coefficient of variation (CV) above
              0.3 strongly suggests normalizing trajectory speed before
              training.
              <br />
              <span className="text-fg-faint">
                Based on &quot;Is Diversity All You Need&quot; (AGI-Bot, 2025)
                which shows velocity normalization dramatically improves
                fine-tuning success rate.
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Mean" value={mean.toFixed(4)} />
        <StatCard label="Median" value={median.toFixed(4)} />
        <StatCard label="Std dev" value={std.toFixed(4)} />
        <StatCard
          label="CV (std ÷ mean)"
          value={cv.toFixed(3)}
          detail={<span className={verdict.color}>{verdict.label}</span>}
        />
      </div>

      <div>
        <p className="mb-1 text-xs text-fg-muted">
          Episodes by mean speed. Select a bar to list its episodes.
        </p>
        <Histogram
          bins={bins}
          ariaLabel="Episodes by mean speed"
          formatValue={(value) => Number(value.toPrecision(3)).toString()}
          describeCount={(count) =>
            `${count.toLocaleString()} episode${count === 1 ? "" : "s"}`
          }
          marker={{
            value: median,
            label: `median ${Number(median.toPrecision(3))}`,
          }}
          selected={selectedBin}
          onSelect={setSelectedBin}
        />
      </div>

      {selected && (
        <div className="rounded-md border border-accent/30 bg-accent/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-fg-soft tabular">
              <span className="font-semibold text-fg">
                {inBin.length.toLocaleString()} episode
                {inBin.length === 1 ? "" : "s"}
              </span>{" "}
              at {(selected.lo / (median || 1)).toFixed(2)}× to{" "}
              {(selected.hi / (median || 1)).toFixed(2)}× the median speed
            </p>
            <div className="flex items-center gap-3">
              <FlagAllButton ids={inBin.map((e) => e.episodeIndex)} />
              <button
                type="button"
                onClick={() => setSelectedBin(null)}
                className="text-xs text-fg-faint transition-colors hover:text-fg"
              >
                Clear
              </button>
            </div>
          </div>
          <ul className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {inBin.slice(0, SPEED_EPISODES_SHOWN).map((episode) => (
              <li key={episode.episodeIndex}>
                <EpisodeLink
                  episode={episode.episodeIndex}
                  className="block rounded border border-line bg-fill px-1.5 py-0.5 text-xs text-fg-soft"
                >
                  {episode.episodeIndex}
                </EpisodeLink>
              </li>
            ))}
            {inBin.length > SPEED_EPISODES_SHOWN && (
              <li className="px-1.5 py-0.5 text-xs text-fg-faint">
                +{(inBin.length - SPEED_EPISODES_SHOWN).toLocaleString()} more
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-line space-y-1.5">
        <p className="text-sm font-medium text-fg">
          Verdict: <span className={verdict.color}>{verdict.label}</span>
        </p>
        <p className="text-xs text-fg-muted">{verdict.tip}</p>
      </div>
    </div>
  );
}

// ─── State–Action Temporal Alignment ────────────────────────────

function StateActionAlignmentSection({
  data,
  fps,
  agg,
  numEpisodes,
  scopeLabel: episodeLabel,
}: {
  data: Record<string, number>[];
  fps: number;
  agg?: AggAlignment | null;
  numEpisodes?: number;
  /** What the chart covers when it is not the dataset: `episode 12`. */
  scopeLabel: string;
}) {
  const isFs = useIsFullscreen();
  const result = useMemo(() => {
    if (agg) return { ...agg, fromAgg: true };
    if (data.length < 10) return null;
    const actionKeys = getActionKeys(data[0]);
    const stateKeys = getStateKeys(data[0]);
    if (actionKeys.length === 0 || stateKeys.length === 0) return null;
    const maxLag = Math.min(Math.floor(data.length / 4), 30);
    if (maxLag < 2) return null;

    // Match action↔state by suffix, fall back to index matching
    const pairs: [string, string][] = [];
    for (const aKey of actionKeys) {
      const match = stateKeys.find(
        (sKey) => shortName(sKey) === shortName(aKey),
      );
      if (match) pairs.push([aKey, match]);
    }
    if (pairs.length === 0) {
      const count = Math.min(actionKeys.length, stateKeys.length);
      for (let i = 0; i < count; i++) pairs.push([actionKeys[i], stateKeys[i]]);
    }
    if (pairs.length === 0) return null;

    // Per-pair cross-correlation (Δaction vs Δstate)
    const pairCorrs: number[][] = [];
    for (const [aKey, sKey] of pairs) {
      const aDeltas = data
        .slice(1)
        .map((row, i) => (row[aKey] ?? 0) - (data[i][aKey] ?? 0));
      const sDeltas = data
        .slice(1)
        .map((row, i) => (row[sKey] ?? 0) - (data[i][sKey] ?? 0));
      const n = Math.min(aDeltas.length, sDeltas.length);
      if (n < 4) {
        pairCorrs.push(Array(2 * maxLag + 1).fill(0));
        continue;
      }
      const aM = aDeltas.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const sM = sDeltas.slice(0, n).reduce((a, b) => a + b, 0) / n;

      const corrs: number[] = [];
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sum = 0,
          aV = 0,
          sV = 0;
        for (let t = 0; t < n; t++) {
          const sIdx = t + lag;
          if (sIdx < 0 || sIdx >= n) continue;
          const a = aDeltas[t] - aM,
            s = sDeltas[sIdx] - sM;
          sum += a * s;
          aV += a * a;
          sV += s * s;
        }
        const d = Math.sqrt(aV * sV);
        corrs.push(d > 0 ? sum / d : 0);
      }
      pairCorrs.push(corrs);
    }

    // Aggregate min/mean/max per lag
    const ccData = Array.from({ length: 2 * maxLag + 1 }, (_, li) => {
      const lag = -maxLag + li;
      const vals = pairCorrs.map((pc) => pc[li]);
      return {
        lag,
        time: lag / fps,
        max: Math.max(...vals),
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        min: Math.min(...vals),
      };
    });

    // Peaks of the envelope curves
    let meanPeakLag = 0,
      meanPeakCorr = -Infinity;
    let maxPeakLag = 0,
      maxPeakCorr = -Infinity;
    let minPeakLag = 0,
      minPeakCorr = -Infinity;
    for (const row of ccData) {
      if (row.max > maxPeakCorr) {
        maxPeakCorr = row.max;
        maxPeakLag = row.lag;
      }
      if (row.mean > meanPeakCorr) {
        meanPeakCorr = row.mean;
        meanPeakLag = row.lag;
      }
      if (row.min > minPeakCorr) {
        minPeakCorr = row.min;
        minPeakLag = row.lag;
      }
    }

    // Per-pair individual peak lags (for showing the true range across dimensions)
    const perPairPeakLags = pairCorrs.map((pc) => {
      let best = -Infinity,
        bestLag = 0;
      for (let li = 0; li < pc.length; li++) {
        if (pc[li] > best) {
          best = pc[li];
          bestLag = -maxLag + li;
        }
      }
      return bestLag;
    });
    const lagRangeMin = Math.min(...perPairPeakLags);
    const lagRangeMax = Math.max(...perPairPeakLags);

    return {
      ccData,
      meanPeakLag,
      meanPeakCorr,
      maxPeakLag,
      maxPeakCorr,
      minPeakLag,
      minPeakCorr,
      lagRangeMin,
      lagRangeMax,
      numPairs: pairs.length,
      fromAgg: false,
    };
  }, [data, fps, agg]);

  if (!result) return null;
  const {
    ccData,
    meanPeakLag,
    meanPeakCorr,
    maxPeakLag,
    maxPeakCorr,
    minPeakLag,
    minPeakCorr,
    lagRangeMin,
    lagRangeMax,
    numPairs,
    fromAgg,
  } = result;
  const scopeLabel = fromAgg ? `${numEpisodes} episodes sampled` : episodeLabel;

  const lagSpan = ccData.length > 0 ? ccData[ccData.length - 1].lag : 0;
  const step = lagStep(lagSpan * 2);
  const xTicks = steps(-Math.floor(lagSpan / step) * step, lagSpan, step);
  const yAxis = correlationAxis(Math.min(...ccData.map((row) => row.min)));
  // The envelope across the matched pairs: the mean in the foreground, its bounds around it.
  const series = [
    {
      name: "max",
      color: "var(--series-2)",
      note: `peak at lag ${maxPeakLag}, r = ${maxPeakCorr.toFixed(3)}`,
    },
    {
      name: "mean",
      color: "var(--fg-soft)",
      note: `peak at lag ${meanPeakLag}, r = ${meanPeakCorr.toFixed(3)}`,
    },
    {
      name: "min",
      color: "var(--series-1)",
      note: `peak at lag ${minPeakLag}, r = ${minPeakCorr.toFixed(3)}`,
    },
  ];

  return (
    <div className={SECTION}>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">
            State–Action Temporal Alignment
            <span className="text-xs text-fg-faint ml-2 font-normal">
              {scopeLabel}, {numPairs} matched pair{numPairs !== 1 ? "s" : ""}
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-fg-muted">
              Per-dimension cross-correlation between Δaction<sub>d</sub>(t) and
              Δstate<sub>d</sub>(t+lag), aggregated as max, mean and min across
              all matched action–state pairs. The{" "}
              <span className="text-accent-fg">peak lag</span> reveals the
              effective control delay — the time between when an action is
              commanded and when the corresponding state changes.
              <br />
              <span className="text-fg-faint">
                Central to ACT (
                <a
                  href="https://arxiv.org/abs/2304.13705"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Zhao et al., 2023
                </a>{" "}
                — action chunking compensates for delay), Real-Time Chunking
                (RTC,{" "}
                <a
                  href="https://arxiv.org/abs/2506.07339"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Black et al., 2025
                </a>
                ), and Training-Time RTC (
                <a
                  href="https://arxiv.org/abs/2512.05964"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Black et al., 2025
                </a>
                ) — all address the timing mismatch between commanded actions
                and observed state changes.
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {meanPeakLag !== 0 && (
        <div className="flex items-center gap-3 bg-accent/10 border border-accent/30 rounded-md px-4 py-2.5">
          <span className="text-accent-fg font-bold text-lg tabular-nums">
            {meanPeakLag}
          </span>
          <div>
            <p className="text-sm text-accent-fg font-medium">
              Mean control delay: {meanPeakLag} step
              {Math.abs(meanPeakLag) !== 1 ? "s" : ""} (
              {(meanPeakLag / fps).toFixed(3)}s)
            </p>
            <p className="text-xs text-fg-muted">
              {meanPeakLag > 0
                ? `State changes lag behind actions by ~${meanPeakLag} frames on average. Consider aligning action[t] with state[t+${meanPeakLag}].`
                : `Actions lag behind state changes by ~${-meanPeakLag} frames on average (predictive actions).`}
              {lagRangeMin !== lagRangeMax &&
                ` Individual dimension peaks range from ${lagRangeMin} to ${lagRangeMax} steps.`}
            </p>
          </div>
        </div>
      )}

      <div className={isFs ? "h-[500px]" : "h-56"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={ccData}
            margin={{ top: 18, right: 16, left: 0, bottom: 20 }}
          >
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="lag"
              type="number"
              domain={[-lagSpan, lagSpan]}
              ticks={xTicks}
              stroke="var(--chart-axis)"
              tick={AXIS_TICK}
              tickLine={false}
              label={{
                value: "Lag (frames): state after action →",
                position: "insideBottom",
                offset: -12,
                ...AXIS_LABEL,
              }}
            />
            <YAxis
              domain={yAxis.domain}
              ticks={yAxis.ticks}
              interval={0}
              stroke="var(--chart-axis)"
              tick={AXIS_TICK}
              tickLine={false}
              width={44}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: "var(--chart-axis)" }}
              content={
                <LineTooltip
                  series={series}
                  formatLabel={(lag) =>
                    `Lag ${lag} · ${(lag / fps).toFixed(3)}s`
                  }
                />
              }
            />
            <ReferenceLine y={0} stroke="var(--chart-axis)" />
            <ReferenceLine x={0} stroke="var(--chart-axis)" />
            {meanPeakLag !== 0 && (
              <ReferenceLine
                x={meanPeakLag}
                stroke="var(--accent)"
                label={{
                  value: `delay ${meanPeakLag}`,
                  position: "top",
                  fontSize: 11,
                  fill: "var(--accent-fg)",
                }}
              />
            )}
            {series.map(({ name, color }) => (
              <Line
                key={name}
                dataKey={name}
                name={name}
                stroke={color}
                strokeWidth={name === "mean" ? 2.5 : 1.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SeriesLegend series={series} />

      {meanPeakLag === 0 && (
        <p className="text-xs text-good-fg">
          Mean peak correlation at lag 0 (r={meanPeakCorr.toFixed(3)}) — actions
          and state changes are well-aligned
          {fromAgg ? "" : " in this episode"}.
        </p>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────

interface ActionInsightsPanelProps {
  flatChartData: Record<string, number>[];
  fps: number;
  /** The episode on screen, which "Current episode" analyses. */
  episodeId: number;
  crossEpisodeData: CrossEpisodeVarianceData | null;
  crossEpisodeLoading: boolean;
  crossEpisodeProgress?: { done: number; total: number } | null;
}

function ActionInsightsPanel({
  flatChartData,
  fps,
  episodeId,
  crossEpisodeData,
  crossEpisodeLoading,
  crossEpisodeProgress,
}: ActionInsightsPanelProps) {
  const [mode, setMode] = useState<"episode" | "dataset">("dataset");
  const showAgg = mode === "dataset" && !!crossEpisodeData;
  const scopeLabel = `episode ${episodeId}`;

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      <PageHeader
        title="Action Insights"
        description="Data-driven analysis to guide action chunking, data quality assessment, and training configuration."
      >
        <Switch
          checked={mode === "dataset"}
          onChange={(all) => setMode(all ? "dataset" : "episode")}
          offLabel={`Episode ${episodeId}`}
          onLabel={`All episodes${crossEpisodeData ? ` (${crossEpisodeData.numEpisodes} sampled)` : ""}`}
          ariaLabel="Analyse the dataset rather than this episode"
        />
      </PageHeader>

      <FullscreenWrapper>
        <AutocorrelationSection
          data={flatChartData}
          fps={fps}
          agg={showAgg ? crossEpisodeData?.aggAutocorrelation : null}
          numEpisodes={crossEpisodeData?.numEpisodes}
          scopeLabel={scopeLabel}
        />
      </FullscreenWrapper>
      <FullscreenWrapper>
        <StateActionAlignmentSection
          data={flatChartData}
          fps={fps}
          agg={showAgg ? crossEpisodeData?.aggAlignment : null}
          numEpisodes={crossEpisodeData?.numEpisodes}
          scopeLabel={scopeLabel}
        />
      </FullscreenWrapper>

      {crossEpisodeData?.speedDistribution &&
        crossEpisodeData.speedDistribution.length > 2 && (
          <FullscreenWrapper>
            <SpeedVarianceSection
              distribution={crossEpisodeData.speedDistribution}
              numEpisodes={crossEpisodeData.numEpisodes}
            />
          </FullscreenWrapper>
        )}
      <FullscreenWrapper>
        <VarianceHeatmap
          data={crossEpisodeData}
          loading={crossEpisodeLoading}
          progress={crossEpisodeProgress}
        />
      </FullscreenWrapper>
    </div>
  );
}

export default ActionInsightsPanel;
export { FullscreenWrapper, InfoToggle };

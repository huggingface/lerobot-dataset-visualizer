"use client";

import React, { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { CrossEpisodeVarianceData, LowMovementEpisode, AggVelocityStat, AggAutocorrelation } from "@/app/[org]/[dataset]/[episode]/fetch-data";

const DELIMITER = " | ";
const COLORS = [
  "#f97316", "#3b82f6", "#22c55e", "#ef4444", "#a855f7",
  "#eab308", "#06b6d4", "#ec4899", "#14b8a6", "#f59e0b",
  "#6366f1", "#84cc16",
];

function shortName(key: string): string {
  const parts = key.split(DELIMITER);
  return parts.length > 1 ? parts[parts.length - 1] : key;
}

function getActionKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter(k => k.startsWith("action") && k !== "timestamp")
    .sort();
}

// ─── Autocorrelation ─────────────────────────────────────────────

function computeAutocorrelation(values: number[], maxLag: number): number[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map(v => v - mean);
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
  const idx = acf.findIndex(v => v < threshold);
  return idx >= 0 ? idx + 1 : null;
}

function AutocorrelationSection({ data, fps, agg, numEpisodes }: { data: Record<string, number>[]; fps: number; agg?: AggAutocorrelation | null; numEpisodes?: number }) {
  const actionKeys = useMemo(() => (data.length > 0 ? getActionKeys(data[0]) : []), [data]);
  const maxLag = useMemo(() => Math.min(Math.floor(data.length / 2), 100), [data]);

  const fallback = useMemo(() => {
    if (agg) return null;
    if (actionKeys.length === 0 || maxLag < 2) return { chartData: [], suggestedChunk: null, shortKeys: [] as string[] };

    const acfs = actionKeys.map(key => {
      const values = data.map(row => row[key] ?? 0);
      return computeAutocorrelation(values, maxLag);
    });

    const rows = Array.from({ length: maxLag }, (_, lag) => {
      const row: Record<string, number> = { lag: lag + 1, time: (lag + 1) / fps };
      actionKeys.forEach((key, ki) => { row[shortName(key)] = acfs[ki][lag]; });
      return row;
    });

    const lags = acfs.map(acf => findDecorrelationLag(acf, 0.5)).filter(Boolean) as number[];
    const suggested = lags.length > 0 ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null;

    return { chartData: rows, suggestedChunk: suggested, shortKeys: actionKeys.map(shortName) };
  }, [data, actionKeys, maxLag, fps, agg]);

  const { chartData, suggestedChunk, shortKeys } = agg ?? fallback ?? { chartData: [], suggestedChunk: null, shortKeys: [] };
  const numEpisodesLabel = agg ? ` (${numEpisodes} episodes sampled)` : " (current episode)";

  if (shortKeys.length === 0) return <p className="text-slate-500 italic">No action columns found.</p>;

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Action Autocorrelation<span className="text-xs text-slate-500 ml-2 font-normal">{numEpisodesLabel}</span></h3>
        <p className="text-xs text-slate-400 mt-1">
          Shows how correlated each action dimension is with itself over increasing time lags.
          Where autocorrelation drops below 0.5 suggests a <span className="text-orange-400 font-medium">natural action chunk boundary</span> — actions
          beyond this lag are essentially independent, so executing them open-loop offers diminishing returns.
          <br />
          <span className="text-slate-500">
            Grounded in the theoretical result that chunk length should scale logarithmically with system stability constants
            (Zhang et al., 2025 — arXiv:2507.09061, Theorem 1).
          </span>
        </p>
      </div>

      {suggestedChunk && (
        <div className="flex items-center gap-3 bg-orange-500/10 border border-orange-500/30 rounded-md px-4 py-2.5">
          <span className="text-orange-400 font-bold text-lg tabular-nums">{suggestedChunk}</span>
          <div>
            <p className="text-sm text-orange-300 font-medium">
              Suggested chunk length: {suggestedChunk} steps ({(suggestedChunk / fps).toFixed(2)}s)
            </p>
            <p className="text-xs text-slate-400">Median lag where autocorrelation drops below 0.5 across action dimensions</p>
          </div>
        </div>
      )}

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="lag"
              stroke="#94a3b8"
              label={{ value: "Lag (steps)", position: "insideBottom", offset: -8, fill: "#94a3b8", fontSize: 11 }}
            />
            <YAxis stroke="#94a3b8" domain={[-0.2, 1]} />
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #475569", borderRadius: 6 }}
              labelFormatter={(v) => `Lag ${v} (${(Number(v) / fps).toFixed(2)}s)`}
              formatter={(v: number) => v.toFixed(3)}
            />
            <Line
              dataKey={() => 0.5}
              stroke="#64748b"
              strokeDasharray="6 4"
              dot={false}
              name="0.5 threshold"
              legendType="none"
              isAnimationActive={false}
            />
            {shortKeys.map((name, i) => (
              <Line
                key={name}
                dataKey={name}
                stroke={COLORS[i % COLORS.length]}
                dot={false}
                strokeWidth={1.5}
                legendType="none"
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Custom legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
        {shortKeys.map((name, i) => (
          <div key={name} className="flex items-center gap-1.5">
            <span className="w-3 h-[3px] rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="text-[11px] text-slate-400">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Action Velocity ─────────────────────────────────────────────

function ActionVelocitySection({ data, agg, numEpisodes }: { data: Record<string, number>[]; agg?: AggVelocityStat[]; numEpisodes?: number }) {
  const actionKeys = useMemo(() => (data.length > 0 ? getActionKeys(data[0]) : []), [data]);

  const fallbackStats = useMemo(() => {
    if (agg && agg.length > 0) return null;
    if (actionKeys.length === 0 || data.length < 2) return [];

    return actionKeys.map(key => {
      const values = data.map(row => row[key] ?? 0);
      const deltas = values.slice(1).map((v, i) => v - values[i]);
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const std = Math.sqrt(deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length);
      const maxAbs = Math.max(...deltas.map(Math.abs));
      const binCount = 30;
      const lo = Math.min(...deltas);
      const hi = Math.max(...deltas);
      const range = hi - lo || 1;
      const binW = range / binCount;
      const bins: number[] = new Array(binCount).fill(0);
      for (const d of deltas) { let b = Math.floor((d - lo) / binW); if (b >= binCount) b = binCount - 1; bins[b]++; }
      return { name: shortName(key), std, maxAbs, bins, lo, hi };
    });
  }, [data, actionKeys, agg]);

  const stats = (agg && agg.length > 0) ? agg : fallbackStats ?? [];
  const isAgg = agg && agg.length > 0;

  if (stats.length === 0) return <p className="text-slate-500 italic">No action data for velocity analysis.</p>;

  const maxBinCount = Math.max(...stats.flatMap(s => s.bins));
  const maxStd = Math.max(...stats.map(s => s.std));

  const insight = useMemo(() => {
    const smooth = stats.filter(s => s.std / maxStd < 0.4);
    const moderate = stats.filter(s => s.std / maxStd >= 0.4 && s.std / maxStd < 0.7);
    const jerky = stats.filter(s => s.std / maxStd >= 0.7);
    const isGripper = (n: string) => /grip/i.test(n);
    const jerkyNonGripper = jerky.filter(s => !isGripper(s.name));
    const jerkyGripper = jerky.filter(s => isGripper(s.name));
    const smoothRatio = smooth.length / stats.length;

    let verdict: { label: string; color: string };
    if (smoothRatio >= 0.6 && jerkyNonGripper.length === 0)
      verdict = { label: "Smooth", color: "text-green-400" };
    else if (jerkyNonGripper.length <= 2 && smoothRatio >= 0.3)
      verdict = { label: "Moderate", color: "text-yellow-400" };
    else
      verdict = { label: "Jerky", color: "text-red-400" };

    const lines: string[] = [];
    if (smooth.length > 0)
      lines.push(`${smooth.length} smooth (${smooth.map(s => s.name).join(", ")})`);
    if (moderate.length > 0)
      lines.push(`${moderate.length} moderate (${moderate.map(s => s.name).join(", ")})`);
    if (jerkyNonGripper.length > 0)
      lines.push(`${jerkyNonGripper.length} jerky (${jerkyNonGripper.map(s => s.name).join(", ")})`);
    if (jerkyGripper.length > 0)
      lines.push(`${jerkyGripper.length} gripper${jerkyGripper.length > 1 ? "s" : ""} jerky — expected for binary open/close`);

    let tip: string;
    if (verdict.label === "Smooth")
      tip = "Actions are consistent — longer action chunks should work well.";
    else if (verdict.label === "Moderate")
      tip = "Some dimensions show abrupt changes. Consider moderate chunk sizes.";
    else
      tip = "Many dimensions are jerky. Use shorter action chunks and consider filtering outlier episodes.";

    return { verdict, lines, tip };
  }, [stats, maxStd]);

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Action Velocity (Δa) — Smoothness Proxy<span className="text-xs text-slate-500 ml-2 font-normal">{isAgg ? `(${numEpisodes} episodes sampled)` : "(current episode)"}</span></h3>
        <p className="text-xs text-slate-400 mt-1">
          Shows the distribution of frame-to-frame action changes (Δa = a<sub>t+1</sub> − a<sub>t</sub>) for each dimension.
          A <span className="text-green-400">tight distribution around zero</span> means smooth, predictable control — the system
          is likely stable and benefits from longer action chunks.
          <span className="text-red-400"> Fat tails or high std</span> indicate jerky demonstrations, suggesting shorter chunks
          and potentially beneficial noise injection.
          <br />
          <span className="text-slate-500">
            Relates to the Lipschitz constant L<sub>π</sub> and smoothness C<sub>π</sub> in Zhang et al. (2025), which govern
            compounding error bounds (Assumptions 3.1, 4.1).
          </span>
        </p>
      </div>

      {/* Per-dimension mini histograms + stats */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {stats.map((s, si) => {
          const barH = 28;
          return (
            <div key={s.name} className="bg-slate-900/50 rounded-md px-2.5 py-2 space-y-1">
              <p className="text-[11px] font-medium text-slate-200 truncate" title={s.name}>{s.name}</p>
              <div className="flex gap-2 text-[9px] text-slate-400 tabular-nums">
                <span>σ={s.std.toFixed(4)}</span>
                <span>|Δ|<sub>max</sub>={s.maxAbs.toFixed(4)}</span>
              </div>
              <svg width="100%" viewBox={`0 0 ${s.bins.length} ${barH}`} preserveAspectRatio="none" className="h-7 rounded" aria-label={`Δa distribution for ${s.name}`}>
                {[...s.bins].map((count, bi) => {
                  const h = maxBinCount > 0 ? (count / maxBinCount) * barH : 0;
                  return <rect key={bi} x={bi} y={barH - h} width={0.85} height={h} fill={COLORS[si % COLORS.length]} opacity={0.7} />;
                })}
              </svg>
              <div className="h-1 w-full bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (s.std / maxStd) * 100)}%`,
                    background: s.std / maxStd < 0.4 ? "#22c55e" : s.std / maxStd < 0.7 ? "#eab308" : "#ef4444",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700/60 space-y-1.5">
        <p className="text-sm font-medium text-slate-200">
          Overall: <span className={insight.verdict.color}>{insight.verdict.label}</span>
        </p>
        <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
          {insight.lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
        <p className="text-xs text-slate-500 pt-1">{insight.tip}</p>
      </div>
    </div>
  );
}

// ─── Cross-Episode Variance Heatmap ──────────────────────────────

function VarianceHeatmap({ data, loading }: { data: CrossEpisodeVarianceData | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">Cross-Episode Action Variance</h3>
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading cross-episode data (sampled up to 500 episodes)…
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">Cross-Episode Action Variance</h3>
        <p className="text-slate-500 italic text-sm">Not enough episodes or no action data to compute variance.</p>
      </div>
    );
  }

  const { actionNames, timeBins, variance, numEpisodes } = data;
  const numDims = actionNames.length;
  const numBins = timeBins.length;

  // Find global max variance for color scale
  const maxVar = Math.max(...variance.flat(), 1e-10);

  // Heatmap dimensions
  const cellW = Math.max(6, Math.min(14, Math.floor(560 / numBins)));
  const cellH = Math.max(20, Math.min(36, Math.floor(300 / numDims)));
  const labelW = 100;
  const svgW = labelW + numBins * cellW + 60; // 60 for color bar
  const svgH = numDims * cellH + 40; // 40 for x-axis label

  function varColor(v: number): string {
    const t = Math.sqrt(v / maxVar); // sqrt for better visual spread
    // Dark blue → teal → orange
    const r = Math.round(t * 249);
    const g = Math.round(t < 0.5 ? 80 + t * 200 : 180 - (t - 0.5) * 200);
    const b = Math.round((1 - t) * 200 + 30);
    return `rgb(${r},${g},${b})`;
  }

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">
          Cross-Episode Action Variance
          <span className="text-xs text-slate-500 ml-2 font-normal">({numEpisodes} episodes sampled)</span>
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Shows how much each action dimension varies across episodes at each point in time (normalized 0–100%).
          <span className="text-orange-400"> High-variance regions</span> indicate multi-modal or inconsistent demonstrations —
          generative policies (diffusion, flow-matching) and action chunking help here by modeling multiple modes.
          <span className="text-blue-400"> Low-variance regions</span> indicate consistent behavior across demonstrations.
          <br />
          <span className="text-slate-500">
            Relates to the &quot;coverage&quot; discussion in Zhang et al. (2025) — regions with low variance may lack the
            exploratory coverage needed to prevent compounding errors (Section 4).
          </span>
        </p>
      </div>

      <div className="overflow-x-auto">
        <svg width={svgW} height={svgH} className="block">
          {/* Heatmap cells */}
          {variance.map((row, bi) =>
            row.map((v, di) => (
              <rect
                key={`${bi}-${di}`}
                x={labelW + bi * cellW}
                y={di * cellH}
                width={cellW}
                height={cellH}
                fill={varColor(v)}
                stroke="#1e293b"
                strokeWidth={0.5}
              >
                <title>{`${shortName(actionNames[di])} @ ${(timeBins[bi] * 100).toFixed(0)}%: var=${v.toFixed(5)}`}</title>
              </rect>
            ))
          )}

          {/* Y-axis: action names */}
          {actionNames.map((name, di) => (
            <text
              key={di}
              x={labelW - 4}
              y={di * cellH + cellH / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-slate-400"
              fontSize={Math.min(11, cellH - 4)}
            >
              {shortName(name)}
            </text>
          ))}

          {/* X-axis labels */}
          {[0, 0.25, 0.5, 0.75, 1].map(frac => {
            const binIdx = Math.round(frac * (numBins - 1));
            return (
              <text
                key={frac}
                x={labelW + binIdx * cellW + cellW / 2}
                y={numDims * cellH + 14}
                textAnchor="middle"
                className="fill-slate-400"
                fontSize={9}
              >
                {(frac * 100).toFixed(0)}%
              </text>
            );
          })}
          <text
            x={labelW + (numBins * cellW) / 2}
            y={numDims * cellH + 30}
            textAnchor="middle"
            className="fill-slate-500"
            fontSize={10}
          >
            Episode progress
          </text>

          {/* Color bar */}
          {Array.from({ length: 10 }, (_, i) => {
            const t = i / 9;
            const barX = labelW + numBins * cellW + 16;
            const barH = (numDims * cellH) / 10;
            return (
              <rect
                key={i}
                x={barX}
                y={(9 - i) * barH}
                width={12}
                height={barH}
                fill={varColor(t * maxVar)}
              />
            );
          })}
          <text
            x={labelW + numBins * cellW + 34}
            y={10}
            className="fill-slate-500"
            fontSize={8}
            dominantBaseline="central"
          >
            high
          </text>
          <text
            x={labelW + numBins * cellW + 34}
            y={numDims * cellH - 4}
            className="fill-slate-500"
            fontSize={8}
            dominantBaseline="central"
          >
            low
          </text>
        </svg>
      </div>
    </div>
  );
}

// ─── Low-Movement Episodes ──────────────────────────────────────

function LowMovementSection({ episodes }: { episodes: LowMovementEpisode[] }) {
  if (episodes.length === 0) return null;

  const maxMovement = Math.max(...episodes.map(e => e.totalMovement), 1e-10);

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Lowest-Movement Episodes</h3>
        <p className="text-xs text-slate-400 mt-1">
          Episodes with the lowest average action change per frame (mean ‖Δa<sub>t</sub>‖). Very low values may indicate the robot
          was <span className="text-yellow-400">standing still</span> or the episode was recorded incorrectly.
        </p>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {episodes.map(ep => (
          <div key={ep.episodeIndex} className="bg-slate-900/50 rounded-md px-3 py-2 flex items-center gap-3">
            <span className="text-xs text-slate-300 font-medium shrink-0">ep {ep.episodeIndex}</span>
            <div className="flex-1 min-w-0">
              <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (ep.totalMovement / maxMovement) * 100)}%`,
                    background: ep.totalMovement / maxMovement < 0.15 ? "#ef4444" : ep.totalMovement / maxMovement < 0.4 ? "#eab308" : "#22c55e",
                  }}
                />
              </div>
            </div>
            <span className="text-[10px] text-slate-500 tabular-nums shrink-0">{ep.totalMovement.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────

interface ActionInsightsPanelProps {
  flatChartData: Record<string, number>[];
  fps: number;
  crossEpisodeData: CrossEpisodeVarianceData | null;
  crossEpisodeLoading: boolean;
}

const ActionInsightsPanel: React.FC<ActionInsightsPanelProps> = ({
  flatChartData,
  fps,
  crossEpisodeData,
  crossEpisodeLoading,
}) => {
  return (
    <div className="max-w-5xl mx-auto py-6 space-y-8">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Action Insights</h2>
        <p className="text-sm text-slate-400 mt-1">
          Data-driven analysis to guide action chunking, data quality assessment, and training configuration.
        </p>
      </div>

      <AutocorrelationSection data={flatChartData} fps={fps} agg={crossEpisodeData?.aggAutocorrelation} numEpisodes={crossEpisodeData?.numEpisodes} />
      <ActionVelocitySection data={flatChartData} agg={crossEpisodeData?.aggVelocity} numEpisodes={crossEpisodeData?.numEpisodes} />
      <VarianceHeatmap data={crossEpisodeData} loading={crossEpisodeLoading} />
      {crossEpisodeData?.lowMovementEpisodes && (
        <LowMovementSection episodes={crossEpisodeData.lowMovementEpisodes} />
      )}
    </div>
  );
};

export default ActionInsightsPanel;


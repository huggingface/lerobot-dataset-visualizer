"use client";

import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { CrossEpisodeVarianceData, AggVelocityStat, AggAutocorrelation, SpeedDistEntry, JerkyEpisode, TrajectoryClustering, AggAlignment } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";

const DELIMITER = " | ";

const FullscreenCtx = React.createContext(false);
const useIsFullscreen = () => React.useContext(FullscreenCtx);

function InfoToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(v => !v)} className="p-0.5 rounded-full text-slate-500 hover:text-slate-300 transition-colors shrink-0" title="Toggle description">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </>
  );
}

function FullscreenWrapper({ children }: { children: React.ReactNode }) {
  const [fs, setFs] = useState(false);

  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFs(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fs]);

  return (
    <div className="relative">
      <button
        onClick={() => setFs(v => !v)}
        className="absolute top-3 right-3 z-10 p-1.5 rounded bg-slate-700/60 hover:bg-slate-600 text-slate-400 hover:text-slate-200 transition-colors backdrop-blur-sm"
        title={fs ? "Exit fullscreen" : "Fullscreen"}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {fs ? (
            <><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></>
          ) : (
            <><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></>
          )}
        </svg>
      </button>
      {fs ? (
        <div className="fixed inset-0 z-50 bg-slate-950/95 overflow-auto p-6">
          <button
            onClick={() => setFs(false)}
            className="fixed top-4 right-4 z-50 p-2 rounded bg-slate-700/80 hover:bg-slate-600 text-slate-300 hover:text-white transition-colors"
            title="Exit fullscreen (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <div className="max-w-7xl mx-auto"><FullscreenCtx.Provider value={true}>{children}</FullscreenCtx.Provider></div>
        </div>
      ) : children}
    </div>
  );
}

function FlagBtn({ id }: { id: number }) {
  const { has, toggle } = useFlaggedEpisodes();
  const flagged = has(id);
  return (
    <button onClick={() => toggle(id)} title={flagged ? "Unflag episode" : "Flag for review"}
      className={`p-0.5 rounded transition-colors ${flagged ? "text-orange-400" : "text-slate-600 hover:text-slate-400"}`}>
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill={flagged ? "currentColor" : "none"}
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    </button>
  );
}

function FlagAllBtn({ ids, label }: { ids: number[]; label?: string }) {
  const { addMany } = useFlaggedEpisodes();
  return (
    <button onClick={() => addMany(ids)}
      className="text-xs text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1">
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
      </svg>
      {label ?? "Flag all"}
    </button>
  );
}
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

function getStateKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter(k => k.includes("state") && k !== "timestamp" && !k.startsWith("action"))
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
  const isFs = useIsFullscreen();
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
  const isAgg = !!agg;
  const numEpisodesLabel = isAgg ? ` (${numEpisodes} episodes sampled)` : " (current episode)";

  const yDomain = useMemo(() => {
    if (chartData.length === 0 || shortKeys.length === 0) return [-0.2, 1] as [number, number];
    let min = Infinity;
    for (const row of chartData) for (const k of shortKeys) {
      const v = row[k];
      if (typeof v === "number" && v < min) min = v;
    }
    const lo = Math.floor(Math.min(min, 0) * 10) / 10;
    return [lo, 1] as [number, number];
  }, [chartData, shortKeys]);

  if (shortKeys.length === 0) return <p className="text-slate-500 italic">No action columns found.</p>;

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Action Autocorrelation<span className="text-xs text-slate-500 ml-2 font-normal">{numEpisodesLabel}</span></h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
          Shows how correlated each action dimension is with itself over increasing time lags.
          Where autocorrelation drops below 0.5 suggests a <span className="text-orange-400 font-medium">natural action chunk boundary</span> — actions
          beyond this lag are essentially independent, so executing them open-loop offers diminishing returns.
          <br />
          <span className="text-slate-500">
            Grounded in the theoretical result that chunk length should scale logarithmically with system stability constants
            (Zhang et al., 2025 — arXiv:2507.09061, Theorem 1).
          </span>
        </p>
          </InfoToggle>
        </div>
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

      <div className={isFs ? "h-[500px]" : "h-64"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart key={isAgg ? "agg" : "ep"} data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="lag"
              stroke="#94a3b8"
              label={{ value: "Lag (steps)", position: "insideBottom", offset: -8, fill: "#94a3b8", fontSize: 13 }}
            />
            <YAxis stroke="#94a3b8" domain={yDomain} />
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
            <span className="text-xs text-slate-400">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Action Velocity ─────────────────────────────────────────────

function ActionVelocitySection({ data, agg, numEpisodes, jerkyEpisodes }: { data: Record<string, number>[]; agg?: AggVelocityStat[]; numEpisodes?: number; jerkyEpisodes?: JerkyEpisode[] }) {
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
        <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Action Velocity (Δa) — Smoothness Proxy<span className="text-xs text-slate-500 ml-2 font-normal">{isAgg ? `(${numEpisodes} episodes sampled)` : "(current episode)"}</span></h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
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
          </InfoToggle>
        </div>
      </div>

      {/* Per-dimension mini histograms + stats */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {stats.map((s, si) => {
          const barH = 28;
          return (
            <div key={s.name} className="bg-slate-900/50 rounded-md px-2.5 py-2 space-y-1">
              <p className="text-xs font-medium text-slate-200 truncate" title={s.name}>{s.name}</p>
              <div className="flex gap-2 text-xs text-slate-400 tabular-nums">
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

      {jerkyEpisodes && jerkyEpisodes.length > 0 && <JerkyEpisodesList episodes={jerkyEpisodes} />}
    </div>
  );
}

function JerkyEpisodesList({ episodes }: { episodes: JerkyEpisode[] }) {
  const [showAll, setShowAll] = useState(false);
  const display = showAll ? episodes : episodes.slice(0, 15);

  return (
    <div className="bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700/60 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-200">
          Most Jerky Episodes <span className="text-xs text-slate-500 font-normal">sorted by mean |Δa|</span>
        </p>
        <div className="flex items-center gap-3">
          <FlagAllBtn ids={display.map(e => e.episodeIndex)} />
          {episodes.length > 15 && (
            <button onClick={() => setShowAll(v => !v)} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              {showAll ? "Show top 15" : `Show all ${episodes.length}`}
            </button>
          )}
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="w-5 py-1" />
              <th className="text-left py-1 pr-3">Episode</th>
              <th className="text-right py-1">Mean |Δa|</th>
            </tr>
          </thead>
          <tbody>
            {display.map(e => (
              <tr key={e.episodeIndex} className="border-b border-slate-800/40 text-slate-300">
                <td className="py-1"><FlagBtn id={e.episodeIndex} /></td>
                <td className="py-1 pr-3">ep {e.episodeIndex}</td>
                <td className="py-1 text-right tabular-nums">{e.meanAbsDelta.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

  const isFs = useIsFullscreen();
  const { actionNames, timeBins, variance, numEpisodes } = data;
  const numDims = actionNames.length;
  const numBins = timeBins.length;

  const maxVar = Math.max(...variance.flat(), 1e-10);

  const baseW = isFs ? 1000 : 560;
  const baseH = isFs ? 500 : 300;
  const cellW = Math.max(6, Math.min(isFs ? 24 : 14, Math.floor(baseW / numBins)));
  const cellH = Math.max(20, Math.min(isFs ? 56 : 36, Math.floor(baseH / numDims)));
  const labelW = 100;
  const svgW = labelW + numBins * cellW + 60;
  const svgH = numDims * cellH + 40;

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
        <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">
          Cross-Episode Action Variance
          <span className="text-xs text-slate-500 ml-2 font-normal">({numEpisodes} episodes sampled)</span>
        </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
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
          </InfoToggle>
        </div>
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

// ─── Demonstrator Speed Variance ────────────────────────────────

function SpeedVarianceSection({ distribution, numEpisodes }: { distribution: SpeedDistEntry[]; numEpisodes: number }) {
  const isFs = useIsFullscreen();
  const { speeds, mean, std, cv, median, bins, lo, binW, maxBin, verdict } = useMemo(() => {
    const sp = distribution.map(d => d.speed).sort((a, b) => a - b);
    const m = sp.reduce((a, b) => a + b, 0) / sp.length;
    const s = Math.sqrt(sp.reduce((a, v) => a + (v - m) ** 2, 0) / sp.length);
    const c = m > 0 ? s / m : 0;
    const med = sp[Math.floor(sp.length / 2)];

    const binCount = Math.min(30, Math.ceil(Math.sqrt(sp.length)));
    const lo = sp[0], hi = sp[sp.length - 1];
    const bw = (hi - lo || 1) / binCount;
    const b = new Array(binCount).fill(0);
    for (const v of sp) { let i = Math.floor((v - lo) / bw); if (i >= binCount) i = binCount - 1; b[i]++; }

    let v: { label: string; color: string; tip: string };
    if (c < 0.2) v = { label: "Consistent", color: "text-green-400", tip: "Demonstrators execute at similar speeds — no velocity normalization needed." };
    else if (c < 0.4) v = { label: "Moderate variance", color: "text-yellow-400", tip: "Some speed variation across demonstrators. Consider velocity normalization for best results." };
    else v = { label: "High variance", color: "text-red-400", tip: "Large speed differences between demonstrations. Velocity normalization before training is strongly recommended." };

    return { speeds: sp, mean: m, std: s, cv: c, median: med, bins: b, lo, binW: bw, maxBin: Math.max(...b), verdict: v };
  }, [distribution]);

  if (speeds.length < 3) return null;

  const barH = isFs ? 250 : 100;
  const barW = Math.max(8, Math.floor((isFs ? 900 : 500) / bins.length));

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Demonstrator Speed Variance
            <span className="text-xs text-slate-500 ml-2 font-normal">({numEpisodes} episodes)</span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              Distribution of average execution speed (mean ‖Δa<sub>t</sub>‖ per frame) across all episodes.
              Different human demonstrators often execute at <span className="text-orange-400">different speeds</span>, creating
              artificial multimodality in the action distribution that confuses the policy. A coefficient of variation (CV) above 0.3
              strongly suggests normalizing trajectory speed before training.
              <br />
              <span className="text-slate-500">
                Based on &quot;Is Diversity All You Need&quot; (AGI-Bot, 2025) which shows velocity normalization dramatically improves
                fine-tuning success rate. Also relates to ACT (Zhao et al., 2023) and Pi0.5 (Physical Intelligence, 2025).
              </span>
            </p>
          </InfoToggle>
      </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 overflow-x-auto">
          <svg width={bins.length * barW} height={barH + 24} className="block">
            {bins.map((count: number, i: number) => {
              const h = maxBin > 0 ? (count / maxBin) * barH : 0;
              const speed = lo + (i + 0.5) * binW;
              const ratio = median > 0 ? speed / median : 1;
              const dev = Math.abs(ratio - 1);
              const color = dev < 0.2 ? "#22c55e" : dev < 0.5 ? "#eab308" : "#ef4444";
              return (
                <rect key={i} x={i * barW} y={barH - h} width={barW - 1} height={Math.max(1, h)} fill={color} opacity={0.7} rx={1}>
                  <title>{`Speed ${(lo + i * binW).toFixed(3)}–${(lo + (i + 1) * binW).toFixed(3)}: ${count} ep (${ratio.toFixed(2)}× median)`}</title>
                </rect>
              );
            })}
            {[0, 0.25, 0.5, 0.75, 1].map(frac => {
              const idx = Math.round(frac * (bins.length - 1));
              return (
                <text key={frac} x={idx * barW + barW / 2} y={barH + 14} textAnchor="middle" className="fill-slate-400" fontSize={9}>
                  {(lo + idx * binW).toFixed(2)}
                </text>
              );
            })}
          </svg>
        </div>
        <div className="flex flex-col gap-2 text-xs shrink-0 min-w-[120px]">
          <div><span className="text-slate-500">Mean</span> <span className="text-slate-200 tabular-nums ml-1">{mean.toFixed(4)}</span></div>
          <div><span className="text-slate-500">Median</span> <span className="text-slate-200 tabular-nums ml-1">{median.toFixed(4)}</span></div>
          <div><span className="text-slate-500">Std</span> <span className="text-slate-200 tabular-nums ml-1">{std.toFixed(4)}</span></div>
          <div>
            <span className="text-slate-500">CV</span>
            <span className={`tabular-nums ml-1 font-bold ${verdict.color}`}>{cv.toFixed(3)}</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700/60 space-y-1.5">
        <p className="text-sm font-medium text-slate-200">
          Verdict: <span className={verdict.color}>{verdict.label}</span>
        </p>
        <p className="text-xs text-slate-400">{verdict.tip}</p>
      </div>
    </div>
  );
}

// ─── State–Action Temporal Alignment ────────────────────────────

function StateActionAlignmentSection({ data, fps, agg, numEpisodes }: { data: Record<string, number>[]; fps: number; agg?: AggAlignment | null; numEpisodes?: number }) {
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
      const match = stateKeys.find(sKey => shortName(sKey) === shortName(aKey));
      if (match) pairs.push([aKey, match]);
    }
    if (pairs.length === 0) {
      const count = Math.min(actionKeys.length, stateKeys.length);
      for (let i = 0; i < count; i++) pairs.push([actionKeys[i], stateKeys[i]]);
    }
    if (pairs.length === 0) return null;

    // Per-pair cross-correlation
    const pairCorrs: number[][] = [];
    for (const [aKey, sKey] of pairs) {
      const aVals = data.map(row => row[aKey] ?? 0);
      const sDeltas = data.slice(1).map((row, i) => (row[sKey] ?? 0) - (data[i][sKey] ?? 0));
      const n = Math.min(aVals.length, sDeltas.length);
      const aM = aVals.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const sM = sDeltas.slice(0, n).reduce((a, b) => a + b, 0) / n;

      const corrs: number[] = [];
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sum = 0, aV = 0, sV = 0;
        for (let t = 0; t < n; t++) {
          const sIdx = t + lag;
          if (sIdx < 0 || sIdx >= sDeltas.length) continue;
          const a = aVals[t] - aM, s = sDeltas[sIdx] - sM;
          sum += a * s; aV += a * a; sV += s * s;
        }
        const d = Math.sqrt(aV * sV);
        corrs.push(d > 0 ? sum / d : 0);
      }
      pairCorrs.push(corrs);
    }

    // Aggregate min/mean/max per lag
    const ccData = Array.from({ length: 2 * maxLag + 1 }, (_, li) => {
      const lag = -maxLag + li;
      const vals = pairCorrs.map(pc => pc[li]);
      return {
        lag, time: lag / fps,
        max: Math.max(...vals),
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        min: Math.min(...vals),
      };
    });

    // Peaks of the envelope curves
    let meanPeakLag = 0, meanPeakCorr = -Infinity;
    let maxPeakLag = 0, maxPeakCorr = -Infinity;
    let minPeakLag = 0, minPeakCorr = -Infinity;
    for (const row of ccData) {
      if (row.max > maxPeakCorr) { maxPeakCorr = row.max; maxPeakLag = row.lag; }
      if (row.mean > meanPeakCorr) { meanPeakCorr = row.mean; meanPeakLag = row.lag; }
      if (row.min > minPeakCorr) { minPeakCorr = row.min; minPeakLag = row.lag; }
    }

    // Per-pair individual peak lags (for showing the true range across dimensions)
    const perPairPeakLags = pairCorrs.map(pc => {
      let best = -Infinity, bestLag = 0;
      for (let li = 0; li < pc.length; li++) {
        if (pc[li] > best) { best = pc[li]; bestLag = -maxLag + li; }
      }
      return bestLag;
    });
    const lagRangeMin = Math.min(...perPairPeakLags);
    const lagRangeMax = Math.max(...perPairPeakLags);

    return { ccData, meanPeakLag, meanPeakCorr, maxPeakLag, maxPeakCorr, minPeakLag, minPeakCorr, lagRangeMin, lagRangeMax, numPairs: pairs.length, fromAgg: false };
  }, [data, fps, agg]);

  if (!result) return null;
  const { ccData, meanPeakLag, meanPeakCorr, maxPeakLag, maxPeakCorr, minPeakLag, minPeakCorr, lagRangeMin, lagRangeMax, numPairs, fromAgg } = result;
  const scopeLabel = fromAgg ? `${numEpisodes} episodes sampled` : "current episode";

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            State–Action Temporal Alignment
            <span className="text-xs text-slate-500 ml-2 font-normal">({scopeLabel}, {numPairs} matched pair{numPairs !== 1 ? "s" : ""})</span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              Per-dimension cross-correlation between action<sub>d</sub>(t) and Δstate<sub>d</sub>(t+lag), aggregated as
              <span className="text-orange-400"> max</span>, <span className="text-slate-200">mean</span>, and
              <span className="text-blue-400"> min</span> across all matched action–state pairs.
              The <span className="text-orange-400">peak lag</span> reveals the effective control delay — the time between
              when an action is commanded and when the corresponding state changes.
              <br />
              <span className="text-slate-500">
                Central to ACT (Zhao et al., 2023 — action chunking compensates for delay),
                Real-Time Chunking (RTC, 2024), and Training-Time RTC (Biza et al., 2025) — all address
                the timing mismatch between commanded actions and observed state changes.
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {meanPeakLag !== 0 && (
        <div className="flex items-center gap-3 bg-orange-500/10 border border-orange-500/30 rounded-md px-4 py-2.5">
          <span className="text-orange-400 font-bold text-lg tabular-nums">{meanPeakLag}</span>
          <div>
            <p className="text-sm text-orange-300 font-medium">
              Mean control delay: {meanPeakLag} step{Math.abs(meanPeakLag) !== 1 ? "s" : ""} ({(meanPeakLag / fps).toFixed(3)}s)
            </p>
            <p className="text-xs text-slate-400">
              {meanPeakLag > 0
                ? `State changes lag behind actions by ~${meanPeakLag} frames on average. Consider aligning action[t] with state[t+${meanPeakLag}].`
                : `Actions lag behind state changes by ~${-meanPeakLag} frames on average (predictive actions).`}
              {lagRangeMin !== lagRangeMax && ` Individual dimension peaks range from ${lagRangeMin} to ${lagRangeMax} steps.`}
            </p>
          </div>
        </div>
      )}

      <div className={isFs ? "h-[500px]" : "h-56"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={ccData} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="lag" stroke="#94a3b8"
              label={{ value: "Lag (steps)", position: "insideBottom", offset: -8, fill: "#94a3b8", fontSize: 13 }} />
            <YAxis stroke="#94a3b8" domain={[-0.5, 1]} />
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #475569", borderRadius: 6 }}
              labelFormatter={(v) => `Lag ${v} (${(Number(v) / fps).toFixed(3)}s)`}
              formatter={(v: number) => v.toFixed(3)}
            />
            <Line dataKey="max" stroke="#f97316" dot={false} strokeWidth={2} isAnimationActive={false} name="max" />
            <Line dataKey="mean" stroke="#94a3b8" dot={false} strokeWidth={2} isAnimationActive={false} name="mean" />
            <Line dataKey="min" stroke="#3b82f6" dot={false} strokeWidth={2} isAnimationActive={false} name="min" />
            <Line dataKey={() => 0} stroke="#64748b" strokeDasharray="6 4" dot={false} name="zero" legendType="none" isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
              </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-orange-500" />
          <span className="text-xs text-slate-400">max (peak: lag {maxPeakLag}, r={maxPeakCorr.toFixed(3)})</span>
            </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-slate-400" />
          <span className="text-xs text-slate-400">mean (peak: lag {meanPeakLag}, r={meanPeakCorr.toFixed(3)})</span>
          </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-blue-500" />
          <span className="text-xs text-slate-400">min (peak: lag {minPeakLag}, r={minPeakCorr.toFixed(3)})</span>
        </div>
      </div>

      {meanPeakLag === 0 && (
        <p className="text-xs text-green-400">
          Mean peak correlation at lag 0 (r={meanPeakCorr.toFixed(3)}) — actions and state changes are well-aligned in this episode.
        </p>
      )}
    </div>
  );
}

// ─── Multimodality Detection ────────────────────────────────────

const BC_THRESHOLD = 5 / 9;

function MultimodalitySection({ data }: { data: CrossEpisodeVarianceData }) {
  const isFs = useIsFullscreen();
  const { actionNames, timeBins, multimodality, numEpisodes } = data;
  if (!multimodality || multimodality.length === 0) return null;

  const numDims = actionNames.length;
  const numBins = timeBins.length;

  const { bimodalPct, verdict } = useMemo(() => {
    let bimodal = 0, total = 0;
    for (const row of multimodality!) for (const v of row) { total++; if (v > BC_THRESHOLD) bimodal++; }
    const pct = total > 0 ? (bimodal / total * 100) : 0;

    let v: { label: string; color: string };
    if (pct < 10) v = { label: "Mostly Unimodal", color: "text-green-400" };
    else if (pct < 30) v = { label: "Some Multimodality", color: "text-yellow-400" };
    else v = { label: "Significantly Multimodal", color: "text-red-400" };

    return { bimodalPct: pct, verdict: v };
  }, [multimodality]);

  const mBaseW = isFs ? 1000 : 560;
  const mBaseH = isFs ? 500 : 300;
  const cellW = Math.max(6, Math.min(isFs ? 24 : 14, Math.floor(mBaseW / numBins)));
  const cellH = Math.max(20, Math.min(isFs ? 56 : 36, Math.floor(mBaseH / numDims)));
  const labelW = 100;
  const svgW = labelW + numBins * cellW + 60;
  const svgH = numDims * cellH + 40;

  function bcColor(bc: number): string {
    if (bc < 0.4) {
      const t = bc / 0.4;
      return `rgb(${Math.round(34 + t * 200)}, ${Math.round(197 - t * 50)}, ${Math.round(94 - t * 50)})`;
    }
    const t = Math.min(1, (bc - 0.4) / 0.4);
    return `rgb(${Math.round(234 + t * 5)}, ${Math.round(147 - t * 79)}, ${Math.round(44 + t * 24)})`;
  }

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Multimodality Detection
            <span className="text-xs text-slate-500 ml-2 font-normal">({numEpisodes} episodes sampled)</span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              Bimodality coefficient (BC) per action dimension over episode progress.
              BC values above <span className="text-red-400">5/9 ≈ 0.556</span> suggest the action distribution at that point is bimodal —
              meaning demonstrators use <span className="text-red-400">multiple distinct strategies</span>. This directly answers:
              &quot;Do I need a generative policy (diffusion, flow-matching) or would MSE regression work?&quot;
              <br />
              <span className="text-slate-500">
                Grounded in Diffusion Policy (Chi et al., 2023 — diffusion handles multimodality natively),
                ACT (Zhao et al., 2023 — CVAE captures multiple modes). Extends the cross-episode variance heatmap above
                by distinguishing true multimodality from mere noise.
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg width={svgW} height={svgH} className="block">
          {multimodality.map((row, bi) => row.map((bc, di) => (
            <rect key={`${bi}-${di}`} x={labelW + bi * cellW} y={di * cellH} width={cellW} height={cellH}
              fill={bcColor(bc)} stroke="#1e293b" strokeWidth={0.5}>
              <title>{`${shortName(actionNames[di])} @ ${(timeBins[bi] * 100).toFixed(0)}%: BC=${bc.toFixed(3)} ${bc > BC_THRESHOLD ? "(bimodal)" : "(unimodal)"}`}</title>
            </rect>
          )))}
          {actionNames.map((name, di) => (
            <text key={di} x={labelW - 4} y={di * cellH + cellH / 2} textAnchor="end" dominantBaseline="central"
              className="fill-slate-400" fontSize={Math.min(11, cellH - 4)}>{shortName(name)}</text>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map(frac => {
            const binIdx = Math.round(frac * (numBins - 1));
            return (
              <text key={frac} x={labelW + binIdx * cellW + cellW / 2} y={numDims * cellH + 14}
                textAnchor="middle" className="fill-slate-400" fontSize={9}>{(frac * 100).toFixed(0)}%</text>
            );
          })}
          <text x={labelW + (numBins * cellW) / 2} y={numDims * cellH + 30}
            textAnchor="middle" className="fill-slate-500" fontSize={10}>Episode progress</text>
          {Array.from({ length: 10 }, (_, i) => {
            const t = i / 9;
            const barX = labelW + numBins * cellW + 16;
            const barCellH = (numDims * cellH) / 10;
            return <rect key={i} x={barX} y={(9 - i) * barCellH} width={12} height={barCellH} fill={bcColor(t)} />;
          })}
          <text x={labelW + numBins * cellW + 34} y={10} className="fill-slate-500" fontSize={8}
            dominantBaseline="central">bimodal</text>
          <text x={labelW + numBins * cellW + 34} y={numDims * cellH - 4} className="fill-slate-500" fontSize={8}
            dominantBaseline="central">unimodal</text>
        </svg>
      </div>

      <div className="bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700/60 space-y-1.5">
        <p className="text-sm font-medium text-slate-200">
          Assessment: <span className={verdict.color}>{verdict.label}</span>
          <span className="text-xs text-slate-500 ml-2">{bimodalPct.toFixed(1)}% of regions above threshold</span>
        </p>
        <p className="text-xs text-slate-400">
          {bimodalPct < 10
            ? "Action distributions are mostly unimodal — MSE regression or simple flow-matching should work well."
            : bimodalPct < 30
              ? "Moderate multimodality detected. A generative policy (diffusion/flow-matching) will likely outperform MSE regression in the highlighted regions."
              : "Significant multimodality across the trajectory. A generative policy (diffusion or flow-matching action head) is strongly recommended over MSE regression."}
        </p>
      </div>
    </div>
  );
}

// ─── Trajectory Clustering & Outlier Detection ──────────────────

const CLUSTER_COLORS = ["#f97316", "#3b82f6", "#22c55e", "#a855f7", "#eab308"];

function TrajectoryClusteringSection({ data, numEpisodes }: { data: TrajectoryClustering; numEpisodes: number }) {
  const { entries, numClusters, clusterSizes, outlierCount } = data;
  const isFs = useIsFullscreen();
  const router = useRouter();
  const pathname = usePathname();

  const [showAll, setShowAll] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [hoveredEp, setHoveredEp] = useState<number | null>(null);
  const [rotX, setRotX] = useState(-0.4);
  const [rotY, setRotY] = useState(0.6);
  const dragRef = React.useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const didDrag = useRef(false);

  const sorted = useMemo(() =>
    [...entries].sort((a, b) => b.distFromCenter - a.distFromCenter),
  [entries]);

  const plotW = isFs ? 900 : 500, plotH = isFs ? 700 : 400;
  const cx = plotW / 2, cy = plotH / 2;
  const scale = Math.min(plotW, plotH) * 0.35;

  // Normalize xyz to [-1, 1]
  const bounds = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (const e of entries) {
      if (e.x < xMin) xMin = e.x; if (e.x > xMax) xMax = e.x;
      if (e.y < yMin) yMin = e.y; if (e.y > yMax) yMax = e.y;
      if (e.z < zMin) zMin = e.z; if (e.z > zMax) zMax = e.z;
    }
    const r = Math.max(xMax - xMin, yMax - yMin, zMax - zMin) / 2 || 1;
    return { mx: (xMin + xMax) / 2, my: (yMin + yMax) / 2, mz: (zMin + zMax) / 2, r };
  }, [entries]);

  // Project 3D → 2D with rotation
  const projected = useMemo(() => {
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    return entries.map(e => {
      const nx = (e.x - bounds.mx) / bounds.r;
      const ny = (e.y - bounds.my) / bounds.r;
      const nz = (e.z - bounds.mz) / bounds.r;
      // Rotate around Y then X
      const x1 = nx * cosY + nz * sinY;
      const z1 = -nx * sinY + nz * cosY;
      const y1 = ny * cosX - z1 * sinX;
      const z2 = ny * sinX + z1 * cosX;
      return { sx: cx + x1 * scale, sy: cy - y1 * scale, depth: z2, entry: e };
    });
  }, [entries, rotX, rotY, bounds, cx, cy, scale]);

  // Sort by depth (back to front) for correct overlap
  const sortedByDepth = useMemo(() => [...projected].sort((a, b) => a.depth - b.depth), [projected]);

  const onMouseDown = (ev: React.MouseEvent) => {
    dragRef.current = { x: ev.clientX, y: ev.clientY, rx: rotX, ry: rotY };
    didDrag.current = false;
  };
  const onMouseMove = (ev: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = ev.clientX - dragRef.current.x;
    const dy = ev.clientY - dragRef.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    setRotY(dragRef.current.ry + dx * 0.005);
    setRotX(dragRef.current.rx + dy * 0.005);
  };
  const onMouseUp = () => { dragRef.current = null; };

  const navigateToEpisode = useCallback((epIdx: number) => {
    const base = pathname.replace(/\/episode_\d+$/, "");
    router.push(`${base}/episode_${epIdx}`);
  }, [pathname, router]);

  // Axis lines
  const axisLines = useMemo(() => {
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const project = (x: number, y: number, z: number) => {
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosX - z1 * sinX;
      return { px: cx + x1 * scale * 0.9, py: cy - y1 * scale * 0.9 };
    };
    const len = 1.1;
    return [
      { ...project(len, 0, 0), label: "PC1", color: "#64748b" },
      { ...project(0, len, 0), label: "PC2", color: "#64748b" },
      { ...project(0, 0, len), label: "PC3", color: "#64748b" },
    ].map(a => ({ ...a, ox: cx, oy: cy }));
  }, [rotX, rotY, cx, cy, scale]);

  const imbalance = useMemo(() => {
    const max = Math.max(...clusterSizes), min = Math.min(...clusterSizes);
    return max > 0 ? (max - min) / max : 0;
  }, [clusterSizes]);

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Trajectory Clustering & Outlier Detection
            <span className="text-xs text-slate-500 ml-2 font-normal">({numEpisodes} episodes sampled)</span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              Episodes clustered by trajectory similarity: each episode&apos;s action trajectory is time-normalized, standardized,
              and projected to 3D via PCA. K-means clustering (k selected by silhouette score) groups similar demonstrations.
              <span className="text-red-400"> Outlier episodes</span> ({">"} 2σ from cluster center) may indicate recording errors,
              failed demonstrations, or fundamentally different strategies worth reviewing.
              <span className="text-yellow-400"> Imbalanced clusters</span> suggest multimodal demonstrations.
              Drag to rotate.
              <br />
              <span className="text-slate-500">
                Grounded in FAST-UMI-100K (Zhao et al., 2025 — automatic quality tools at scale),
                &quot;Curating Demonstrations using Online Experience&quot; (Burns et al., 2025),
                GVL (Mazzaglia et al., 2024), and SARM (Li et al., 2025).
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[340px]">
          <div className="flex justify-end mb-1">
            <button onClick={() => setShowLabels(v => !v)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${showLabels ? "bg-orange-500/20 text-orange-400 border border-orange-500/40" : "text-slate-500 hover:text-slate-300 border border-slate-700"}`}>
              {showLabels ? "Hide episodes" : "Show episodes"}
            </button>
          </div>
          <svg
            width={plotW} height={plotH}
            className="block bg-slate-900/50 rounded cursor-grab active:cursor-grabbing select-none"
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
            onMouseLeave={(ev) => { onMouseUp(); setHoveredEp(null); }}
          >
            {axisLines.map(a => (
              <React.Fragment key={a.label}>
                <line x1={a.ox} y1={a.oy} x2={a.px} y2={a.py} stroke={a.color} strokeWidth={0.5} strokeDasharray="4 3" opacity={0.4} />
                <text x={a.px} y={a.py} className="fill-slate-600" fontSize={9} textAnchor="middle" dominantBaseline="central">{a.label}</text>
              </React.Fragment>
            ))}
            {sortedByDepth.map(({ sx, sy, depth, entry: e }, i) => {
              const color = CLUSTER_COLORS[e.cluster % CLUSTER_COLORS.length];
              const depthFade = 0.3 + 0.7 * ((depth + 1) / 2);
              const isHovered = hoveredEp === e.episodeIndex;
              const r = isHovered ? 7 : e.isOutlier ? 5 : 2.5 + depthFade * 2;
              return (
                <g key={i}
                  onMouseEnter={() => setHoveredEp(e.episodeIndex)}
                  onMouseLeave={() => setHoveredEp(null)}
                  onClick={() => { if (!didDrag.current) navigateToEpisode(e.episodeIndex); }}
                  className="cursor-pointer"
                >
                  <circle cx={sx} cy={sy} r={r}
                    fill={e.isOutlier ? "transparent" : color}
                    stroke={isHovered ? "#fff" : e.isOutlier ? "#ef4444" : color}
                    strokeWidth={isHovered ? 2 : e.isOutlier ? 2 : 0}
                    opacity={e.isOutlier ? 1 : isHovered ? 1 : depthFade * 0.8}
                  />
                  {(showLabels || isHovered) && (
                    <text x={sx} y={sy - r - 3} textAnchor="middle" fontSize={isHovered ? 11 : 8}
                      className={isHovered ? "fill-white font-semibold" : "fill-slate-400"} pointerEvents="none">
                      {e.episodeIndex}
                    </text>
                  )}
                </g>
              );
            })}
            {hoveredEp !== null && (() => {
              const p = sortedByDepth.find(p => p.entry.episodeIndex === hoveredEp);
              if (!p) return null;
              const e = p.entry;
              return (
                <g pointerEvents="none">
                  <rect x={p.sx + 10} y={p.sy - 30} width={130} height={40} rx={4} fill="#0f172a" stroke="#334155" strokeWidth={1} opacity={0.95} />
                  <text x={p.sx + 16} y={p.sy - 16} fontSize={10} className="fill-slate-200 font-medium">
                    Episode {e.episodeIndex}
                  </text>
                  <text x={p.sx + 16} y={p.sy - 2} fontSize={9} className="fill-slate-400">
                    cluster {e.cluster} · dist {e.distFromCenter.toFixed(2)}{e.isOutlier ? " · outlier" : ""}
                  </text>
                </g>
              );
            })()}
          </svg>
        </div>

        <div className="flex flex-col gap-3 text-xs shrink-0 min-w-[160px]">
          <div>
            <p className="text-slate-500 mb-1">Clusters: {numClusters}</p>
            {clusterSizes.map((size, c) => (
              <div key={c} className="flex items-center gap-2 py-0.5">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CLUSTER_COLORS[c % CLUSTER_COLORS.length] }} />
                <span className="text-slate-300">Cluster {c}</span>
                <span className="text-slate-500 tabular-nums ml-auto">{size} ep</span>
              </div>
            ))}
          </div>
          {outlierCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0 border-2 border-red-500" />
              <span className="text-red-400">{outlierCount} outlier{outlierCount !== 1 ? "s" : ""}</span>
            </div>
          )}
          {imbalance > 0.5 && (
            <p className="text-yellow-400 text-xs">
              Clusters are imbalanced ({(imbalance * 100).toFixed(0)}% size ratio) — the dataset may contain multiple distinct strategies.
            </p>
          )}
        </div>
      </div>

      <div className="bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700/60 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-200">
            {showAll ? "All Episodes" : "Most Anomalous Episodes"} <span className="text-xs text-slate-500 font-normal">sorted by distance from cluster center</span>
          </p>
          <div className="flex items-center gap-3">
            <FlagAllBtn ids={entries.filter(e => e.isOutlier).map(e => e.episodeIndex)} label="Flag outliers" />
            <button onClick={() => setShowAll(v => !v)} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
              {showAll ? "Show top 15" : `Show all ${entries.length}`}
            </button>
          </div>
        </div>
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700">
                <th className="w-5 py-1" />
                <th className="text-left py-1 pr-3">Episode</th>
                <th className="text-left py-1 pr-3">Cluster</th>
                <th className="text-right py-1">Distance</th>
              </tr>
            </thead>
            <tbody>
              {(showAll ? sorted : sorted.slice(0, 15)).map(e => (
                <tr key={e.episodeIndex} className={`border-b border-slate-800/40 ${e.isOutlier ? "text-red-400" : "text-slate-300"}`}>
                  <td className="py-1"><FlagBtn id={e.episodeIndex} /></td>
                  <td className="py-1 pr-3">ep {e.episodeIndex}{e.isOutlier ? " ⚠" : ""}</td>
                  <td className="py-1 pr-3">
                    <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: CLUSTER_COLORS[e.cluster % CLUSTER_COLORS.length] }} />
                    {e.cluster}
                  </td>
                  <td className="py-1 text-right tabular-nums">{e.distFromCenter.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const [mode, setMode] = useState<"episode" | "dataset">("dataset");
  const showAgg = mode === "dataset" && !!crossEpisodeData;

  return (
    <div className="max-w-5xl mx-auto py-6 space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Action Insights</h2>
        <p className="text-sm text-slate-400 mt-1">
          Data-driven analysis to guide action chunking, data quality assessment, and training configuration.
        </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-sm ${mode === "episode" ? "text-slate-100 font-medium" : "text-slate-500"}`}>Current Episode</span>
          <button
            onClick={() => setMode(m => m === "episode" ? "dataset" : "episode")}
            className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0 ${mode === "dataset" ? "bg-orange-500" : "bg-slate-600"}`}
            aria-label="Toggle episode/dataset scope"
          >
            <span className={`inline-block w-3.5 h-3.5 bg-white rounded-full transition-transform ${mode === "dataset" ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
          </button>
          <span className={`text-sm ${mode === "dataset" ? "text-slate-100 font-medium" : "text-slate-500"}`}>
            All Episodes{crossEpisodeData ? ` (${crossEpisodeData.numEpisodes})` : ""}
          </span>
        </div>
      </div>

      <FullscreenWrapper><AutocorrelationSection data={flatChartData} fps={fps} agg={showAgg ? crossEpisodeData?.aggAutocorrelation : null} numEpisodes={crossEpisodeData?.numEpisodes} /></FullscreenWrapper>
      <FullscreenWrapper><StateActionAlignmentSection data={flatChartData} fps={fps} agg={showAgg ? crossEpisodeData?.aggAlignment : null} numEpisodes={crossEpisodeData?.numEpisodes} /></FullscreenWrapper>

      {crossEpisodeData?.speedDistribution && crossEpisodeData.speedDistribution.length > 2 && (
        <FullscreenWrapper><SpeedVarianceSection distribution={crossEpisodeData.speedDistribution} numEpisodes={crossEpisodeData.numEpisodes} /></FullscreenWrapper>
      )}
      <FullscreenWrapper><VarianceHeatmap data={crossEpisodeData} loading={crossEpisodeLoading} /></FullscreenWrapper>
      {crossEpisodeData && <FullscreenWrapper><MultimodalitySection data={crossEpisodeData} /></FullscreenWrapper>}
    </div>
  );
};

export default ActionInsightsPanel;
export { ActionVelocitySection, TrajectoryClusteringSection, FullscreenWrapper };


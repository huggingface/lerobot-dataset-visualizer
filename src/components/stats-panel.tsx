"use client";

import React, { useState, useMemo, useCallback } from "react";
import type {
  DatasetDisplayInfo,
  ColumnMinMax,
  EpisodeLengthStats,
  EpisodeLengthInfo,
  CameraInfo,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";

interface StatsPanelProps {
  datasetInfo: DatasetDisplayInfo;
  episodeId: number;
  columnMinMax: ColumnMinMax[] | null;
  episodeLengthStats: EpisodeLengthStats | null;
  loading: boolean;
}

function formatTotalTime(totalFrames: number, fps: number): string {
  const totalSec = totalFrames / fps;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** SVG bar chart for the episode-length histogram */
const EpisodeLengthHistogram: React.FC<{ data: { binLabel: string; count: number }[] }> = ({ data }) => {
  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count));
  if (maxCount === 0) return null;

  const totalWidth = 560;
  const gap = Math.max(1, Math.min(3, Math.floor(60 / data.length)));
  const barWidth = Math.max(4, Math.floor((totalWidth - gap * data.length) / data.length));
  const chartHeight = 150;
  const labelHeight = 30;
  const topPad = 16;
  const svgWidth = data.length * (barWidth + gap);
  const labelStep = Math.max(1, Math.ceil(data.length / 10));

  return (
    <div className="overflow-x-auto">
      <svg width={svgWidth} height={topPad + chartHeight + labelHeight} className="block" aria-label="Episode length distribution histogram">
        {data.map((bin, i) => {
          const barH = Math.max(1, (bin.count / maxCount) * chartHeight);
          const x = i * (barWidth + gap);
          const y = topPad + chartHeight - barH;
          return (
            <g key={i}>
              <title>{`${bin.binLabel}: ${bin.count} episode${bin.count !== 1 ? "s" : ""}`}</title>
              <rect x={x} y={y} width={barWidth} height={barH} className="fill-orange-500/80 hover:fill-orange-400 transition-colors" rx={Math.min(2, barWidth / 4)} />
              {bin.count > 0 && barWidth >= 8 && (
                <text x={x + barWidth / 2} y={y - 3} textAnchor="middle" className="fill-slate-400" fontSize={Math.min(10, barWidth - 1)}>
                  {bin.count}
                </text>
              )}
            </g>
          );
        })}
        {data.map((bin, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === data.length - 1;
          if (!isFirst && !isLast && idx % labelStep !== 0) return null;
          const label = bin.binLabel.split("–")[0];
          return (
            <text key={idx} x={idx * (barWidth + gap) + barWidth / 2} y={topPad + chartHeight + 14} textAnchor="middle" className="fill-slate-400" fontSize={9}>
              {label}s
            </text>
          );
        })}
      </svg>
    </div>
  );
};

const Card: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="bg-slate-800/60 rounded-lg p-4 border border-slate-700">
    <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
    <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
  </div>
);

function EpisodeLengthFilter({ episodes }: { episodes: EpisodeLengthInfo[] }) {
  const globalMin = useMemo(() => Math.min(...episodes.map((e) => e.lengthSeconds)), [episodes]);
  const globalMax = useMemo(() => Math.max(...episodes.map((e) => e.lengthSeconds)), [episodes]);

  const [rangeMin, setRangeMin] = useState(globalMin);
  const [rangeMax, setRangeMax] = useState(globalMax);
  const [showOutside, setShowOutside] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const inRange = episodes.filter((e) => e.lengthSeconds >= rangeMin && e.lengthSeconds <= rangeMax);
    const outRange = episodes.filter((e) => e.lengthSeconds < rangeMin || e.lengthSeconds > rangeMax);
    return showOutside ? outRange : inRange;
  }, [episodes, rangeMin, rangeMax, showOutside]);

  const ids = useMemo(() => filtered.map((e) => e.episodeIndex).sort((a, b) => a - b), [filtered]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(ids.join(", "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [ids]);

  const step = Math.max(0.01, Math.round((globalMax - globalMin) * 0.001 * 100) / 100) || 0.01;

  return (
    <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200">Episode Length Filter</h3>

      {/* Range slider row */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="tabular-nums">{rangeMin.toFixed(1)}s</span>
          <span className="tabular-nums">{rangeMax.toFixed(1)}s</span>
        </div>
        <div className="relative h-5">
          {/* track background */}
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1 rounded bg-slate-700" />
          {/* active range highlight */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1 rounded bg-orange-500"
            style={{
              left: `${((rangeMin - globalMin) / (globalMax - globalMin || 1)) * 100}%`,
              right: `${100 - ((rangeMax - globalMin) / (globalMax - globalMin || 1)) * 100}%`,
            }}
          />
          <input
            type="range"
            min={globalMin}
            max={globalMax}
            step={step}
            value={rangeMin}
            onChange={(e) => setRangeMin(Math.min(Number(e.target.value), rangeMax))}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-orange-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-orange-500 [&::-moz-range-thumb]:cursor-pointer"
          />
          <input
            type="range"
            min={globalMin}
            max={globalMax}
            step={step}
            value={rangeMax}
            onChange={(e) => setRangeMax(Math.max(Number(e.target.value), rangeMin))}
            className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-orange-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-orange-500 [&::-moz-range-thumb]:cursor-pointer"
          />
        </div>
      </div>

      {/* Mode selector */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400">Show:</span>
        <select
          value={showOutside ? "outside" : "inside"}
          onChange={(e) => setShowOutside(e.target.value === "outside")}
          className="bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600 focus:outline-none focus:border-orange-500"
        >
          <option value="inside">Episodes in range</option>
          <option value="outside">Episodes outside range</option>
        </select>
        <span className="text-xs text-slate-500 tabular-nums ml-auto">{ids.length} episode{ids.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Results box */}
      <div className="relative bg-slate-900/70 rounded-md border border-slate-700 p-3 max-h-40 overflow-y-auto">
        <button
          onClick={handleCopy}
          className="sticky top-0 float-right ml-2 p-1.5 rounded bg-slate-700/80 hover:bg-slate-600 text-slate-400 hover:text-slate-200 transition-colors backdrop-blur-sm"
          title="Copy to clipboard"
        >
          {copied ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
        </button>
        <p className="text-sm text-slate-300 tabular-nums leading-relaxed">
          {ids.length > 0 ? ids.join(", ") : <span className="text-slate-500 italic">No episodes match</span>}
        </p>
      </div>
    </div>
  );
}

const StatsPanel: React.FC<StatsPanelProps> = ({
  datasetInfo,
  episodeId,
  columnMinMax,
  episodeLengthStats,
  loading,
}) => {
  const els = episodeLengthStats;

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-8">
      <div>
        <h2 className="text-xl text-slate-100"><span className="font-bold">Dataset Statistics:</span> <span className="font-normal text-slate-400">{datasetInfo.repoId}</span></h2>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card label="Robot Type" value={datasetInfo.robot_type ?? "unknown"} />
        <Card label="Dataset Version" value={datasetInfo.codebase_version} />
        <Card label="Tasks" value={datasetInfo.total_tasks} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Total Frames" value={datasetInfo.total_frames.toLocaleString()} />
        <Card label="Total Episodes" value={datasetInfo.total_episodes.toLocaleString()} />
        <Card label="FPS" value={datasetInfo.fps} />
        <Card label="Total Recording Time" value={formatTotalTime(datasetInfo.total_frames, datasetInfo.fps)} />
      </div>

      {/* Camera resolutions */}
      {datasetInfo.cameras.length > 0 && (
        <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
          <h3 className="text-sm font-semibold text-slate-200 mb-3">Camera Resolutions</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {datasetInfo.cameras.map((cam: CameraInfo) => (
              <div key={cam.name} className="bg-slate-900/50 rounded-md p-3">
                <p className="text-xs text-slate-400 mb-1 truncate" title={cam.name}>{cam.name}</p>
                <p className="text-base font-bold tabular-nums">{cam.width}×{cam.height}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading spinner for async stats */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Computing episode statistics…
        </div>
      )}

      {/* Episode length section */}
      {els && (
        <>
          <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">Episode Lengths</h3>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-4 mb-4">
              <Card label="Shortest" value={`${els.shortestEpisodes[0]?.lengthSeconds ?? "–"}s`} />
              <Card label="Longest" value={`${els.longestEpisodes[els.longestEpisodes.length - 1]?.lengthSeconds ?? "–"}s`} />
              <Card label="Mean" value={`${els.meanEpisodeLength}s`} />
              <Card label="Median" value={`${els.medianEpisodeLength}s`} />
              <Card label="Std Dev" value={`${els.stdEpisodeLength}s`} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Top 5 Shortest</p>
                <table className="w-full text-sm">
                  <tbody>
                    {els.shortestEpisodes.map((ep) => (
                      <tr key={ep.episodeIndex} className="border-b border-slate-800/60">
                        <td className="py-1 text-slate-300">ep {ep.episodeIndex}</td>
                        <td className="py-1 text-right tabular-nums font-semibold">{ep.lengthSeconds}s</td>
                        <td className="py-1 text-right tabular-nums text-slate-500 text-xs">{ep.frames} fr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Top 5 Longest</p>
                <table className="w-full text-sm">
                  <tbody>
                    {els.longestEpisodes.map((ep) => (
                      <tr key={ep.episodeIndex} className="border-b border-slate-800/60">
                        <td className="py-1 text-slate-300">ep {ep.episodeIndex}</td>
                        <td className="py-1 text-right tabular-nums font-semibold">{ep.lengthSeconds}s</td>
                        <td className="py-1 text-right tabular-nums text-slate-500 text-xs">{ep.frames} fr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {els.episodeLengthHistogram.length > 0 && (
            <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200 mb-4">
                Episode Length Distribution
                <span className="text-xs text-slate-500 ml-2 font-normal">
                  {els.episodeLengthHistogram.length} bin{els.episodeLengthHistogram.length !== 1 ? "s" : ""}
                </span>
              </h3>
              <EpisodeLengthHistogram data={els.episodeLengthHistogram} />
            </div>
          )}

          <EpisodeLengthFilter episodes={els.allEpisodeLengths} />
        </>
      )}

      {/* Column min/max table */}
      {columnMinMax && columnMinMax.length > 0 && (
        <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
          <h3 className="text-sm font-semibold text-slate-200 mb-4">
            Column Min / Max
            <span className="text-xs text-slate-500 ml-2 font-normal">(episode {episodeId})</span>
          </h3>
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700 sticky top-0 bg-slate-800">
                  <th className="text-left py-2 pr-4 font-medium">Column</th>
                  <th className="text-right py-2 px-4 font-medium">Min</th>
                  <th className="text-right py-2 pl-4 font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {columnMinMax.map((col) => (
                  <tr key={col.column} className="border-b border-slate-800/60 hover:bg-slate-700/20">
                    <td className="py-1.5 pr-4 text-slate-300 truncate max-w-xs" title={col.column}>{col.column}</td>
                    <td className="py-1.5 px-4 text-right tabular-nums text-slate-300">{col.min}</td>
                    <td className="py-1.5 pl-4 text-right tabular-nums text-slate-300">{col.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default StatsPanel;

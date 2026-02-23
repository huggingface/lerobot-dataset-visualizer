"use client";

import type {
  DatasetDisplayInfo,
  EpisodeLengthStats,
  CameraInfo,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";

interface StatsPanelProps {
  datasetInfo: DatasetDisplayInfo;
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
function EpisodeLengthHistogram({
  data,
}: {
  data: { binLabel: string; count: number }[];
}) {
  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count));
  if (maxCount === 0) return null;

  const totalWidth = 560;
  const gap = Math.max(1, Math.min(3, Math.floor(60 / data.length)));
  const barWidth = Math.max(
    4,
    Math.floor((totalWidth - gap * data.length) / data.length),
  );
  const chartHeight = 150;
  const labelHeight = 30;
  const topPad = 16;
  const svgWidth = data.length * (barWidth + gap);
  const labelStep = Math.max(1, Math.ceil(data.length / 10));

  return (
    <div className="overflow-x-auto">
      <svg
        width={svgWidth}
        height={topPad + chartHeight + labelHeight}
        className="block"
        aria-label="Episode length distribution histogram"
      >
        {data.map((bin, i) => {
          const barH = Math.max(1, (bin.count / maxCount) * chartHeight);
          const x = i * (barWidth + gap);
          const y = topPad + chartHeight - barH;
          return (
            <g key={i}>
              <title>{`${bin.binLabel}: ${bin.count} episode${bin.count !== 1 ? "s" : ""}`}</title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                className="fill-orange-500/80 hover:fill-orange-400 transition-colors"
                rx={Math.min(2, barWidth / 4)}
              />
              {bin.count > 0 && barWidth >= 8 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 3}
                  textAnchor="middle"
                  className="fill-slate-400"
                  fontSize={Math.min(10, barWidth - 1)}
                >
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
            <text
              key={idx}
              x={idx * (barWidth + gap) + barWidth / 2}
              y={topPad + chartHeight + 14}
              textAnchor="middle"
              className="fill-slate-400"
              fontSize={9}
            >
              {label}s
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-800/60 rounded-lg p-4 border border-slate-700">
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  );
}

function StatsPanel({
  datasetInfo,
  episodeLengthStats,
  loading,
}: StatsPanelProps) {
  const els = episodeLengthStats;

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-8">
      <div>
        <h2 className="text-xl text-slate-100">
          <span className="font-bold">Dataset Statistics:</span>{" "}
          <span className="font-normal text-slate-400">
            {datasetInfo.repoId}
          </span>
        </h2>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card label="Robot Type" value={datasetInfo.robot_type ?? "unknown"} />
        <Card label="Dataset Version" value={datasetInfo.codebase_version} />
        <Card label="Tasks" value={datasetInfo.total_tasks} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card
          label="Total Frames"
          value={datasetInfo.total_frames.toLocaleString()}
        />
        <Card
          label="Total Episodes"
          value={datasetInfo.total_episodes.toLocaleString()}
        />
        <Card label="FPS" value={datasetInfo.fps} />
        <Card
          label="Total Recording Time"
          value={formatTotalTime(datasetInfo.total_frames, datasetInfo.fps)}
        />
      </div>

      {/* Camera resolutions */}
      {datasetInfo.cameras.length > 0 && (
        <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
          <h3 className="text-sm font-semibold text-slate-200 mb-3">
            Camera Resolutions
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {datasetInfo.cameras.map((cam: CameraInfo) => (
              <div key={cam.name} className="bg-slate-900/50 rounded-md p-3">
                <p
                  className="text-xs text-slate-400 mb-1 truncate"
                  title={cam.name}
                >
                  {cam.name}
                </p>
                <p className="text-base font-bold tabular-nums">
                  {cam.width}×{cam.height}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading spinner for async stats */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Computing episode statistics…
        </div>
      )}

      {/* Episode length section */}
      {els && (
        <>
          <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">
              Episode Lengths
            </h3>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-4 mb-4">
              <Card
                label="Shortest"
                value={`${els.shortestEpisodes[0]?.lengthSeconds ?? "–"}s`}
              />
              <Card
                label="Longest"
                value={`${els.longestEpisodes[els.longestEpisodes.length - 1]?.lengthSeconds ?? "–"}s`}
              />
              <Card label="Mean" value={`${els.meanEpisodeLength}s`} />
              <Card label="Median" value={`${els.medianEpisodeLength}s`} />
              <Card label="Std Dev" value={`${els.stdEpisodeLength}s`} />
            </div>
          </div>

          {els.episodeLengthHistogram.length > 0 && (
            <div className="bg-slate-800/60 rounded-lg p-5 border border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200 mb-4">
                Episode Length Distribution
                <span className="text-xs text-slate-500 ml-2 font-normal">
                  {els.episodeLengthHistogram.length} bin
                  {els.episodeLengthHistogram.length !== 1 ? "s" : ""}
                </span>
              </h3>
              <EpisodeLengthHistogram data={els.episodeLengthHistogram} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default StatsPanel;

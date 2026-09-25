"use client";

import type {
  DatasetDisplayInfo,
  EpisodeLengthStats,
  CameraInfo,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { InlineLoading, PageHeader, StatCard } from "@/components/ui";

interface StatsPanelProps {
  datasetInfo: DatasetDisplayInfo;
  episodeLengthStats: EpisodeLengthStats | null;
  loading: boolean;
}

function formatTotalTime(totalFrames: number, fps: number): string {
  const totalSec = Math.round(totalFrames / fps);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatSeconds(value: number | undefined): string {
  return value === undefined ? "–" : `${value.toFixed(2)}s`;
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
                className="fill-cyan-400/70 hover:fill-accent-fg transition-colors"
                rx={Math.min(2, barWidth / 4)}
              />
              {bin.count > 0 && barWidth >= 8 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 3}
                  textAnchor="middle"
                  className="fill-fg-muted"
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
              className="fill-fg-muted"
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

function StatsPanel({
  datasetInfo,
  episodeLengthStats,
  loading,
}: StatsPanelProps) {
  const els = episodeLengthStats;

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      <PageHeader
        title="Statistics"
        description={`Size, cameras and episode lengths of ${datasetInfo.repoId}.`}
      />

      {/* Overview cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label="Robot Type"
          value={datasetInfo.robot_type ?? "unknown"}
        />
        <StatCard
          label="Dataset Version"
          value={datasetInfo.codebase_version}
        />
        <StatCard label="Tasks" value={datasetInfo.total_tasks} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Frames"
          value={datasetInfo.total_frames.toLocaleString()}
        />
        <StatCard
          label="Total Episodes"
          value={datasetInfo.total_episodes.toLocaleString()}
        />
        <StatCard label="FPS" value={datasetInfo.fps} />
        <StatCard
          label="Total Recording Time"
          value={formatTotalTime(datasetInfo.total_frames, datasetInfo.fps)}
        />
      </div>

      {/* Camera resolutions */}
      {datasetInfo.cameras.length > 0 && (
        <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line">
          <h3 className="text-sm font-semibold text-fg mb-3">
            Camera Resolutions
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {datasetInfo.cameras.map((cam: CameraInfo) => (
              <StatCard
                key={cam.name}
                label={cam.name}
                value={`${cam.width}×${cam.height}`}
              />
            ))}
          </div>
        </div>
      )}

      {loading && <InlineLoading label="Computing episode statistics…" />}

      {/* Episode length section */}
      {els && (
        <>
          <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line">
            <h3 className="text-sm font-semibold text-fg mb-4">
              Episode Lengths
            </h3>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-4 mb-4">
              <StatCard
                label="Shortest"
                value={formatSeconds(els.shortestEpisodes[0]?.lengthSeconds)}
              />
              {/* longestEpisodes is sorted longest first. */}
              <StatCard
                label="Longest"
                value={formatSeconds(els.longestEpisodes[0]?.lengthSeconds)}
              />
              <StatCard
                label="Mean"
                value={formatSeconds(els.meanEpisodeLength)}
              />
              <StatCard
                label="Median"
                value={formatSeconds(els.medianEpisodeLength)}
              />
              <StatCard
                label="Std Dev"
                value={formatSeconds(els.stdEpisodeLength)}
              />
            </div>
          </div>

          {els.episodeLengthHistogram.length > 0 && (
            <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line">
              <h3 className="text-sm font-semibold text-fg mb-4">
                Episode Length Distribution
                <span className="text-xs text-fg-faint ml-2 font-normal">
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

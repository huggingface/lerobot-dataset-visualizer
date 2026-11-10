"use client";

import React, { useMemo, useState } from "react";
import type {
  DatasetDisplayInfo,
  DatasetSchema,
  DimensionStats,
  EpisodeLengthInfo,
  EpisodeLengthStats,
  FeatureSummary,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { Histogram, RangeBar } from "@/components/charts";
import {
  EpisodeLink,
  FlagAllButton,
  FlagButton,
  InlineLoading,
  PageHeader,
  StatCard,
} from "@/components/ui";
import { episodesInBin } from "@/utils/episodeStats";

interface StatsPanelProps {
  datasetInfo: DatasetDisplayInfo;
  episodeLengthStats: EpisodeLengthStats | null;
  loading: boolean;
  schema: DatasetSchema | null;
  schemaLoading: boolean;
}

function formatDuration(totalSeconds: number): string {
  const totalSec = Math.round(totalSeconds);
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

const SECTION = "bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line";
const SECTION_TITLE = "text-sm font-semibold text-fg";
const TH =
  "py-1.5 pr-4 text-left text-[10px] font-normal uppercase tracking-wide text-fg-faint";

/** The shortest or longest few episodes, each a link with a flag. */
function ExtremeEpisodes({
  title,
  episodes,
}: {
  title: string;
  episodes: EpisodeLengthInfo[];
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-fg-faint">
          {title}
        </p>
        <FlagAllButton ids={episodes.map((e) => e.episodeIndex)} />
      </div>
      <ul>
        {episodes.map((episode) => (
          <li
            key={episode.episodeIndex}
            className="flex items-center gap-2 border-b border-line-subtle py-1 text-xs last:border-b-0"
          >
            <FlagButton id={episode.episodeIndex} />
            <EpisodeLink
              episode={episode.episodeIndex}
              className="flex-1 text-fg-soft"
            />
            <span className="tabular text-fg">
              {formatSeconds(episode.lengthSeconds)}
            </span>
            <span className="tabular w-20 text-right text-fg-faint">
              {episode.frames.toLocaleString()} frames
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const BIN_EPISODES_SHOWN = 80;

function EpisodeLengths({ stats }: { stats: EpisodeLengthStats }) {
  const [selectedBin, setSelectedBin] = useState<number | null>(null);
  const bins = stats.episodeLengthHistogram;
  const inBin = useMemo(
    () =>
      selectedBin === null
        ? []
        : episodesInBin(stats.allEpisodeLengths, bins, selectedBin),
    [stats.allEpisodeLengths, bins, selectedBin],
  );
  const shortest = stats.shortestEpisodes[0];
  // longestEpisodes is sorted longest first.
  const longest = stats.longestEpisodes[0];
  const selected = selectedBin !== null ? bins[selectedBin] : null;

  // Fixed-length episodes (common in simulation): one number says it all, and a one-bar
  // histogram or a "shortest five" list would only dress it up.
  if (shortest && shortest.lengthSeconds === longest.lengthSeconds) {
    return (
      <section className={`${SECTION} space-y-2`}>
        <h3 className={SECTION_TITLE}>Episode lengths</h3>
        <p className="text-sm text-fg-soft">
          Every episode is{" "}
          <span className="font-semibold text-fg tabular">
            {formatSeconds(shortest.lengthSeconds)}
          </span>{" "}
          long
          <span className="text-fg-muted tabular">
            {" "}
            ({shortest.frames.toLocaleString()} frames).
          </span>
        </p>
      </section>
    );
  }

  return (
    <section className={`${SECTION} space-y-5`}>
      <h3 className={SECTION_TITLE}>Episode lengths</h3>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        <StatCard
          label="Shortest"
          value={formatSeconds(shortest?.lengthSeconds)}
          detail={shortest && <EpisodeLink episode={shortest.episodeIndex} />}
        />
        <StatCard
          label="Longest"
          value={formatSeconds(longest?.lengthSeconds)}
          detail={longest && <EpisodeLink episode={longest.episodeIndex} />}
        />
        <StatCard
          label="Median"
          value={formatSeconds(stats.medianEpisodeLength)}
        />
        <StatCard label="Mean" value={formatSeconds(stats.meanEpisodeLength)} />
        <StatCard
          label="Std dev"
          value={formatSeconds(stats.stdEpisodeLength)}
        />
      </div>

      <div>
        <p className="mb-1 text-xs text-fg-muted">
          Episodes by length. Select a bar to list its episodes.
        </p>
        <Histogram
          bins={bins}
          ariaLabel="Episodes by length"
          formatValue={(seconds) => `${Number(seconds.toFixed(2))}s`}
          describeCount={(count) =>
            `${count.toLocaleString()} episode${count === 1 ? "" : "s"}`
          }
          marker={{
            value: stats.medianEpisodeLength,
            label: `median ${stats.medianEpisodeLength.toFixed(1)}s`,
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
              {selectedBin === 0
                ? `under ${selected.hi.toFixed(1)}s`
                : selectedBin === bins.length - 1
                  ? `of ${selected.lo.toFixed(1)}s or more`
                  : `from ${selected.lo.toFixed(1)}s to ${selected.hi.toFixed(1)}s`}
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
            {inBin.slice(0, BIN_EPISODES_SHOWN).map((episode) => (
              <li key={episode.episodeIndex}>
                <EpisodeLink
                  episode={episode.episodeIndex}
                  className="block rounded border border-line bg-fill px-1.5 py-0.5 text-xs text-fg-soft"
                >
                  <span title={formatSeconds(episode.lengthSeconds)}>
                    {episode.episodeIndex}
                  </span>
                </EpisodeLink>
              </li>
            ))}
            {inBin.length > BIN_EPISODES_SHOWN && (
              <li className="px-1.5 py-0.5 text-xs text-fg-faint">
                +{(inBin.length - BIN_EPISODES_SHOWN).toLocaleString()} more
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <ExtremeEpisodes title="Shortest" episodes={stats.shortestEpisodes} />
        <ExtremeEpisodes title="Longest" episodes={stats.longestEpisodes} />
      </div>
    </section>
  );
}

const TASKS_SHOWN = 8;

function Tasks({
  stats,
  fps,
  totalEpisodes,
}: {
  stats: EpisodeLengthStats;
  fps: number;
  totalEpisodes: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const tasks = showAll ? stats.tasks : stats.tasks.slice(0, TASKS_SHOWN);
  const most = stats.tasks[0]?.episodes || 1;

  return (
    <section className={SECTION}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className={SECTION_TITLE}>
          Tasks
          <span className="ml-2 text-xs font-normal text-fg-faint">
            {stats.tasks.length.toLocaleString()}
          </span>
        </h3>
        {stats.tasks.length > TASKS_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-fg-muted transition-colors hover:text-fg"
          >
            {showAll ? `Show top ${TASKS_SHOWN}` : `Show all`}
          </button>
        )}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            {/* w-full with the cell's max-w-0: the task takes the room left and truncates in it. */}
            <th className={`${TH} w-full`}>Task</th>
            <th className={`${TH} text-right`}>Episodes</th>
            <th className={TH}>Share</th>
            <th className={`${TH} pr-0 text-right`}>Recorded</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.task}
              className="border-b border-line-subtle last:border-b-0"
            >
              <td className="max-w-0 py-1.5 pr-4 text-fg">
                <p className="truncate" title={task.task}>
                  {task.task}
                </p>
              </td>
              <td className="tabular py-1.5 pr-4 text-right text-fg">
                {task.episodes.toLocaleString()}
              </td>
              <td className="py-1.5 pr-4">
                <div className="flex w-52 items-center gap-2">
                  {/* Bars share the longest task's scale, so they compare by length. */}
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-strong">
                    <div
                      className="h-full rounded-full bg-[var(--series-1)]"
                      style={{ width: `${(task.episodes / most) * 100}%` }}
                    />
                  </div>
                  <span className="tabular w-9 text-right text-fg-muted">
                    {Math.round((task.episodes / (totalEpisodes || 1)) * 100)}%
                  </span>
                </div>
              </td>
              <td className="tabular whitespace-nowrap py-1.5 text-right text-fg-muted">
                {formatDuration(task.frames / fps)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Cameras({ schema }: { schema: DatasetSchema }) {
  return (
    <section className={SECTION}>
      <h3 className={`${SECTION_TITLE} mb-3`}>
        Cameras
        <span className="ml-2 text-xs font-normal text-fg-faint">
          {schema.cameras.length}
        </span>
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className={TH}>Camera</th>
              <th className={TH}>Resolution</th>
              <th className={TH}>FPS</th>
              <th className={TH}>Codec</th>
              <th className={`${TH} pr-0`}>Pixel format</th>
            </tr>
          </thead>
          <tbody>
            {schema.cameras.map((camera) => (
              <tr
                key={camera.name}
                className="border-b border-line-subtle last:border-b-0"
              >
                <td className="py-1.5 pr-4 font-mono text-fg">
                  {camera.name}
                  {camera.isDepth && (
                    <span className="ml-2 rounded border border-line px-1 font-sans text-[10px] text-fg-muted">
                      depth
                    </span>
                  )}
                </td>
                <td className="tabular py-1.5 pr-4 text-fg">
                  {camera.width}×{camera.height}
                </td>
                <td className="tabular py-1.5 pr-4 text-fg-muted">
                  {camera.fps ?? "–"}
                </td>
                <td className="py-1.5 pr-4 text-fg-muted">
                  {camera.codec ?? "–"}
                </td>
                <td className="py-1.5 text-fg-muted">
                  {camera.pixelFormat ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Decimals that keep a feature's values readable whatever their size. */
function decimalsFor(stats: DimensionStats[]): number {
  const largest = Math.max(
    ...stats.map((s) => Math.max(Math.abs(s.min), Math.abs(s.max))),
    1e-12,
  );
  return Math.max(0, Math.min(4, 3 - Math.floor(Math.log10(largest))));
}

function FeatureStatistics({ feature }: { feature: FeatureSummary }) {
  const stats = feature.stats!;
  const decimals = decimalsFor(stats);
  const scaleMin = Math.min(...stats.map((s) => s.min));
  const scaleMax = Math.max(...stats.map((s) => s.max));
  const format = (value: number) => value.toFixed(decimals);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            <th className={TH}>Component</th>
            <th className={`${TH} text-right`}>Min</th>
            <th className={`${TH} text-right`}>Mean</th>
            <th className={`${TH} text-right`}>Max</th>
            <th className={`${TH} text-right`}>Std</th>
            <th className={`${TH} w-1/3 pr-0`}>
              Range, mean ± std
              <span className="ml-1 normal-case tracking-normal">
                (shared scale)
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => {
            const constant = s.max === s.min;
            return (
              <tr
                key={s.name}
                className="border-b border-line-subtle last:border-b-0"
              >
                <td className="py-1 pr-4 font-mono text-fg">
                  {s.name}
                  {constant && (
                    <span
                      className="ml-2 rounded border border-line px-1 font-sans text-[10px] text-fg-muted"
                      title="Minimum and maximum are equal: this component never changes"
                    >
                      constant
                    </span>
                  )}
                </td>
                <td className="tabular py-1 pr-4 text-right text-fg-muted">
                  {format(s.min)}
                </td>
                <td className="tabular py-1 pr-4 text-right text-fg">
                  {format(s.mean)}
                </td>
                <td className="tabular py-1 pr-4 text-right text-fg-muted">
                  {format(s.max)}
                </td>
                <td className="tabular py-1 pr-4 text-right text-fg-muted">
                  {format(s.std)}
                </td>
                <td className="py-1">
                  <RangeBar
                    {...s}
                    scaleMin={scaleMin}
                    scaleMax={scaleMax}
                    label={`${s.name}: ${format(s.min)} to ${format(s.max)}, mean ${format(s.mean)}, std ${format(s.std)}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Features({ schema }: { schema: DatasetSchema }) {
  const withStats = schema.features.filter((f) => f.stats);
  const anyStats = withStats.length > 0;

  return (
    <section className={`${SECTION} space-y-4`}>
      <div>
        <h3 className={SECTION_TITLE}>
          Features
          <span className="ml-2 text-xs font-normal text-fg-faint">
            {schema.features.length}
          </span>
        </h3>
        <p className="mt-1 text-xs text-fg-muted">
          {anyStats
            ? "Every recorded column. Vector features open to the dataset-wide statistics of each component, from meta/stats.json."
            : "Every recorded column. This dataset has no meta/stats.json, so there are no per-component statistics."}
        </p>
      </div>
      <ul className="space-y-1.5">
        {schema.features.map((feature) => {
          const summary = (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-fg">
                {feature.name}
              </span>
              <span className="text-fg-muted">{feature.dtype}</span>
              <span className="tabular w-16 text-right text-fg-faint">
                [{feature.shape.join(", ")}]
              </span>
            </>
          );
          if (!feature.stats) {
            return (
              <li
                key={feature.name}
                className="flex items-center gap-3 rounded-md border border-line-subtle px-3 py-1.5 pl-8 text-xs"
              >
                {summary}
              </li>
            );
          }
          return (
            <li key={feature.name}>
              <details
                className="group rounded-md border border-line bg-[var(--surface-0)]/50"
                // The two every policy trains on are open from the start.
                open={
                  feature.name === "action" ||
                  feature.name === "observation.state"
                }
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className="shrink-0 text-fg-muted transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  >
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                  {summary}
                </summary>
                <div className="border-t border-line px-3 py-2">
                  <FeatureStatistics feature={feature} />
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatsPanel({
  datasetInfo,
  episodeLengthStats,
  loading,
  schema,
  schemaLoading,
}: StatsPanelProps) {
  const stats = episodeLengthStats;

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      <PageHeader
        title="Statistics"
        description={`What ${datasetInfo.repoId} holds: its size, how long its episodes run, its tasks, cameras and features.`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Episodes"
          value={datasetInfo.total_episodes.toLocaleString()}
        />
        <StatCard
          label="Frames"
          value={datasetInfo.total_frames.toLocaleString()}
        />
        <StatCard
          label="Recorded"
          value={formatDuration(datasetInfo.total_frames / datasetInfo.fps)}
        />
        <StatCard label="FPS" value={datasetInfo.fps} />
        <StatCard label="Tasks" value={datasetInfo.total_tasks} />
        <StatCard label="Robot" value={datasetInfo.robot_type ?? "unknown"} />
        <StatCard label="Format" value={datasetInfo.codebase_version} />
        <StatCard label="Cameras" value={datasetInfo.cameras.length} />
      </div>

      {loading && <InlineLoading label="Reading the episode index…" />}
      {stats && <EpisodeLengths stats={stats} />}
      {stats && stats.tasks.length > 0 && (
        <Tasks
          stats={stats}
          fps={datasetInfo.fps}
          totalEpisodes={datasetInfo.total_episodes}
        />
      )}

      {schemaLoading && <InlineLoading label="Reading features…" />}
      {schema && schema.cameras.length > 0 && <Cameras schema={schema} />}
      {schema && schema.features.length > 0 && <Features schema={schema} />}
    </div>
  );
}

export default StatsPanel;

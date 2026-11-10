"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import type {
  AggVelocityStat,
  CrossEpisodeVarianceData,
  JerkyEpisode,
  LowMovementEpisode,
  EpisodeLengthStats,
  EpisodeLengthInfo,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import {
  FullscreenWrapper,
  InfoToggle,
} from "@/components/action-insights-panel";
import {
  EpisodeLink,
  FlagAllButton,
  FlagButton,
  FlagIcon,
  InlineLoading,
  PageHeader,
  crossEpisodeLoadingLabel,
} from "@/components/ui";
import { computeVelocityStats } from "@/utils/crossEpisode";

const SECTION = "bg-[var(--surface-1)]/60 rounded-lg p-5 border border-line";

// ─── Lowest-Movement Episodes ────────────────────────────────────

/** How an episode's movement compares with the dataset's typical episode. */
function movementLevel(ratio: number): {
  label: string;
  fill: string;
  text: string;
} {
  if (ratio < 0.25)
    return {
      label: "barely moves",
      fill: "var(--status-critical)",
      text: "text-critical-fg",
    };
  if (ratio < 0.6)
    return {
      label: "slow",
      fill: "var(--status-warning)",
      text: "text-warning-fg",
    };
  return { label: "", fill: "var(--series-1)", text: "text-fg-muted" };
}

function LowMovementSection({
  episodes,
  median,
}: {
  episodes: LowMovementEpisode[];
  /** The median movement over the sampled episodes: what "low" is measured against. */
  median: number;
}) {
  if (episodes.length === 0) return null;
  const reference = median > 0 ? median : 1;

  return (
    <div className={`${SECTION} space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg">
          Lowest-Movement Episodes
        </h3>
        <FlagAllButton ids={episodes.map((e) => e.episodeIndex)} />
      </div>
      <p className="text-xs text-fg-muted">
        Episodes with the lowest average action change per frame, as a share of
        the dataset&apos;s median episode. Very low values may indicate the
        robot was standing still or the episode was recorded incorrectly.
      </p>
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {episodes.map((ep) => {
          const ratio = ep.totalMovement / reference;
          const level = movementLevel(ratio);
          return (
            <li
              key={ep.episodeIndex}
              className="flex items-center gap-3 border-b border-line-subtle py-1.5 text-xs"
            >
              <FlagButton id={ep.episodeIndex} />
              {/* Fixed width so every bar starts at the same x, whatever the index's digit count. */}
              <EpisodeLink
                episode={ep.episodeIndex}
                className="w-14 shrink-0 font-medium text-fg-soft"
              />
              <div
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-strong"
                title={`Mean action change per frame: ${ep.totalMovement.toFixed(4)}`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, Math.min(100, ratio * 100))}%`,
                    background: level.fill,
                  }}
                />
              </div>
              <span
                className={`tabular w-44 shrink-0 whitespace-nowrap text-right ${level.text}`}
              >
                {ratio.toFixed(2)}× median
                {level.label && ` · ${level.label}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Episode Length Filter ────────────────────────────────────────

const LENGTH_BINS = 48;
const OUTSIDE_SHOWN = 60;

const THUMB =
  "absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent [&::-moz-range-thumb]:cursor-pointer";

function EpisodeLengthFilter({ episodes }: { episodes: EpisodeLengthInfo[] }) {
  const { addMany } = useFlaggedEpisodes();
  const globalMin = useMemo(
    () => Math.min(...episodes.map((e) => e.lengthSeconds)),
    [episodes],
  );
  const globalMax = useMemo(
    () => Math.max(...episodes.map((e) => e.lengthSeconds)),
    [episodes],
  );

  const [rangeMin, setRangeMin] = useState(globalMin);
  const [rangeMax, setRangeMax] = useState(globalMax);

  // Where the episodes are along the slider, so the handles can be set against the distribution
  // rather than blind. Same scale as the slider: its ends are the shortest and longest episode.
  const bins = useMemo(() => {
    const counts = new Array<number>(LENGTH_BINS).fill(0);
    const span = globalMax - globalMin || 1;
    for (const episode of episodes) {
      const i = Math.floor(
        ((episode.lengthSeconds - globalMin) / span) * LENGTH_BINS,
      );
      counts[Math.min(LENGTH_BINS - 1, i)]++;
    }
    return counts;
  }, [episodes, globalMin, globalMax]);
  const tallest = Math.max(...bins, 1);

  const outside = useMemo(
    () =>
      episodes
        .filter((e) => e.lengthSeconds < rangeMin || e.lengthSeconds > rangeMax)
        .sort((a, b) => a.lengthSeconds - b.lengthSeconds),
    [episodes, rangeMin, rangeMax],
  );
  const outsideIds = useMemo(
    () => outside.map((e) => e.episodeIndex).sort((a, b) => a - b),
    [outside],
  );

  if (globalMax === globalMin) {
    return (
      <div className={`${SECTION} space-y-2`}>
        <h3 className="text-sm font-semibold text-fg">Episode Length Filter</h3>
        <p className="text-xs text-fg-muted">
          Every episode is {globalMin.toFixed(2)}s long, so there is nothing to
          filter by length.
        </p>
      </div>
    );
  }

  const span = globalMax - globalMin;
  const rangeChanged = rangeMin > globalMin || rangeMax < globalMax;
  const step = Math.max(0.01, Math.round(span * 0.001 * 100) / 100) || 0.01;
  const clampMin = (value: number) =>
    Math.min(Math.max(value, globalMin), rangeMax);
  const clampMax = (value: number) =>
    Math.max(Math.min(value, globalMax), rangeMin);
  const numberInput =
    "tabular w-20 rounded border border-line bg-[var(--surface-0)] px-1.5 py-0.5 text-right text-xs text-fg focus:border-accent focus:outline-none";

  return (
    <div className={`${SECTION} space-y-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Episode Length Filter</h3>
        <p className="text-xs text-fg-muted tabular">
          <span className="font-semibold text-fg">
            {(episodes.length - outside.length).toLocaleString()}
          </span>{" "}
          of {episodes.length.toLocaleString()} episodes in range
        </p>
      </div>

      <div>
        {/* The distribution the handles cut: episodes outside the range are the ones to be flagged. */}
        <div className="flex h-12 items-end gap-px" aria-hidden="true">
          {bins.map((count, i) => {
            const center = globalMin + ((i + 0.5) / LENGTH_BINS) * span;
            const inside = center >= rangeMin && center <= rangeMax;
            return (
              <div
                key={i}
                className={`min-w-0 flex-1 rounded-t-sm ${inside ? "bg-[var(--series-1)]" : "bg-rose-500/70"}`}
                style={{
                  height:
                    count > 0 ? `${Math.max(4, (count / tallest) * 100)}%` : 0,
                }}
              />
            );
          })}
        </div>
        <div className="relative h-5">
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1 rounded bg-fill-strong" />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1 rounded bg-accent"
            style={{
              left: `${((rangeMin - globalMin) / span) * 100}%`,
              right: `${100 - ((rangeMax - globalMin) / span) * 100}%`,
            }}
          />
          <input
            type="range"
            aria-label="Shortest episode length to keep, in seconds"
            min={globalMin}
            max={globalMax}
            step={step}
            value={rangeMin}
            onChange={(e) => setRangeMin(clampMin(Number(e.target.value)))}
            className={THUMB}
          />
          <input
            type="range"
            aria-label="Longest episode length to keep, in seconds"
            min={globalMin}
            max={globalMax}
            step={step}
            value={rangeMax}
            onChange={(e) => setRangeMax(clampMax(Number(e.target.value)))}
            className={THUMB}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <label className="flex items-center gap-1.5">
            Keep from
            <input
              type="number"
              min={globalMin}
              max={rangeMax}
              step={0.1}
              value={Number(rangeMin.toFixed(2))}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value)) setRangeMin(clampMin(value));
              }}
              className={numberInput}
            />
            s
          </label>
          <label className="flex items-center gap-1.5">
            to
            <input
              type="number"
              min={rangeMin}
              max={globalMax}
              step={0.1}
              value={Number(rangeMax.toFixed(2))}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value)) setRangeMax(clampMax(value));
              }}
              className={numberInput}
            />
            s
          </label>
        </div>
      </div>

      {rangeChanged && (
        <div className="space-y-2 rounded-md border border-rose-500/25 bg-rose-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-fg-soft tabular">
              <span className="font-semibold text-fg">
                {outsideIds.length.toLocaleString()} episode
                {outsideIds.length !== 1 ? "s" : ""}
              </span>{" "}
              outside the range
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setRangeMin(globalMin);
                  setRangeMax(globalMax);
                }}
                className="btn"
              >
                Reset
              </button>
              {outsideIds.length > 0 && (
                <button
                  onClick={() => addMany(outsideIds)}
                  className="btn btn-flagged"
                >
                  <FlagIcon />
                  Flag {outsideIds.length.toLocaleString()} outside range
                </button>
              )}
            </div>
          </div>
          {outside.length > 0 && (
            <ul className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
              {outside.slice(0, OUTSIDE_SHOWN).map((episode) => (
                <li key={episode.episodeIndex}>
                  <EpisodeLink
                    episode={episode.episodeIndex}
                    className="block rounded border border-line bg-fill px-1.5 py-0.5 text-xs text-fg-soft"
                  >
                    <span
                      title={`${episode.lengthSeconds.toFixed(2)}s`}
                    >{`${episode.episodeIndex} · ${episode.lengthSeconds.toFixed(1)}s`}</span>
                  </EpisodeLink>
                </li>
              ))}
              {outside.length > OUTSIDE_SHOWN && (
                <li className="px-1.5 py-0.5 text-xs text-fg-faint">
                  +{(outside.length - OUTSIDE_SHOWN).toLocaleString()} more
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Action Velocity ─────────────────────────────────────────────

/** How a motor's spread of Δa compares with the busiest motor's. */
function smoothness(relativeStd: number): {
  label: "smooth" | "moderate" | "jerky";
  fill: string;
  text: string;
} {
  if (relativeStd < 0.4)
    return {
      label: "smooth",
      fill: "var(--status-good)",
      text: "text-good-fg",
    };
  if (relativeStd < 0.7)
    return {
      label: "moderate",
      fill: "var(--status-warning)",
      text: "text-warning-fg",
    };
  return {
    label: "jerky",
    fill: "var(--status-critical)",
    text: "text-critical-fg",
  };
}

const percent = (value: number) =>
  `${(value * 100).toFixed(Math.abs(value) < 0.1 ? 2 : 1)}%`;

function VelocityCard({
  stat,
  maxStd,
}: {
  stat: AggVelocityStat;
  maxStd: number;
}) {
  const dimmed = !!stat.inactive || !!stat.discrete;
  const tag =
    stat.inactive && stat.discrete
      ? "inactive & discrete"
      : stat.discrete
        ? "discrete"
        : stat.inactive
          ? "inactive"
          : null;
  const level = smoothness(stat.std / maxStd);
  // Each card is scaled to its own tallest bin: the shape is what is read, not the count.
  const tallest = Math.max(...stat.bins, 1);
  const binWidth = (stat.hi - stat.lo) / stat.bins.length;
  const height = 40;

  return (
    <div
      className={`rounded-md px-2.5 py-2 space-y-1.5 ${dimmed ? "bg-[var(--surface-0)]/30 opacity-60" : "bg-[var(--surface-0)]/50"}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p
          className={`min-w-0 truncate text-xs font-medium ${dimmed ? "text-fg-faint" : "text-fg"}`}
          title={stat.name}
        >
          {stat.name}
        </p>
        <span
          className={`shrink-0 text-[10px] ${tag ? "text-fg-faint" : level.text}`}
        >
          {tag ?? level.label}
        </span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${stat.bins.length} ${height}`}
        preserveAspectRatio="none"
        className="block h-10"
        role="img"
        aria-label={`Distribution of frame-to-frame change for ${stat.name}, within ±${percent(stat.hi)} of its range`}
      >
        {/* Zero change: the middle bin. A smooth motor piles up around it. */}
        <line
          x1={stat.bins.length / 2}
          x2={stat.bins.length / 2}
          y1={0}
          y2={height}
          stroke="var(--chart-axis)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {stat.bins.map((count, i) => {
          const h = (count / tallest) * height;
          return (
            <rect
              key={i}
              x={i + 0.1}
              y={height - h}
              width={0.8}
              height={h}
              fill={dimmed ? "var(--fg-faint)" : "var(--series-1)"}
            >
              <title>{`${percent(stat.lo + i * binWidth)} to ${percent(stat.lo + (i + 1) * binWidth)} of range: ${count.toLocaleString()} changes`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-fg-faint tabular">
        <span>−{percent(stat.hi)}</span>
        <span>0</span>
        <span>+{percent(stat.hi)}</span>
      </div>
      <div
        className={`flex gap-3 text-xs tabular ${dimmed ? "text-fg-faint" : "text-fg-muted"}`}
      >
        <span title="Standard deviation of the frame-to-frame change, as a share of the motor's range">
          σ {percent(stat.std)}
        </span>
        <span title="Largest frame-to-frame change, as a share of the motor's range">
          max {percent(stat.maxAbs)}
        </span>
      </div>
      {/* The spread against the busiest motor's; the word beside the name says what the colour means. */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-fill-strong">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, (stat.std / maxStd) * 100)}%`,
            background: dimmed ? "var(--line-strong)" : level.fill,
          }}
        />
      </div>
    </div>
  );
}

function ActionVelocitySection({
  data,
  agg,
  numEpisodes,
  jerkyEpisodes,
  episodeId,
}: {
  data: Record<string, number>[];
  agg?: AggVelocityStat[];
  numEpisodes?: number;
  jerkyEpisodes?: JerkyEpisode[];
  episodeId: number;
}) {
  // Until the dataset-wide analysis is in (or when there is none), the episode on screen.
  const fallbackStats = useMemo(() => {
    if (agg && agg.length > 0) return null;
    if (data.length < 2) return [];
    const keys = Object.keys(data[0])
      .filter((k) => k.startsWith("action") && k !== "timestamp")
      .sort();
    const actions = new Float32Array(data.length * keys.length);
    data.forEach((row, t) => {
      keys.forEach((key, d) => {
        actions[t * keys.length + d] = row[key] ?? 0;
      });
    });
    return computeVelocityStats(
      [{ index: episodeId, length: data.length, actions, states: null }],
      keys.length,
      keys,
    );
  }, [data, agg, episodeId]);

  const stats = useMemo(
    () => (agg && agg.length > 0 ? agg : (fallbackStats ?? [])),
    [agg, fallbackStats],
  );
  const isAgg = agg && agg.length > 0;

  const maxStd = useMemo(() => {
    const active = stats.filter((s) => !s.inactive && !s.discrete);
    return active.length > 0 ? Math.max(...active.map((s) => s.std)) : 1;
  }, [stats]);

  const insight = useMemo(() => {
    if (stats.length === 0) return null;
    const active = stats.filter((s) => !s.inactive && !s.discrete);
    const excluded = stats.filter((s) => s.inactive || s.discrete);
    const smooth = active.filter((s) => s.std / maxStd < 0.4);
    const moderate = active.filter(
      (s) => s.std / maxStd >= 0.4 && s.std / maxStd < 0.7,
    );
    const jerky = active.filter((s) => s.std / maxStd >= 0.7);
    const isGripper = (n: string) => /grip/i.test(n);
    const jerkyNonGripper = jerky.filter((s) => !isGripper(s.name));
    const jerkyGripper = jerky.filter((s) => isGripper(s.name));

    let verdict: { label: string; color: string };
    if (active.length === 0) {
      verdict = { label: "N/A", color: "text-fg-muted" };
    } else {
      const smoothRatio = smooth.length / active.length;
      if (smoothRatio >= 0.6 && jerkyNonGripper.length === 0)
        verdict = { label: "Smooth", color: "text-good-fg" };
      else if (jerkyNonGripper.length <= 2 && smoothRatio >= 0.3)
        verdict = { label: "Moderate", color: "text-warning-fg" };
      else verdict = { label: "Jerky", color: "text-critical-fg" };
    }

    const lines: string[] = [];
    if (smooth.length > 0)
      lines.push(
        `${smooth.length} smooth (${smooth.map((s) => s.name).join(", ")})`,
      );
    if (moderate.length > 0)
      lines.push(
        `${moderate.length} moderate (${moderate.map((s) => s.name).join(", ")})`,
      );
    if (jerkyNonGripper.length > 0)
      lines.push(
        `${jerkyNonGripper.length} jerky (${jerkyNonGripper.map((s) => s.name).join(", ")})`,
      );
    if (jerkyGripper.length > 0)
      lines.push(
        `${jerkyGripper.length} gripper${jerkyGripper.length > 1 ? "s" : ""} jerky — expected for binary open/close`,
      );
    if (excluded.length > 0) {
      const discreteOnly = excluded.filter((s) => s.discrete);
      const inactiveOnly = excluded.filter((s) => s.inactive && !s.discrete);
      const parts: string[] = [];
      if (discreteOnly.length > 0)
        parts.push(
          `${discreteOnly.length} discrete (${discreteOnly.map((s) => s.name).join(", ")})`,
        );
      if (inactiveOnly.length > 0)
        parts.push(
          `${inactiveOnly.length} inactive (${inactiveOnly.map((s) => s.name).join(", ")})`,
        );
      lines.push(`${parts.join("; ")} — excluded from verdict`);
    }

    let tip: string;
    if (verdict.label === "N/A")
      tip = "All motors are inactive or discrete — no motors to evaluate.";
    else if (verdict.label === "Smooth")
      tip = "Actions are consistent — longer action chunks should work well.";
    else if (verdict.label === "Moderate")
      tip =
        "Some dimensions show abrupt changes. Consider moderate chunk sizes.";
    else
      tip =
        "Many dimensions are jerky. Use shorter action chunks and consider filtering outlier episodes.";

    return { verdict, lines, tip };
  }, [stats, maxStd]);

  if (stats.length === 0)
    return (
      <p className="text-fg-faint italic">
        No action data for velocity analysis.
      </p>
    );

  return (
    <div className={`${SECTION} space-y-4`}>
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">
            Action Velocity (Δa) — Smoothness Proxy
            <span className="text-xs text-fg-faint ml-2 font-normal">
              {isAgg
                ? `${numEpisodes} episodes sampled`
                : `episode ${episodeId}`}
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-fg-muted">
              Shows the distribution of frame-to-frame action changes (Δa = a
              <sub>t+1</sub> − a<sub>t</sub>) for each dimension, as a share of
              that motor&apos;s range. A{" "}
              <span className="font-medium text-fg">
                tight distribution around zero
              </span>{" "}
              means smooth, predictable control — the system is likely stable
              and benefits from longer action chunks.{" "}
              <span className="font-medium text-fg">Fat tails or high std</span>{" "}
              indicate jerky demonstrations, suggesting shorter chunks and
              potentially beneficial noise injection. Each histogram spans the
              range that holds 99.5% of the changes; the rest are in its end
              bins.
              <br />
              <span className="text-fg-faint">
                Relates to the Lipschitz constant L<sub>π</sub> and smoothness C
                <sub>π</sub> in{" "}
                <a
                  href="https://arxiv.org/abs/2507.09061"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-soft"
                >
                  Zhang et al. (2025)
                </a>
                , which govern compounding error bounds (Assumptions 3.1, 4.1).
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
      >
        {stats.map((stat) => (
          <VelocityCard key={stat.name} stat={stat} maxStd={maxStd} />
        ))}
      </div>

      {insight && (
        <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-line space-y-1.5">
          <p className="text-sm font-medium text-fg">
            Overall:{" "}
            <span className={insight.verdict.color}>
              {insight.verdict.label}
            </span>
          </p>
          <ul className="text-xs text-fg-muted space-y-0.5 list-disc list-inside">
            {insight.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="text-xs text-fg-faint pt-1">{insight.tip}</p>
        </div>
      )}

      {jerkyEpisodes && jerkyEpisodes.length > 0 && (
        <JerkyEpisodesList episodes={jerkyEpisodes} />
      )}
    </div>
  );
}

function JerkyEpisodesList({ episodes }: { episodes: JerkyEpisode[] }) {
  const [showAll, setShowAll] = useState(false);
  const display = showAll ? episodes : episodes.slice(0, 15);
  const most = episodes[0]?.meanAbsDelta || 1;

  return (
    <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-line space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-fg">
          Most Jerky Episodes{" "}
          <span className="text-xs text-fg-faint font-normal">
            sorted by mean |Δa|
          </span>
        </p>
        <div className="flex items-center gap-3">
          <FlagAllButton ids={display.map((e) => e.episodeIndex)} />
          {episodes.length > 15 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-xs text-fg-muted hover:text-fg transition-colors"
            >
              {showAll ? "Show top 15" : `Show all ${episodes.length}`}
            </button>
          )}
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-fg-faint border-b border-line">
              <th className="w-5 py-1" />
              <th className="text-left py-1 pr-3 font-normal">Episode</th>
              <th className="py-1 pr-3" />
              <th className="whitespace-nowrap py-1 text-right font-normal">
                Mean |Δa|, share of range
              </th>
            </tr>
          </thead>
          <tbody>
            {display.map((e) => (
              <tr
                key={e.episodeIndex}
                className="border-b border-line-subtle text-fg-soft"
              >
                <td className="py-1">
                  <FlagButton id={e.episodeIndex} />
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  <EpisodeLink episode={e.episodeIndex} />
                </td>
                <td className="w-full py-1 pr-3">
                  {/* Against the jerkiest episode: how far the top of the list stands out. */}
                  <div className="h-1.5 overflow-hidden rounded-full bg-fill-strong">
                    <div
                      className="h-full rounded-full bg-[var(--series-1)]"
                      style={{ width: `${(e.meanAbsDelta / most) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="py-1 text-right tabular whitespace-nowrap">
                  {percent(e.meanAbsDelta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Filtering Panel ────────────────────────────────────────

interface FilteringPanelProps {
  repoId: string;
  /** The episode on screen: what the velocity section shows until the dataset-wide analysis is in. */
  episodeId: number;
  crossEpisodeData: CrossEpisodeVarianceData | null;
  crossEpisodeLoading: boolean;
  crossEpisodeProgress?: { done: number; total: number } | null;
  episodeLengthStats: EpisodeLengthStats | null;
  flatChartData: Record<string, number>[];
  onViewFlaggedEpisodes?: () => void;
}

function FlaggedIdsCopyBar({
  repoId,
  onViewEpisodes,
}: {
  repoId: string;
  onViewEpisodes?: () => void;
}) {
  const { flagged, count, clear, toggle } = useFlaggedEpisodes();
  const [copied, setCopied] = useState(false);

  const ids = useMemo(() => [...flagged].sort((a, b) => a - b), [flagged]);
  const idStr = ids.join(", ");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(idStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [idStr]);

  if (count === 0) return null;

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-rose-500/30 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-flag-fg">
          Flagged Episodes
          <span className="text-xs text-fg-faint ml-2 font-normal">
            ({count})
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="text-xs text-fg-muted hover:text-fg transition-colors flex items-center gap-1"
            title="Copy IDs"
          >
            {copied ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-green-400"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy IDs"}
          </button>
          <button
            onClick={clear}
            className="text-xs text-fg-faint hover:text-red-400 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
      {/* One chip per episode: open it to check, or drop the flag, without leaving the list. */}
      <ul
        className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto"
        aria-label="Flagged episodes"
      >
        {ids.map((id) => (
          <li
            key={id}
            className="flex items-center rounded border border-rose-500/25 bg-rose-500/10 text-xs text-fg-soft"
          >
            <EpisodeLink episode={id} className="py-0.5 pl-1.5 pr-1">
              {id}
            </EpisodeLink>
            <button
              type="button"
              onClick={() => toggle(id)}
              title={`Unflag episode ${id}`}
              aria-label={`Unflag episode ${id}`}
              className="rounded-r px-1 py-0.5 text-fg-faint transition-colors hover:bg-rose-500/20 hover:text-flag-fg"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {onViewEpisodes && (
        <button onClick={onViewEpisodes} className="btn w-full py-1.5">
          <FlagIcon />
          View flagged episodes
        </button>
      )}
      {/* Folded by default: open, the commands push every tool below off the screen. */}
      <details className="group rounded-md border border-line bg-[var(--surface-0)]/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-fg-muted [&::-webkit-details-marker]:hidden">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0 transition-transform group-open:rotate-90"
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          Delete the flagged episodes with the LeRobot CLI
        </summary>
        <div className="space-y-2.5 border-t border-line px-3 py-2">
          <p className="text-xs text-fg-muted">
            <a
              href="https://github.com/huggingface/lerobot"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-fg underline"
            >
              lerobot-edit-dataset
            </a>{" "}
            removes them in place, or writes a filtered copy:
          </p>
          <pre className="text-xs text-fg-soft bg-[var(--bg)]/50 rounded px-2 py-1.5 overflow-x-auto select-all">{`# Delete episodes (modifies original dataset)\nlerobot-edit-dataset \\\n    --repo_id ${repoId} \\\n    --operation.type delete_episodes \\\n    --operation.episode_indices "[${ids.join(", ")}]"`}</pre>
          <pre className="text-xs text-fg-soft bg-[var(--bg)]/50 rounded px-2 py-1.5 overflow-x-auto select-all">{`# Delete episodes and save to a new dataset (preserves original)\nlerobot-edit-dataset \\\n    --repo_id ${repoId} \\\n    --new_repo_id ${repoId}_filtered \\\n    --operation.type delete_episodes \\\n    --operation.episode_indices "[${ids.join(", ")}]"`}</pre>
        </div>
      </details>
    </div>
  );
}

function FilteringPanel({
  repoId,
  episodeId,
  crossEpisodeData,
  crossEpisodeLoading,
  crossEpisodeProgress,
  episodeLengthStats,
  flatChartData,
  onViewFlaggedEpisodes,
}: FilteringPanelProps) {
  const medianMovement = useMemo(() => {
    const speeds = (crossEpisodeData?.speedDistribution ?? [])
      .map((d) => d.speed)
      .sort((a, b) => a - b);
    return speeds.length > 0 ? speeds[Math.floor(speeds.length / 2)] : 0;
  }, [crossEpisodeData]);

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      <PageHeader
        title="Filtering"
        description="Identify and flag problematic episodes for removal. Flagged episodes appear in the sidebar and can be exported as a CLI command."
      />

      <FlaggedIdsCopyBar
        repoId={repoId}
        onViewEpisodes={onViewFlaggedEpisodes}
      />

      {episodeLengthStats?.allEpisodeLengths && (
        <EpisodeLengthFilter episodes={episodeLengthStats.allEpisodeLengths} />
      )}

      {crossEpisodeLoading && (
        <div className={SECTION}>
          <InlineLoading
            label={crossEpisodeLoadingLabel(crossEpisodeProgress)}
          />
        </div>
      )}

      {crossEpisodeData?.lowMovementEpisodes && (
        <LowMovementSection
          episodes={crossEpisodeData.lowMovementEpisodes}
          median={medianMovement}
        />
      )}

      <FullscreenWrapper>
        <ActionVelocitySection
          data={flatChartData}
          agg={crossEpisodeData?.aggVelocity}
          numEpisodes={crossEpisodeData?.numEpisodes}
          jerkyEpisodes={crossEpisodeData?.jerkyEpisodes}
          episodeId={episodeId}
        />
      </FullscreenWrapper>
    </div>
  );
}

export default FilteringPanel;

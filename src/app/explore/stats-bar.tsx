"use client";

import React from "react";
import type { ExploreStats, Breakdown } from "@/utils/explore-facets";
import { formatBytes } from "@/utils/explore-facets";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10">
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function BreakdownBars({
  title,
  data,
  max = 6,
}: {
  title: string;
  data: Breakdown[];
  max?: number;
}) {
  const top = data.slice(0, max);
  if (top.length === 0) return null;
  const peak = Math.max(...top.map((d) => d.count)) || 1;

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10">
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-3">
        {title}
      </p>
      <div className="space-y-1.5">
        {top.map((d) => (
          <div key={d.value} className="flex items-center gap-2 text-xs">
            <span
              className="w-24 shrink-0 truncate text-slate-300"
              title={d.label}
            >
              {d.label}
            </span>
            <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-cyan-400/60"
                style={{ width: `${(d.count / peak) * 100}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">
              {d.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Placeholder shown while the corpus-wide stats crawl streams in. */
export function StatsBarSkeleton() {
  return (
    <div className="space-y-4 mb-6 animate-pulse">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10"
          >
            <div className="h-3 w-20 rounded bg-white/10" />
            <div className="h-6 w-24 rounded bg-white/10 mt-2" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10"
          >
            <div className="h-3 w-24 rounded bg-white/10 mb-3" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-2 rounded-full bg-white/10" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StatsBar({ stats }: { stats: ExploreStats }) {
  const sizeSub =
    stats.withSizeCount < stats.count
      ? `size known for ${stats.withSizeCount.toLocaleString()} of ${stats.count.toLocaleString()}`
      : undefined;

  return (
    <div className="space-y-4 mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Datasets" value={stats.count.toLocaleString()} />
        <StatCard
          label="Total Size"
          value={formatBytes(stats.totalSizeBytes)}
          sub={sizeSub}
        />
        <StatCard
          label="Downloads"
          value={stats.totalDownloads.toLocaleString()}
        />
        <StatCard label="Likes" value={stats.totalLikes.toLocaleString()} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BreakdownBars title="By License" data={stats.licenseBreakdown} />
        <BreakdownBars title="By Robot" data={stats.robotBreakdown} />
      </div>
    </div>
  );
}

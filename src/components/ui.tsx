"use client";

import React from "react";
import Link from "next/link";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import { setTheme, useTheme } from "@/utils/theme";

/** Path of an episode's page, opened on the Episodes tab whatever tab was last used. */
export function episodeHref(episode: number): string {
  return `./episode_${episode}?tab=episodes`;
}

/**
 * An episode named in an analysis (a jerky episode, an outlier, a thumbnail) that opens it. Without
 * this the analysis tabs named episodes the reader then had to find by hand in the sidebar.
 */
export function EpisodeLink({
  episode,
  children,
  className = "",
}: {
  episode: number;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={episodeHref(episode)}
      title={`Open episode ${episode}`}
      className={`tabular underline-offset-2 transition-colors hover:text-accent-fg hover:underline focus-visible:text-accent-fg focus-visible:underline focus-visible:outline-none ${className}`}
    >
      {children ?? `ep ${episode}`}
    </Link>
  );
}

export function FlagIcon({
  size = 12,
  filled = false,
}: {
  size?: number;
  filled?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

/** Flags or unflags one episode. Rose only once flagged, per the colour semantics. */
export function FlagButton({
  id,
  size = 12,
  className = "",
}: {
  id: number;
  size?: number;
  className?: string;
}) {
  const { has, toggle } = useFlaggedEpisodes();
  const flagged = has(id);
  const label = flagged ? `Unflag episode ${id}` : `Flag episode ${id}`;
  return (
    <button
      type="button"
      onClick={() => toggle(id)}
      title={label}
      aria-label={label}
      aria-pressed={flagged}
      className={`rounded p-0.5 transition-colors ${flagged ? "text-rose-500 hover:text-flag-fg" : "text-fg-faint hover:text-fg-muted"} ${className}`}
    >
      <FlagIcon size={size} filled={flagged} />
    </button>
  );
}

/** Flags a whole list; once every one of them is flagged it offers to undo that instead. */
export function FlagAllButton({
  ids,
  label = "Flag all",
  unflagLabel = "Unflag all",
}: {
  ids: number[];
  label?: string;
  unflagLabel?: string;
}) {
  const { flagged, addMany, removeMany } = useFlaggedEpisodes();
  const allFlagged = ids.length > 0 && ids.every((id) => flagged.has(id));
  return (
    <button
      type="button"
      disabled={ids.length === 0}
      onClick={() => (allFlagged ? removeMany(ids) : addMany(ids))}
      className={`flex items-center gap-1 text-xs transition-colors disabled:opacity-40 ${allFlagged ? "text-flag-fg hover:text-fg-muted" : "text-fg-faint hover:text-flag-fg"}`}
    >
      <FlagIcon size={10} filled={allFlagged} />
      {allFlagged ? unflagLabel : label}
    </button>
  );
}

/**
 * Shared building blocks for the analysis tabs (Statistics, Filtering, Frames, Action Insights), so
 * their headings, cards, loading states and toggles look the same everywhere.
 */

/** Tab title and one-line description, with an optional control on the right. */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-fg">{title}</h2>
        {description && (
          <p className="text-sm text-fg-muted mt-1">{description}</p>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** A labelled number: the label styled like the sidebar's, the value large and tabular. */
export function StatCard({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-[var(--surface-1)]/60 px-4 py-3 min-w-0">
      <p
        className="text-[10px] uppercase tracking-wide text-fg-faint truncate"
        title={label}
      >
        {label}
      </p>
      <p className="text-lg font-semibold text-fg tabular mt-1 truncate">
        {value}
      </p>
    </div>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
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
  );
}

/** A spinner with a label, for a section that is still loading. */
export function InlineLoading({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted"
      role="status"
    >
      <Spinner />
      {label}
    </div>
  );
}

/** Two-state switch with a label on each side; the active side is highlighted. */
export function Switch({
  checked,
  onChange,
  offLabel,
  onLabel,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  offLabel: React.ReactNode;
  onLabel: React.ReactNode;
  ariaLabel: string;
}) {
  const labelClass = (active: boolean) =>
    `text-sm ${active ? "text-fg font-medium" : "text-fg-faint"}`;
  return (
    <div className="flex items-center gap-3">
      <span className={labelClass(!checked)}>{offLabel}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? "bg-accent" : "bg-fill-strong"}`}
      >
        <span
          className={`inline-block w-3.5 h-3.5 bg-white rounded-full transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`}
        />
      </button>
      <span className={labelClass(checked)}>{onLabel}</span>
    </div>
  );
}

/** A few mutually exclusive choices side by side; the chosen one is highlighted. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  ariaLabel: string;
}) {
  const move = (step: number) => {
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-line"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        else if (e.key === "ArrowLeft") move(-1);
        else return;
        e.preventDefault();
        // Keep focus on the choice that is now selected (currentTarget is gone by the next frame).
        const group = e.currentTarget;
        requestAnimationFrame(() =>
          group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
        );
      }}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`border-l border-line px-2.5 py-1 text-xs transition-colors first:border-l-0 ${
              checked
                ? "bg-accent/15 text-accent-fg"
                : "bg-fill text-fg-muted hover:bg-fill-strong hover:text-fg"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Repo and episode above the videos, on every tab that plays an episode. */
export function EpisodeHeader({
  repoId,
  episodeId,
}: {
  repoId: string;
  episodeId: number;
}) {
  return (
    <div className="flex items-center gap-4">
      <a
        href="https://github.com/huggingface/lerobot"
        target="_blank"
        rel="noopener noreferrer"
        className="block shrink-0 opacity-90 hover:opacity-100 transition-opacity"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://github.com/huggingface/lerobot/raw/main/media/readme/lerobot-logo-thumbnail.png"
          alt="LeRobot Logo"
          className="w-24"
        />
      </a>
      <div className="min-w-0">
        <a
          href={`https://huggingface.co/datasets/${repoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg hover:text-accent-fg transition-colors"
        >
          <p className="text-base font-medium truncate">{repoId}</p>
        </a>
        <p className="text-[10px] uppercase tracking-wide text-fg-faint mt-0.5 tabular">
          Episode · {episodeId}
        </p>
      </div>
    </div>
  );
}

/** Switches between the light and dark theme; the choice is remembered. */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-fill transition-colors"
    >
      {theme === "dark" ? (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

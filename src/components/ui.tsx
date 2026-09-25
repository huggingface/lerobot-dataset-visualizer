"use client";

import React from "react";
import { setTheme, useTheme } from "@/utils/theme";

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

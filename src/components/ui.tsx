"use client";

import React from "react";

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
        <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
        {description && (
          <p className="text-sm text-slate-400 mt-1">{description}</p>
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
    <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 px-4 py-3 min-w-0">
      <p
        className="text-[10px] uppercase tracking-wide text-slate-500 truncate"
        title={label}
      >
        {label}
      </p>
      <p className="text-lg font-semibold text-slate-100 tabular mt-1 truncate">
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
      className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400"
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
    `text-sm ${active ? "text-slate-100 font-medium" : "text-slate-500"}`;
  return (
    <div className="flex items-center gap-3">
      <span className={labelClass(!checked)}>{offLabel}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? "bg-cyan-500" : "bg-white/10"}`}
      >
        <span
          className={`inline-block w-3.5 h-3.5 bg-white rounded-full transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`}
        />
      </button>
      <span className={labelClass(checked)}>{onLabel}</span>
    </div>
  );
}

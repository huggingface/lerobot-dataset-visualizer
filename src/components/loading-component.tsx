"use client";

/**
 * Full-viewport loading overlay. `fixed` rather than `absolute` so the spinner sits at the same
 * spot through both loading phases (episode data, then videos and charts), which render it in
 * differently sized containers; the tab bar stacks above it.
 */
export default function Loading() {
  return (
    <div
      className="fixed inset-0 z-10 flex flex-col items-center justify-center bg-[var(--bg)]/80 backdrop-blur-sm text-fg"
      role="status"
      aria-live="polite"
    >
      {/* A bordered div rotated with transform runs on the compositor, so it keeps
          spinning while the main thread is busy decoding parquet and building charts.
          The SVG this replaces was animated on the main thread and stalled with it. */}
      <div className="mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-[var(--accent-soft)] border-t-[var(--accent)] [will-change:transform]" />
      <h1 className="text-sm font-medium tracking-wide uppercase text-fg-soft">
        Loading
      </h1>
      <p className="text-xs text-fg-faint mt-1">preparing data &amp; videos</p>
    </div>
  );
}

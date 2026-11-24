"use client";

/**
 * The reward-score controls of the Annotations tab: the row above the videos (the overlay switch
 * and the signal picker, with the episode's loading state) and the "Scored" chip in the title bar
 * of each camera the overlay is drawn on. The overlay itself is `score-overlay.tsx`.
 */

import React, { useEffect, useRef, useState } from "react";
import { useScores } from "@/context/scores-context";
import {
  scoreCamera,
  scoreModelName,
  signalKey,
  signalLabel,
  type ScoreFile,
  type ScoreSignal,
} from "@/utils/scores";
import { Spinner, Switch } from "./ui";

/**
 * The overlay switch and the signal picker, with the episode's loading state. Nothing for a dataset
 * without score files.
 */
export function ScoreControls() {
  const scores = useScores();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Closed by a click outside or Escape, as the tab bar's Advanced menu is.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!scores) return null;
  const {
    files,
    listingFailed,
    selected,
    setSignalSelected,
    showOverlay,
    setShowOverlay,
    cameras,
    episodeLoading,
    episodeErrors,
    episodeUnscored,
  } = scores;
  if (files.length === 0 && !listingFailed) return null;
  const count = files.reduce(
    (n, entry) =>
      n +
      (entry.file?.signals.filter((s) =>
        selected.has(signalKey(entry.name, s.name)),
      ).length ?? 0),
    0,
  );

  return (
    // Wrapped: the annotations skin lays out a `.flex` child of the videos block as the camera grid.
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span className="text-[10px] uppercase tracking-wide text-fg-faint">
          Reward scores
        </span>
        {listingFailed ? (
          <span className="text-xs text-critical-fg">
            The dataset&apos;s score files could not be listed.
          </span>
        ) : (
          <>
            <Switch
              checked={showOverlay}
              onChange={setShowOverlay}
              offLabel={null}
              onLabel="Overlay"
              ariaLabel="Draw the scores over the camera each model scored"
            />
            <div className="relative" ref={rootRef}>
              <button
                type="button"
                className="btn h-7 px-2.5 text-xs"
                aria-expanded={open}
                aria-haspopup="dialog"
                onClick={() => setOpen((v) => !v)}
              >
                Signals · {count}
              </button>
              {open && (
                <div
                  role="dialog"
                  aria-label="Choose score signals"
                  className="absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-1rem)] max-h-96 overflow-y-auto panel-raised bg-[var(--surface-1)] p-1.5 shadow-xl animate-menu-pop [transform-origin:top_left]"
                >
                  {files.map((entry) => (
                    <div key={entry.name} className="px-1.5 py-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold text-fg truncate">
                          {entry.file ? scoreModelName(entry.file) : entry.name}
                        </span>
                        <span className="font-mono text-[10px] text-fg-faint truncate">
                          scores/{entry.name}.parquet
                        </span>
                      </div>
                      {entry.file && (
                        <CameraLine file={entry.file} cameras={cameras} />
                      )}
                      {entry.error && (
                        <p className="mt-0.5 text-[11px] text-critical-fg">
                          {entry.error}
                        </p>
                      )}
                      {entry.warning && (
                        <p className="mt-0.5 text-[11px] text-warning-fg">
                          {entry.warning}
                        </p>
                      )}
                      {entry.file?.signals.map((signal) => {
                        const key = signalKey(entry.name, signal.name);
                        return (
                          <SignalOption
                            key={key}
                            signal={signal}
                            checked={selected.has(key)}
                            onChange={(on) => setSignalSelected(key, on)}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {episodeLoading && (
          <span
            className="flex items-center gap-1.5 text-xs text-fg-muted"
            role="status"
          >
            <Spinner className="h-3 w-3" /> Reading scores…
          </span>
        )}
        {episodeUnscored.length > 0 && (
          <span className="text-xs text-fg-muted">
            Not scored for this episode: {episodeUnscored.join(", ")}
          </span>
        )}
        {episodeErrors.map(({ name, message }) => (
          <span key={name} className="text-xs text-critical-fg">
            scores/{name}.parquet: {message}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Which camera a file's model read, or why its scores are drawn on another. */
function CameraLine({
  file,
  cameras,
}: {
  file: ScoreFile;
  cameras: readonly string[];
}) {
  const { camera, known, note } = scoreCamera(file, cameras);
  if (known) {
    return (
      <p className="mt-0.5 text-[11px] text-fg-muted">
        Scored on <span className="font-mono">{camera}</span>
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-[11px] text-warning-fg">
      {note}
      {camera && (
        <>
          ; drawn on <span className="font-mono">{camera}</span>
        </>
      )}
    </p>
  );
}

/** A signal in the picker: its name, and its unit, direction or subtask count. */
function SignalOption({
  signal,
  checked,
  onChange,
}: {
  signal: ScoreSignal;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { unit, labels, greaterIsBetter, description } = signal.descriptor;
  const detail = labels
    ? `${labels.length} subtasks`
    : [unit, greaterIsBetter === false && "lower is better"]
        .filter(Boolean)
        .join(" · ");
  return (
    <label
      className="mt-1 flex items-center gap-2 rounded px-1 py-0.5 text-xs text-fg-soft hover:bg-fill cursor-pointer"
      title={description ?? signal.name}
    >
      <input
        type="checkbox"
        className="accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="truncate">{signalLabel(signal)}</span>
      <span className="ml-auto shrink-0 text-[10px] text-fg-faint">
        {detail}
      </span>
    </label>
  );
}

/**
 * Marks a camera the overlay is drawn on, in its title bar: a reward model reads one camera's
 * frames, so its scores describe that view and are drawn over it only. A camera carrying scores
 * from a file that did not name it says so ("Scored?").
 */
export function ScoredCameraTag({ cameraKey }: { cameraKey: string }) {
  const scores = useScores();
  const models = scores?.showOverlay
    ? scores.scoredCameras.get(cameraKey)
    : undefined;
  if (!models || models.length === 0) return null;
  const unsure = models.filter((m) => m.note);
  const description = [
    `Reward models scored this camera's frames: ${models.map((m) => m.model).join(", ")}. Their scores describe this view, and are drawn over it only.`,
    ...unsure.map((m) => `${m.model}: ${m.note}; drawn here.`),
  ].join("\n");
  return (
    <span
      className={`shrink-0 rounded border px-1.5 text-[10px] ${
        unsure.length
          ? "border-line text-warning-fg"
          : "border-accent/30 bg-accent/10 text-accent-fg"
      }`}
      title={description}
    >
      {unsure.length ? "Scored?" : "Scored"}
      <span className="sr-only">: {description}</span>
    </span>
  );
}

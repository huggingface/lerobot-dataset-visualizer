"use client";

import React from "react";
import { FaPlay, FaPause, FaArrowDown, FaArrowUp } from "react-icons/fa";
import type { TrailMode } from "@/components/replay-trail";
import { Segmented } from "@/components/ui";

interface ReplayPlaybackBarProps {
  frame: number;
  totalFrames: number;
  fps: number;
  playing: boolean;
  onPlayPause: () => void;
  trailMode: TrailMode;
  onTrailModeChange: (mode: TrailMode) => void;
  onFrameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

export default function ReplayPlaybackBar({
  frame,
  totalFrames,
  fps,
  playing,
  onPlayPause,
  trailMode,
  onTrailModeChange,
  onFrameChange,
  disabled = false,
}: ReplayPlaybackBarProps) {
  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

  return (
    <div
      className={`flex items-center gap-3 ${disabled ? "opacity-50" : ""}`}
      aria-busy={disabled}
    >
      {/* Play/Pause */}
      <button
        onClick={onPlayPause}
        disabled={disabled}
        title={playing ? "Pause. Toggle with Space" : "Play. Toggle with Space"}
        className="h-9 w-9 flex items-center justify-center rounded-md bg-accent/10 border border-accent/30 text-accent-fg hover:bg-accent/15 disabled:bg-fill disabled:border-line-subtle disabled:text-fg-faint disabled:cursor-not-allowed transition-colors shrink-0"
      >
        {playing ? <FaPause size={14} /> : <FaPlay size={14} />}
      </button>

      {/* Trail: the tool point's last two seconds, or that over its whole episode's path. */}
      <div
        className={`flex shrink-0 items-center gap-1.5 ${disabled ? "pointer-events-none" : ""}`}
      >
        <span className="text-[11px] text-fg-muted">Trail</span>
        <Segmented
          ariaLabel="Trail"
          value={trailMode}
          onChange={onTrailModeChange}
          options={[
            { value: "off", label: "Off", title: "No trail" },
            {
              value: "recent",
              label: "Recent",
              title: "Where the gripper was in the last two seconds",
            },
            {
              value: "episode",
              label: "Episode",
              title:
                "The last two seconds, over the gripper's path through the whole episode",
            },
          ]}
        />
      </div>

      {/* Scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(totalFrames - 1, 0)}
        value={frame}
        onChange={onFrameChange}
        disabled={disabled}
        className="flex-1 min-w-16 mx-1 h-1 accent-accent cursor-pointer disabled:cursor-not-allowed"
        aria-label="Seek frame"
      />
      <span
        className="text-right tabular text-[11px] text-fg-muted shrink-0"
        title={`Frame ${frame} of ${Math.max(totalFrames - 1, 0)}`}
      >
        {currentTime}s / {totalTime}s
      </span>

      {/* Same hints, and breakpoint, as the Episodes playback bar. */}
      <div className="hidden lg:flex flex-col gap-y-0.5 ml-4 text-[10px] text-fg-faint select-none shrink-0">
        <p className="inline-flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded border border-line bg-fill text-fg-soft text-[10px]">
            Space
          </kbd>
          <span>pause/unpause</span>
        </p>
        <p className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 text-fg-soft">
            <FaArrowUp size={10} />
            <FaArrowDown size={10} />
          </span>
          <span>prev/next episode</span>
        </p>
      </div>
    </div>
  );
}

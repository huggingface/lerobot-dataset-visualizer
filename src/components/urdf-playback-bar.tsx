"use client";

import React from "react";

interface UrdfPlaybackBarProps {
  frame: number;
  totalFrames: number;
  fps: number;
  playing: boolean;
  onPlayPause: () => void;
  trailEnabled: boolean;
  onTrailToggle: () => void;
  onFrameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function UrdfPlaybackBar({
  frame,
  totalFrames,
  fps,
  playing,
  onPlayPause,
  trailEnabled,
  onTrailToggle,
  onFrameChange,
}: UrdfPlaybackBarProps) {
  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

  return (
    <div className="flex items-center gap-3">
      {/* Play/Pause */}
      <button
        onClick={onPlayPause}
        className="w-8 h-8 flex items-center justify-center rounded bg-orange-600 hover:bg-orange-500 text-white transition-colors shrink-0"
      >
        {playing ? (
          <svg width="12" height="14" viewBox="0 0 12 14">
            <rect x="1" y="1" width="3" height="12" fill="white" />
            <rect x="8" y="1" width="3" height="12" fill="white" />
          </svg>
        ) : (
          <svg width="12" height="14" viewBox="0 0 12 14">
            <polygon points="2,1 11,7 2,13" fill="white" />
          </svg>
        )}
      </button>

      {/* Trail toggle */}
      <button
        onClick={onTrailToggle}
        className={`px-2 h-8 text-xs rounded transition-colors shrink-0 ${
          trailEnabled
            ? "bg-orange-600/30 text-orange-400 border border-orange-500"
            : "bg-slate-700 text-slate-400 border border-slate-600"
        }`}
        title={trailEnabled ? "Hide trail" : "Show trail"}
      >
        Trail
      </button>

      {/* Scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(totalFrames - 1, 0)}
        value={frame}
        onChange={onFrameChange}
        className="flex-1 h-1.5 accent-orange-500 cursor-pointer"
      />
      <span className="text-xs text-slate-400 tabular-nums w-28 text-right shrink-0">
        {currentTime}s / {totalTime}s
      </span>
      <span className="text-xs text-slate-500 tabular-nums w-20 text-right shrink-0">
        F {frame}/{Math.max(totalFrames - 1, 0)}
      </span>

      {/* Keyboard hints */}
      <div className="text-xs text-slate-500 select-none hidden md:flex flex-col gap-y-0.5 ml-2 shrink-0">
        <p>
          <span className="px-1.5 py-0.5 rounded border border-slate-600 bg-slate-800 text-slate-400 text-xs">
            Space
          </span>{" "}
          pause/unpause
        </p>
        <p>
          <span className="font-mono">↑/↓</span> prev/next episode
        </p>
      </div>
    </div>
  );
}

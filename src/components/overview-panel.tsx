"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { EpisodeFrameInfo, EpisodeFramesData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";

const PAGE_SIZE = 48;

function FrameThumbnail({ info, showLast }: { info: EpisodeFrameInfo; showLast: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setInView(true); obs.disconnect(); } },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !inView) return;

    const seek = () => {
      if (showLast) {
        video.currentTime = info.lastFrameTime ?? Math.max(0, video.duration - 0.05);
      } else {
        video.currentTime = info.firstFrameTime;
      }
    };

    if (video.readyState >= 1) {
      seek();
    } else {
      video.addEventListener("loadedmetadata", seek, { once: true });
      return () => video.removeEventListener("loadedmetadata", seek);
    }
  }, [inView, showLast, info]);

  const { has, toggle } = useFlaggedEpisodes();
  const isFlagged = has(info.episodeIndex);

  return (
    <div ref={containerRef} className="flex flex-col items-center">
      <div className="w-full aspect-video bg-slate-800 rounded overflow-hidden relative group">
        {inView ? (
          <video
            ref={videoRef}
            src={info.videoUrl}
            preload="metadata"
            muted
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-slate-700" />
        )}
        <button
          onClick={() => toggle(info.episodeIndex)}
          className={`absolute top-1 right-1 p-1 rounded transition-opacity ${
            isFlagged ? "opacity-100 text-orange-400" : "opacity-0 group-hover:opacity-100 text-slate-400 hover:text-orange-400"
          }`}
          title={isFlagged ? "Unflag episode" : "Flag episode"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill={isFlagged ? "currentColor" : "none"}
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        </button>
      </div>
      <p className={`text-xs mt-1 tabular-nums ${isFlagged ? "text-orange-400" : "text-slate-400"}`}>
        ep {info.episodeIndex}{isFlagged ? " ⚑" : ""}
      </p>
    </div>
  );
}

interface OverviewPanelProps {
  data: EpisodeFramesData | null;
  loading: boolean;
  flaggedOnly?: boolean;
  onFlaggedOnlyChange?: (v: boolean) => void;
}

export default function OverviewPanel({ data, loading, flaggedOnly = false, onFlaggedOnlyChange }: OverviewPanelProps) {
  const { flagged, count: flagCount } = useFlaggedEpisodes();
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [showLast, setShowLast] = useState(false);
  const [page, setPage] = useState(0);

  // Auto-select first camera when data arrives
  useEffect(() => {
    if (data && data.cameras.length > 0 && !selectedCamera) {
      setSelectedCamera(data.cameras[0]);
    }
  }, [data, selectedCamera]);

  const handleCameraChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedCamera(e.target.value);
    setPage(0);
  }, []);

  if (loading || !data) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-12 justify-center">
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading episode frames…
      </div>
    );
  }

  const allFrames = data.framesByCamera[selectedCamera] ?? [];
  const frames = flaggedOnly ? allFrames.filter(f => flagged.has(f.episodeIndex)) : allFrames;

  if (frames.length === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <p className="text-slate-500 italic">{flaggedOnly ? "No flagged episodes to show." : "No episode frames available."}</p>
        {flaggedOnly && onFlaggedOnlyChange && (
          <button onClick={() => onFlaggedOnlyChange(false)} className="text-xs text-orange-400 hover:text-orange-300 underline">Show all episodes</button>
        )}
      </div>
    );
  }

  const totalPages = Math.ceil(frames.length / PAGE_SIZE);
  const pageFrames = frames.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="max-w-7xl mx-auto py-6 space-y-5">
      <p className="text-sm text-slate-500">
        Use first/last frame views to spot episodes with bad end states or other anomalies. Hover over a thumbnail and click the flag icon to mark episodes with wrong outcomes for review.
      </p>

      {/* Controls row */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-5">
          {/* Camera selector */}
          {data.cameras.length > 1 && (
            <select
              value={selectedCamera}
              onChange={handleCameraChange}
              className="bg-slate-800 text-slate-200 text-sm rounded px-3 py-1.5 border border-slate-600 focus:outline-none focus:border-orange-500"
            >
              {data.cameras.map((cam) => (
                <option key={cam} value={cam}>{cam}</option>
              ))}
            </select>
          )}

          {/* Flagged only toggle */}
          {flagCount > 0 && onFlaggedOnlyChange && (
            <button
              onClick={() => { onFlaggedOnlyChange(!flaggedOnly); setPage(0); }}
              className={`text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 ${
                flaggedOnly
                  ? "bg-orange-500/20 text-orange-400 border border-orange-500/40"
                  : "text-slate-400 hover:text-slate-200 border border-slate-700"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill={flaggedOnly ? "currentColor" : "none"}
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              Flagged only ({flagCount})
            </button>
          )}

          {/* First / Last toggle */}
          <div className="flex items-center gap-3">
            <span className={`text-sm ${!showLast ? "text-slate-100 font-medium" : "text-slate-500"}`}>
              First Frame
            </span>
            <button
              onClick={() => setShowLast((v) => !v)}
              className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0 ${showLast ? "bg-orange-500" : "bg-slate-600"}`}
              aria-label="Toggle first/last frame"
            >
              <span
                className={`inline-block w-3.5 h-3.5 bg-white rounded-full transition-transform ${showLast ? "translate-x-[18px]" : "translate-x-[3px]"}`}
              />
            </button>
            <span className={`text-sm ${showLast ? "text-slate-100 font-medium" : "text-slate-500"}`}>
              Last Frame
            </span>
          </div>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ← Prev
            </button>
            <span className="tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Adaptive grid — only current page's thumbnails are mounted */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
        {pageFrames.map((info) => (
          <FrameThumbnail key={`${selectedCamera}-${info.episodeIndex}`} info={info} showLast={showLast} />
        ))}
      </div>
    </div>
  );
}

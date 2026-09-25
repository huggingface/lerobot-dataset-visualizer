"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import type {
  CameraInfo,
  EpisodeFrameInfo,
  EpisodeFramesData,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import { proxyHfUrl } from "@/utils/auth";
import { InlineLoading, PageHeader, Switch } from "@/components/ui";

const PAGE_SIZE = 48;

function FrameThumbnail({
  info,
  showLast,
  aspectRatio,
}: {
  info: EpisodeFrameInfo;
  showLast: boolean;
  aspectRatio: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
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
        video.currentTime =
          info.lastFrameTime ?? Math.max(0, video.duration - 0.05);
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
      <div
        className="w-full bg-[var(--surface-1)] rounded overflow-hidden relative group"
        style={{ aspectRatio }}
      >
        {inView ? (
          <video
            ref={videoRef}
            src={proxyHfUrl(info.videoUrl)}
            preload="metadata"
            muted
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-fill" />
        )}
        <button
          onClick={() => toggle(info.episodeIndex)}
          className={`absolute top-1 right-1 p-1 rounded transition-opacity ${
            isFlagged
              ? "opacity-100 text-orange-400 hover:text-flag-fg"
              : "opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg"
          }`}
          title={isFlagged ? "Unflag episode" : "Flag episode"}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={isFlagged ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        </button>
      </div>
      <p
        className={`text-xs mt-1 tabular-nums ${isFlagged ? "text-flag-fg" : "text-fg-muted"}`}
      >
        ep {info.episodeIndex}
        {isFlagged ? " ⚑" : ""}
      </p>
    </div>
  );
}

interface OverviewPanelProps {
  data: EpisodeFramesData | null;
  cameras: CameraInfo[];
  loading: boolean;
  flaggedOnly?: boolean;
  onFlaggedOnlyChange?: (v: boolean) => void;
}

export default function OverviewPanel({
  data,
  cameras,
  loading,
  flaggedOnly = false,
  onFlaggedOnlyChange,
}: OverviewPanelProps) {
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

  const handleCameraChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedCamera(e.target.value);
      setPage(0);
    },
    [],
  );

  if (loading || !data) {
    return <InlineLoading label="Loading episode frames…" />;
  }

  const allFrames = data.framesByCamera[selectedCamera] ?? [];
  const frames = flaggedOnly
    ? allFrames.filter((f) => flagged.has(f.episodeIndex))
    : allFrames;

  if (frames.length === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <p className="text-fg-faint italic">
          {flaggedOnly
            ? "No flagged episodes to show."
            : "No episode frames available."}
        </p>
        {flaggedOnly && onFlaggedOnlyChange && (
          <button
            onClick={() => onFlaggedOnlyChange(false)}
            className="text-xs text-accent-fg hover:text-accent-fg underline"
          >
            Show all episodes
          </button>
        )}
      </div>
    );
  }

  const totalPages = Math.ceil(frames.length / PAGE_SIZE);
  /// The camera's own shape: a fixed 16:9 box with object-cover cropped 4:3 frames top and bottom.
  const camera = cameras.find((c) => c.name === selectedCamera);
  const aspectRatio =
    camera && camera.height > 0 ? camera.width / camera.height : 16 / 9;
  const pageFrames = frames.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      <PageHeader
        title="Frames"
        description="Use first/last frame views to spot episodes with bad end states or other anomalies. Hover over a thumbnail and click the flag icon to mark episodes with wrong outcomes for review."
      />

      {/* Controls row */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-5">
          {/* Camera selector */}
          {data.cameras.length > 1 && (
            <select
              value={selectedCamera}
              onChange={handleCameraChange}
              className="bg-[var(--surface-1)] text-fg text-sm rounded px-3 py-1.5 border border-line focus:outline-none focus:border-cyan-400"
            >
              {data.cameras.map((cam) => (
                <option key={cam} value={cam}>
                  {cam}
                </option>
              ))}
            </select>
          )}

          {/* Flagged only toggle */}
          {flagCount > 0 && onFlaggedOnlyChange && (
            <button
              onClick={() => {
                onFlaggedOnlyChange(!flaggedOnly);
                setPage(0);
              }}
              className={`btn ${flaggedOnly ? "btn-flagged" : ""}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill={flaggedOnly ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              Flagged only ({flagCount})
            </button>
          )}

          {/* First / Last toggle */}
          <Switch
            checked={showLast}
            onChange={setShowLast}
            offLabel="First Frame"
            onLabel="Last Frame"
            ariaLabel="Toggle first/last frame"
          />
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="btn"
            >
              ‹ Prev
            </button>
            <span className="tabular text-xs text-fg-faint">
              {page + 1} / {totalPages}
            </span>
            <button
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="btn"
            >
              Next ›
            </button>
          </div>
        )}
      </div>

      {/* Adaptive grid — only current page's thumbnails are mounted */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
      >
        {pageFrames.map((info) => (
          <FrameThumbnail
            key={`${selectedCamera}-${info.episodeIndex}`}
            info={info}
            showLast={showLast}
            aspectRatio={aspectRatio}
          />
        ))}
      </div>
    </div>
  );
}

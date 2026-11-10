"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import type {
  CameraInfo,
  EpisodeFrameInfo,
  EpisodeFramesData,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import { proxyHfUrl } from "@/utils/auth";
import { FrameCancelled, frameThumbnails } from "@/utils/frameThumbnails";
import {
  FlagButton,
  FlagIcon,
  InlineLoading,
  PageHeader,
  Segmented,
  episodeHref,
} from "@/components/ui";

type FrameMode = "first" | "last" | "both";
type TileSize = "s" | "m" | "l";

/** Narrowest a tile gets, and how many fill a page, per size. */
const TILE_SIZES: Record<TileSize, { minWidth: number; perPage: number }> = {
  s: { minWidth: 104, perPage: 96 },
  m: { minWidth: 150, perPage: 48 },
  l: { minWidth: 232, perPage: 24 },
};

const VIEW_KEY = "framesView";

function readView(): { mode: FrameMode; size: TileSize } {
  const fallback = { mode: "first" as FrameMode, size: "m" as TileSize };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "{}");
    return {
      mode: ["first", "last", "both"].includes(stored.mode)
        ? stored.mode
        : fallback.mode,
      size: stored.size in TILE_SIZES ? stored.size : fallback.size,
    };
  } catch {
    return fallback;
  }
}

/** One frame of a video file, drawn once the shared decoders have grabbed it. */
function FrameCanvas({
  url,
  time,
  endOffset,
  label,
}: {
  url: string;
  time: number | null;
  endOffset: number;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    const handle = frameThumbnails().request({ url, time, endOffset });
    handle.promise.then(
      (frame) => {
        const canvas = canvasRef.current;
        if (!live || !canvas) return;
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.getContext("2d")?.drawImage(frame, 0, 0);
        setState("ready");
      },
      (error) => {
        if (live && !(error instanceof FrameCancelled)) setState("error");
      },
    );
    return () => {
      live = false;
      handle.cancel();
    };
  }, [url, time, endOffset]);

  return (
    <div className="relative h-full min-w-0 flex-1 bg-[var(--surface-2)]">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className={`block h-full w-full object-cover transition-opacity duration-150 ${state === "ready" ? "opacity-100" : "opacity-0"}`}
      />
      {state === "loading" && (
        <div className="absolute inset-0 animate-pulse bg-fill" />
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-fg-faint">
          no preview
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function FrameTile({
  info,
  mode,
  aspectRatio,
  endOffset,
}: {
  info: EpisodeFrameInfo;
  mode: FrameMode;
  aspectRatio: number;
  endOffset: number;
}) {
  const { has } = useFlaggedEpisodes();
  const isFlagged = has(info.episodeIndex);
  const url = proxyHfUrl(info.videoUrl);
  const episode = info.episodeIndex;

  return (
    <div className="group relative min-w-0">
      {/* The frame opens its episode; the flag button sits beside the link, not inside it. */}
      <Link
        href={episodeHref(episode)}
        title={`Open episode ${episode}`}
        aria-label={`Open episode ${episode}`}
        className={`flex gap-px overflow-hidden rounded outline-offset-2 ring-1 transition-shadow focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
          isFlagged
            ? "ring-rose-500/70"
            : "ring-transparent group-hover:ring-[var(--line-strong)]"
        }`}
        style={{ aspectRatio: mode === "both" ? aspectRatio * 2 : aspectRatio }}
      >
        {mode !== "last" && (
          <FrameCanvas
            url={url}
            time={info.firstFrameTime}
            endOffset={endOffset}
            label={`First frame of episode ${episode}`}
          />
        )}
        {mode !== "first" && (
          <FrameCanvas
            url={url}
            time={info.lastFrameTime}
            endOffset={endOffset}
            label={`Last frame of episode ${episode}`}
          />
        )}
      </Link>
      <FlagButton
        id={episode}
        size={13}
        className={`absolute right-1 top-1 bg-[var(--surface-0)]/80 p-1 backdrop-blur-sm transition-opacity focus-visible:opacity-100 ${
          isFlagged ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      />
      <p
        className={`mt-1 flex items-baseline justify-between gap-2 text-xs tabular ${isFlagged ? "text-flag-fg" : "text-fg-muted"}`}
      >
        <span>ep {episode}</span>
        {info.durationSec !== undefined && (
          <span className="text-fg-faint">
            {formatDuration(info.durationSec)}
          </span>
        )}
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
  const [view, setView] = useState(readView);
  const [page, setPage] = useState(0);
  const { mode, size } = view;

  // Auto-select first camera when data arrives
  useEffect(() => {
    if (data && data.cameras.length > 0 && !selectedCamera) {
      setSelectedCamera(data.cameras[0]);
    }
  }, [data, selectedCamera]);

  useEffect(() => {
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Storage blocked: the view lasts for this visit to the tab.
    }
  }, [view]);

  // Leaving the tab stops the decoders; the frames already grabbed stay cached.
  useEffect(() => () => frameThumbnails().close(), []);

  const header = (
    <PageHeader
      title="Frames"
      description="The first and last frame of every episode, to spot bad starts, wrong end states and other anomalies at a glance. Click a frame to open its episode; flag the ones to review."
    />
  );

  if (loading || !data) {
    return (
      <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
        {header}
        <InlineLoading label="Loading episode frames…" />
      </div>
    );
  }

  const allFrames = data.framesByCamera[selectedCamera] ?? [];
  const frames = flaggedOnly
    ? allFrames.filter((f) => flagged.has(f.episodeIndex))
    : allFrames;

  const { minWidth, perPage } = TILE_SIZES[size];
  const totalPages = Math.max(1, Math.ceil(frames.length / perPage));
  // A filter or a larger tile size can leave the page past the end.
  const currentPage = Math.min(page, totalPages - 1);
  /// The camera's own shape: a fixed 16:9 box with object-cover cropped 4:3 frames top and bottom.
  const camera = cameras.find((c) => c.name === selectedCamera);
  const aspectRatio =
    camera && camera.height > 0 ? camera.width / camera.height : 16 / 9;
  const pageFrames = frames.slice(
    currentPage * perPage,
    (currentPage + 1) * perPage,
  );
  const sampled = allFrames.length < data.totalEpisodes;

  return (
    <div className="w-full max-w-5xl mx-auto py-6 space-y-6">
      {header}

      {/* Controls row */}
      <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-3">
        <div className="flex items-center flex-wrap gap-x-4 gap-y-3">
          {/* Camera selector */}
          {data.cameras.length > 1 && (
            <select
              value={selectedCamera}
              onChange={(e) => {
                setSelectedCamera(e.target.value);
                setPage(0);
              }}
              aria-label="Camera"
              className="bg-[var(--surface-1)] text-fg text-sm rounded px-3 py-1.5 border border-line focus:outline-none focus:border-accent"
            >
              {data.cameras.map((cam) => (
                <option key={cam} value={cam}>
                  {cam}
                </option>
              ))}
            </select>
          )}

          <Segmented
            ariaLabel="Which frame of each episode"
            value={mode}
            onChange={(next) => setView((v) => ({ ...v, mode: next }))}
            options={[
              { value: "first", label: "First frame" },
              { value: "last", label: "Last frame" },
              {
                value: "both",
                label: "Both",
                title: "First and last frame side by side",
              },
            ]}
          />

          <Segmented
            ariaLabel="Thumbnail size"
            value={size}
            onChange={(next) => {
              setView((v) => ({ ...v, size: next }));
              setPage(0);
            }}
            options={[
              { value: "s", label: "S", title: "Small thumbnails" },
              { value: "m", label: "M", title: "Medium thumbnails" },
              { value: "l", label: "L", title: "Large thumbnails" },
            ]}
          />

          {/* Flagged only toggle */}
          {flagCount > 0 && onFlaggedOnlyChange && (
            <button
              onClick={() => {
                onFlaggedOnlyChange(!flaggedOnly);
                setPage(0);
              }}
              aria-pressed={flaggedOnly}
              className={`btn ${flaggedOnly ? "btn-flagged" : ""}`}
            >
              <FlagIcon filled={flaggedOnly} />
              Flagged only ({flagCount})
            </button>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="btn"
            >
              ‹ Prev
            </button>
            <span className="tabular text-xs text-fg-faint">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              disabled={currentPage === totalPages - 1}
              onClick={() => setPage(currentPage + 1)}
              className="btn"
            >
              Next ›
            </button>
          </div>
        )}
      </div>

      {frames.length === 0 ? (
        <div className="text-center py-8 space-y-2">
          <p className="text-fg-faint italic">
            {flaggedOnly
              ? "No flagged episodes to show."
              : data.cameras.length === 0
                ? "This dataset has no camera streams."
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
      ) : (
        <>
          <p className="text-xs text-fg-faint tabular">
            Episodes {pageFrames[0].episodeIndex}–
            {pageFrames[pageFrames.length - 1].episodeIndex} ·{" "}
            {frames.length.toLocaleString()} {flaggedOnly ? "flagged" : "shown"}
            {sampled &&
              !flaggedOnly &&
              ` of ${data.totalEpisodes.toLocaleString()}, evenly sampled`}
          </p>

          {/* Only the current page's tiles are mounted. */}
          <div
            className="grid gap-x-3 gap-y-4"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${mode === "both" ? minWidth * 2 : minWidth}px, 1fr))`,
            }}
          >
            {pageFrames.map((info) => (
              <FrameTile
                key={`${selectedCamera}-${info.episodeIndex}`}
                info={info}
                mode={mode}
                aspectRatio={aspectRatio}
                endOffset={data.halfFrameSec}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

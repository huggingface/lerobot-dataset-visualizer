"use client";

import React, { useEffect, useRef, useCallback } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";
import type { VideoInfo } from "@/types";

const THRESHOLDS = {
  // Loose during playback — prevents the Chrome feedback loop where seeking
  // triggers onTimeUpdate → setCurrentTime → re-seek → loop.
  VIDEO_SYNC_PLAYING: 1.0,
  // Tight when paused so manual frame-stepping is frame-accurate.
  VIDEO_SYNC_PAUSED: 0.05,
  VIDEO_SEGMENT_BOUNDARY: 0.05,
};

const VIDEO_READY_TIMEOUT_MS = 10_000;

type VideoPlayerProps = {
  videosInfo: VideoInfo[];
  onVideosReady?: () => void;
};

export const SimpleVideosPlayer = ({
  videosInfo,
  onVideosReady,
}: VideoPlayerProps) => {
  const { setCurrentTime, subscribe, isPlaying, setIsPlaying } = useTime();
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [hiddenVideos, setHiddenVideos] = React.useState<string[]>([]);
  const [enlargedVideo, setEnlargedVideo] = React.useState<string | null>(null);
  const [showHiddenMenu, setShowHiddenMenu] = React.useState(false);
  const [videosReady, setVideosReady] = React.useState(false);

  const hiddenSet = React.useMemo(() => new Set(hiddenVideos), [hiddenVideos]);

  const firstVisibleIdx = videosInfo.findIndex(
    (video) => !hiddenSet.has(video.filename),
  );

  // Keep a ref so the sync callback always sees the current play state
  // without needing to re-subscribe whenever isPlaying changes.
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // Initialize video refs array
  useEffect(() => {
    videoRefs.current = videoRefs.current.slice(0, videosInfo.length);
  }, [videosInfo.length]);

  // Handle videos ready — with a timeout fallback so the UI never hangs
  // if a video fails to reach canplaythrough (e.g. network stall).
  useEffect(() => {
    let readyCount = 0;
    let resolved = false;

    const markReady = () => {
      if (resolved) return;
      resolved = true;
      setVideosReady(true);
      onVideosReady?.();
      setIsPlaying(true);
    };

    const checkReady = () => {
      readyCount++;
      if (readyCount >= videosInfo.length) markReady();
    };

    const timeout = setTimeout(markReady, VIDEO_READY_TIMEOUT_MS);

    // Capture cleanups in the closure so each effect run removes exactly the
    // listeners it added — safe across React Strict Mode double-invocation
    // (where the module-level WeakMap approach could lose the first cleanup).
    const cleanups: (() => void)[] = [];

    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      const info = videosInfo[index];

      if (info.isSegmented) {
        const segmentStart = info.segmentStart || 0;

        const handleTimeUpdate = () => {
          const segmentEnd = info.segmentEnd || video.duration;
          if (video.currentTime >= segmentEnd - THRESHOLDS.VIDEO_SEGMENT_BOUNDARY) {
            video.currentTime = segmentStart;
            if (index === firstVisibleIdx) setCurrentTime(0);
          }
        };

        const handleLoadedData = () => {
          video.currentTime = segmentStart;
          checkReady();
        };

        video.addEventListener("timeupdate", handleTimeUpdate);
        cleanups.push(() => video.removeEventListener("timeupdate", handleTimeUpdate));

        // If the video already has frame data (e.g. navigating back to the same
        // episode URL — browser doesn't reload the file so loadeddata never fires
        // again; or React Strict Mode re-runs after a fast camera already loaded),
        // call the handler immediately instead of waiting for the event.
        if (video.readyState >= 2) {
          handleLoadedData();
        } else {
          video.addEventListener("loadeddata", handleLoadedData);
          cleanups.push(() => video.removeEventListener("loadeddata", handleLoadedData));
        }
      } else {
        const handleEnded = () => {
          video.currentTime = 0;
          if (index === firstVisibleIdx) setCurrentTime(0);
        };

        video.addEventListener("ended", handleEnded);
        cleanups.push(() => video.removeEventListener("ended", handleEnded));

        if (video.readyState >= 3) {
          checkReady();
        } else {
          video.addEventListener("canplaythrough", checkReady, { once: true });
          cleanups.push(() => video.removeEventListener("canplaythrough", checkReady));
        }
      }
    });

    return () => {
      clearTimeout(timeout);
      cleanups.forEach((fn) => fn());
    };
  }, [
    videosInfo,
    onVideosReady,
    setIsPlaying,
    firstVisibleIdx,
    setCurrentTime,
  ]);

  // Handle play/pause — skip hidden videos
  useEffect(() => {
    if (!videosReady) return;

    videoRefs.current.forEach((video, idx) => {
      if (!video || hiddenSet.has(videosInfo[idx].filename)) return;
      if (isPlaying) {
        video.play().catch((e) => {
          if (e.name !== "AbortError") {
            console.error("Error playing video");
          }
        });
      } else {
        video.pause();
      }
    });
  }, [isPlaying, videosReady, hiddenSet, videosInfo]);

  // Sync video times via subscribe rather than a currentTime useEffect.
  // subscribe fires synchronously on every setCurrentTime call without going
  // through React's render cycle, which eliminates two problems:
  //   1. Chrome feedback loop: onTimeUpdate → setCurrentTime → React re-render
  //      → sync effect → video.currentTime = t → onTimeUpdate → ... (loop)
  //   2. ~1 frame of lag introduced by React scheduling the effect.
  // Adaptive threshold: loose (1 s) during playback so normal drift doesn't
  // trigger unnecessary seeks; tight (0.05 s) when paused for frame accuracy.
  useEffect(() => {
    if (!videosReady) return;

    return subscribe((t) => {
      videoRefs.current.forEach((video, index) => {
        if (!video || hiddenSet.has(videosInfo[index].filename)) return;

        const info = videosInfo[index];
        const targetTime = info.isSegmented ? (info.segmentStart || 0) + t : t;
        const threshold = isPlayingRef.current
          ? THRESHOLDS.VIDEO_SYNC_PLAYING
          : THRESHOLDS.VIDEO_SYNC_PAUSED;

        if (Math.abs(video.currentTime - targetTime) > threshold) {
          video.currentTime = targetTime;
        }
      });
    });
  }, [subscribe, videosInfo, videosReady, hiddenSet]);

  // Stable per-index timeupdate handlers avoid findIndex scan on every event
  const makeTimeUpdateHandler = useCallback(
    (index: number) => {
      return () => {
        const video = videoRefs.current[index];
        const info = videosInfo[index];
        if (!video || !info) return;

        const globalTime = info.isSegmented
          ? video.currentTime - (info.segmentStart || 0)
          : video.currentTime;
        setCurrentTime(globalTime);
      };
    },
    [videosInfo, setCurrentTime],
  );

  // Handle play click for segmented videos
  const handlePlay = (video: HTMLVideoElement, info: VideoInfo) => {
    if (info.isSegmented) {
      const segmentStart = info.segmentStart || 0;
      const segmentEnd = info.segmentEnd || video.duration;

      if (video.currentTime < segmentStart || video.currentTime >= segmentEnd) {
        video.currentTime = segmentStart;
      }
    }
    video.play();
  };

  return (
    <>
      {/* Hidden videos menu */}
      {hiddenVideos.length > 0 && (
        <div className="relative mb-4">
          <button
            className="flex items-center gap-2 rounded bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 border border-slate-500"
            onClick={() => setShowHiddenMenu(!showHiddenMenu)}
          >
            <FaEye /> Show Hidden Videos ({hiddenVideos.length})
          </button>
          {showHiddenMenu && (
            <div className="absolute left-0 mt-2 w-max rounded border border-slate-500 bg-slate-900 shadow-lg p-2 z-50">
              <div className="mb-2 text-xs text-slate-300">
                Restore hidden videos:
              </div>
              {hiddenVideos.map((filename) => (
                <button
                  key={filename}
                  className="block w-full text-left px-2 py-1 rounded hover:bg-slate-700 text-slate-100"
                  onClick={() =>
                    setHiddenVideos((prev) =>
                      prev.filter((v) => v !== filename),
                    )
                  }
                >
                  {filename}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Videos */}
      <div className="flex flex-wrap gap-x-2 gap-y-6">
        {videosInfo.map((info, idx) => {
          if (hiddenVideos.includes(info.filename)) return null;

          const isEnlarged = enlargedVideo === info.filename;
          const isFirstVisible = idx === firstVisibleIdx;

          return (
            <div
              key={info.filename}
              className={`${
                isEnlarged
                  ? "z-40 fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center"
                  : "max-w-96"
              }`}
            >
              <p className="truncate w-full rounded-t-xl bg-gray-800 px-2 text-sm text-gray-300 flex items-center justify-between">
                <span>{info.filename}</span>
                <span className="flex gap-1">
                  <button
                    title={isEnlarged ? "Minimize" : "Enlarge"}
                    className="ml-2 p-1 hover:bg-slate-700 rounded"
                    onClick={() =>
                      setEnlargedVideo(isEnlarged ? null : info.filename)
                    }
                  >
                    {isEnlarged ? <FaCompress /> : <FaExpand />}
                  </button>
                  <button
                    title="Hide Video"
                    className="ml-1 p-1 hover:bg-slate-700 rounded"
                    onClick={() =>
                      setHiddenVideos((prev) => [...prev, info.filename])
                    }
                    disabled={
                      videosInfo.filter(
                        (v) => !hiddenVideos.includes(v.filename),
                      ).length === 1
                    }
                  >
                    <FaTimes />
                  </button>
                </span>
              </p>
              <video
                ref={(el: HTMLVideoElement | null) => {
                  videoRefs.current[idx] = el;
                }}
                className={`w-full object-contain ${
                  isEnlarged ? "max-h-[90vh] max-w-[90vw]" : ""
                }`}
                muted
                preload="auto"
                crossOrigin="anonymous"
                onPlay={(e) => handlePlay(e.currentTarget, info)}
                onTimeUpdate={
                  isFirstVisible ? makeTimeUpdateHandler(idx) : undefined
                }
              >
                <source src={info.url} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          );
        })}
      </div>
    </>
  );
};

export default SimpleVideosPlayer;

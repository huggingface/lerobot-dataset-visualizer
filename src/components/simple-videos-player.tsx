"use client";

import React, { useEffect, useRef, useCallback } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";
import type { VideoInfo } from "@/types";
import { proxyHfUrl } from "@/utils/auth";

const THRESHOLDS = {
  VIDEO_SYNC_TOLERANCE: 0.2,
  VIDEO_SEGMENT_BOUNDARY: 0.05,
};

const VIDEO_READY_TIMEOUT_MS = 10_000;

type VideoPlayerProps = {
  videosInfo: VideoInfo[];
  onVideosReady?: () => void;
};

const videoEventCleanup = new WeakMap<HTMLVideoElement, () => void>();

export const SimpleVideosPlayer = ({
  videosInfo,
  onVideosReady,
}: VideoPlayerProps) => {
  const {
    currentTime,
    setCurrentTime,
    externalSeekVersion,
    isPlaying,
    setIsPlaying,
  } = useTime();
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [hiddenVideos, setHiddenVideos] = React.useState<string[]>([]);
  const [enlargedVideo, setEnlargedVideo] = React.useState<string | null>(null);
  const [showHiddenMenu, setShowHiddenMenu] = React.useState(false);
  const [videosReady, setVideosReady] = React.useState(false);

  const hiddenSet = React.useMemo(() => new Set(hiddenVideos), [hiddenVideos]);

  const firstVisibleIdx = videosInfo.findIndex(
    (video) => !hiddenSet.has(video.filename),
  );

  // Last externalSeekVersion we observed in the sync effect. When the
  // context's version moves past this, an external seek happened and we
  // need to drive every video to the new position.
  const lastSeekVersionRef = useRef(externalSeekVersion);

  // Mirror firstVisibleIdx into a ref so the videos-ready effect doesn't have
  // to depend on it. If it did, hiding the first camera would tear the whole
  // effect down and back up, re-attaching `canplaythrough` listeners that
  // never re-fire (the videos are already loaded), leaving readyCount stuck
  // at 0 until the 10s timeout — at which point markReady forces play even
  // if the user paused.
  const firstVisibleIdxRef = useRef(firstVisibleIdx);
  useEffect(() => {
    firstVisibleIdxRef.current = firstVisibleIdx;
  }, [firstVisibleIdx]);

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

    videoRefs.current.forEach((video, index) => {
      if (video) {
        const info = videosInfo[index];

        if (info.isSegmented) {
          const handleTimeUpdate = () => {
            const segmentEnd = info.segmentEnd || video.duration;
            const segmentStart = info.segmentStart || 0;

            if (
              video.currentTime >=
              segmentEnd - THRESHOLDS.VIDEO_SEGMENT_BOUNDARY
            ) {
              video.currentTime = segmentStart;
              if (index === firstVisibleIdxRef.current) {
                setCurrentTime(0);
              }
            }
          };

          const handleLoadedData = () => {
            video.currentTime = info.segmentStart || 0;
            checkReady();
          };

          video.addEventListener("timeupdate", handleTimeUpdate);
          video.addEventListener("loadeddata", handleLoadedData);

          videoEventCleanup.set(video, () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("loadeddata", handleLoadedData);
          });
        } else {
          const handleEnded = () => {
            video.currentTime = 0;
            if (index === firstVisibleIdxRef.current) {
              setCurrentTime(0);
            }
          };

          video.addEventListener("ended", handleEnded);
          video.addEventListener("canplaythrough", checkReady, { once: true });

          videoEventCleanup.set(video, () => {
            video.removeEventListener("ended", handleEnded);
          });
        }
      }
    });

    return () => {
      clearTimeout(timeout);
      videoRefs.current.forEach((video) => {
        if (!video) return;
        const cleanup = videoEventCleanup.get(video);
        if (cleanup) {
          cleanup();
          videoEventCleanup.delete(video);
        }
      });
    };
    // firstVisibleIdx intentionally omitted — we read it via ref so hiding
    // the first camera doesn't reset readiness (see the comment near
    // firstVisibleIdxRef above).
  }, [videosInfo, onVideosReady, setIsPlaying, setCurrentTime]);

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

  // Drive every video to currentTime on external seeks (slider drag, chart
  // click, loop reset). The version-based check replaces a 0.3s heuristic
  // that misfired when a network stall produced a >0.3s timeupdate jump
  // and incorrectly classified it as a user seek — causing every camera to
  // re-seek, which itself stalled them in a feedback spiral.
  useEffect(() => {
    if (!videosReady) return;
    if (externalSeekVersion === lastSeekVersionRef.current) return;
    lastSeekVersionRef.current = externalSeekVersion;

    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      if (hiddenSet.has(videosInfo[index].filename)) return;

      const info = videosInfo[index];
      let targetTime = currentTime;
      if (info.isSegmented) {
        targetTime = (info.segmentStart || 0) + currentTime;
      }

      if (
        Math.abs(video.currentTime - targetTime) >
        THRESHOLDS.VIDEO_SYNC_TOLERANCE
      ) {
        video.currentTime = targetTime;
      }
    });
  }, [externalSeekVersion, currentTime, videosInfo, videosReady, hiddenSet]);

  // Stable per-index timeupdate handlers avoid findIndex scan on every event.
  // Tagged "video" so the context doesn't bump externalSeekVersion — the
  // sync effect treats this as a status report, not a seek command.
  const makeTimeUpdateHandler = useCallback(
    (index: number) => {
      return () => {
        const video = videoRefs.current[index];
        const info = videosInfo[index];
        if (!video || !info) return;

        let globalTime = video.currentTime;
        if (info.isSegmented) {
          globalTime = video.currentTime - (info.segmentStart || 0);
        }
        setCurrentTime(globalTime, "video");
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
    video.play().catch((e: unknown) => {
      if ((e as Error)?.name !== "AbortError") {
        console.error("Error playing video", e);
      }
    });
  };

  return (
    <>
      {/* Hidden videos menu */}
      {hiddenVideos.length > 0 && (
        <div className="relative mb-4">
          <button
            className="inline-flex items-center gap-2 h-8 rounded-md panel px-3 text-xs text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors"
            onClick={() => setShowHiddenMenu(!showHiddenMenu)}
          >
            <FaEye size={11} /> Show hidden · {hiddenVideos.length}
          </button>
          {showHiddenMenu && (
            <div className="absolute left-0 mt-1.5 w-max panel-raised bg-[var(--surface-1)] shadow-xl p-1.5 z-50">
              <div className="mb-1 px-2 text-[10px] uppercase tracking-wide text-slate-500">
                Restore hidden videos
              </div>
              {hiddenVideos.map((filename) => (
                <button
                  key={filename}
                  className="block w-full text-left px-2 py-1 rounded-md text-xs text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors"
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
              <p className="truncate w-full rounded-t-md bg-[var(--surface-1)] border border-b-0 border-white/5 px-2.5 py-1 text-[11px] text-slate-400 flex items-center justify-between gap-2">
                <span className="truncate">{info.filename}</span>
                <span className="flex gap-0.5 shrink-0">
                  <button
                    title={isEnlarged ? "Minimize" : "Enlarge"}
                    className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
                    onClick={() =>
                      setEnlargedVideo(isEnlarged ? null : info.filename)
                    }
                  >
                    {isEnlarged ? (
                      <FaCompress size={10} />
                    ) : (
                      <FaExpand size={10} />
                    )}
                  </button>
                  <button
                    title="Hide Video"
                    className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                    onClick={() =>
                      setHiddenVideos((prev) => [...prev, info.filename])
                    }
                    disabled={
                      videosInfo.filter(
                        (v) => !hiddenVideos.includes(v.filename),
                      ).length === 1
                    }
                  >
                    <FaTimes size={10} />
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
                <source src={proxyHfUrl(info.url)} type="video/mp4" />
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

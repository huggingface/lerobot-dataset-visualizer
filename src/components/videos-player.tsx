"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";
import type { VideoInfo } from "@/types";

type VideoPlayerProps = {
  videosInfo: VideoInfo[];
  onVideosReady?: () => void;
};

const videoCleanupHandlers = new WeakMap<HTMLVideoElement, () => void>();
const videoReadyHandlers = new WeakMap<HTMLVideoElement, EventListener>();

const VIDEO_SYNC_TOLERANCE = 0.2;

export const VideosPlayer = ({
  videosInfo,
  onVideosReady,
}: VideoPlayerProps) => {
  const { currentTime, setCurrentTime, isPlaying, setIsPlaying } = useTime();
  const videoRefs = useRef<HTMLVideoElement[]>([]);
  const [hiddenVideos, setHiddenVideos] = useState<string[]>([]);

  const hiddenSet = useMemo(() => new Set(hiddenVideos), [hiddenVideos]);

  const firstVisibleIdx = videosInfo.findIndex(
    (video) => !hiddenSet.has(video.filename),
  );
  const visibleCount = videosInfo.filter(
    (video) => !hiddenSet.has(video.filename),
  ).length;
  const [enlargedVideo, setEnlargedVideo] = useState<string | null>(null);
  const prevHiddenVideosRef = useRef<string[]>([]);
  const videoContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [showHiddenMenu, setShowHiddenMenu] = useState(false);
  const hiddenMenuRef = useRef<HTMLDivElement | null>(null);
  const showHiddenBtnRef = useRef<HTMLButtonElement | null>(null);
  const [videoCodecError, setVideoCodecError] = useState(false);

  // Tracks the last time value set by the primary video's onTimeUpdate.
  // If currentTime differs from this, an external source (slider/chart click) changed it.
  const lastVideoTimeRef = useRef(0);

  // Initialize video refs
  useEffect(() => {
    videoRefs.current = videoRefs.current.slice(0, videosInfo.length);
  }, [videosInfo]);

  // When videos get unhidden, sync their time and resume playback
  useEffect(() => {
    const prevHidden = prevHiddenVideosRef.current;
    const newlyUnhidden = prevHidden.filter(
      (filename) => !hiddenSet.has(filename),
    );
    if (newlyUnhidden.length > 0) {
      const unhiddenNames = new Set(newlyUnhidden);
      videosInfo.forEach((video, idx) => {
        if (unhiddenNames.has(video.filename)) {
          const ref = videoRefs.current[idx];
          if (ref) {
            ref.currentTime = currentTime;
            if (isPlaying) {
              ref.play().catch(() => {});
            }
          }
        }
      });
    }
    prevHiddenVideosRef.current = hiddenVideos;
  }, [hiddenVideos, hiddenSet, isPlaying, videosInfo, currentTime]);

  // Check video codec support
  useEffect(() => {
    const checkCodecSupport = () => {
      const dummyVideo = document.createElement("video");
      const canPlayVideos = dummyVideo.canPlayType(
        'video/mp4; codecs="av01.0.05M.08"',
      );
      setVideoCodecError(!canPlayVideos);
    };

    checkCodecSupport();
  }, []);

  // Handle play/pause — skip hidden videos to avoid wasting decoder time
  useEffect(() => {
    videoRefs.current.forEach((video, idx) => {
      if (!video || hiddenSet.has(videosInfo[idx]?.filename)) return;
      if (isPlaying) {
        video.play().catch(() => console.error("Error playing video"));
      } else {
        video.pause();
      }
    });
  }, [isPlaying, hiddenSet, videosInfo]);

  // Minimize enlarged video on Escape key
  useEffect(() => {
    if (!enlargedVideo) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEnlargedVideo(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    // Scroll enlarged video into view
    const ref = videoContainerRefs.current[enlargedVideo];
    if (ref) {
      ref.scrollIntoView();
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enlargedVideo]);

  // Close hidden videos dropdown on outside click
  useEffect(() => {
    if (!showHiddenMenu) return;
    function handleClick(e: MouseEvent) {
      const menu = hiddenMenuRef.current;
      const btn = showHiddenBtnRef.current;
      if (
        menu &&
        !menu.contains(e.target as Node) &&
        btn &&
        !btn.contains(e.target as Node)
      ) {
        setShowHiddenMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showHiddenMenu]);

  // Close dropdown if no hidden videos
  useEffect(() => {
    if (hiddenVideos.length === 0 && showHiddenMenu) {
      setShowHiddenMenu(false);
    }
    // Minimize if enlarged video is hidden
    if (enlargedVideo && hiddenVideos.includes(enlargedVideo)) {
      setEnlargedVideo(null);
    }
  }, [hiddenVideos, showHiddenMenu, enlargedVideo]);

  // Sync all video times when currentTime changes.
  // For the primary video, only seek when the change came from an external source
  // (slider drag, chart click, etc.) — detected by comparing against lastVideoTimeRef.
  useEffect(() => {
    const isExternalSeek =
      Math.abs(currentTime - lastVideoTimeRef.current) > 0.3;

    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      if (hiddenSet.has(videosInfo[index]?.filename)) return;
      if (index === firstVisibleIdx && !isExternalSeek) return;

      const videoInfo = videosInfo[index];
      if (videoInfo?.isSegmented) {
        const segmentStart = videoInfo.segmentStart || 0;
        const segmentTime = segmentStart + currentTime;
        if (Math.abs(video.currentTime - segmentTime) > VIDEO_SYNC_TOLERANCE) {
          video.currentTime = segmentTime;
        }
      } else {
        if (Math.abs(video.currentTime - currentTime) > VIDEO_SYNC_TOLERANCE) {
          video.currentTime = currentTime;
        }
      }
    });
  }, [currentTime, videosInfo, firstVisibleIdx, hiddenSet]);

  // Stable per-index timeupdate handlers avoid findIndex scan on every event
  const makeTimeUpdateHandler = useCallback(
    (index: number) => {
      return () => {
        const video = videoRefs.current[index];
        if (!video || !video.duration) return;
        const videoInfo = videosInfo[index];

        if (videoInfo?.isSegmented) {
          const segmentStart = videoInfo.segmentStart || 0;
          const globalTime = Math.max(0, video.currentTime - segmentStart);
          lastVideoTimeRef.current = globalTime;
          setCurrentTime(globalTime);
        } else {
          lastVideoTimeRef.current = video.currentTime;
          setCurrentTime(video.currentTime);
        }
      };
    },
    [videosInfo, setCurrentTime],
  );

  // Handle video ready and setup segmentation
  useEffect(() => {
    let videosReadyCount = 0;
    const onCanPlayThrough = (videoIndex: number) => {
      const video = videoRefs.current[videoIndex];
      const videoInfo = videosInfo[videoIndex];

      // Setup video segmentation for v3.0 chunked videos
      if (video && videoInfo?.isSegmented) {
        const segmentStart = videoInfo.segmentStart || 0;
        const segmentEnd = videoInfo.segmentEnd || video.duration || 0;

        // Set initial time to segment start if not already set
        if (
          video.currentTime < segmentStart ||
          video.currentTime > segmentEnd
        ) {
          video.currentTime = segmentStart;
        }

        // Add event listener to handle segment boundaries
        const handleTimeUpdate = () => {
          if (video.currentTime > segmentEnd) {
            video.currentTime = segmentStart;
            if (!video.loop) {
              video.pause();
            }
          }
        };

        video.addEventListener("timeupdate", handleTimeUpdate);

        videoCleanupHandlers.set(video, () => {
          video.removeEventListener("timeupdate", handleTimeUpdate);
        });
      }

      videosReadyCount += 1;
      if (videosReadyCount === videosInfo.length) {
        if (typeof onVideosReady === "function") {
          onVideosReady();
          setIsPlaying(true);
        }
      }
    };

    videoRefs.current.forEach((video, index) => {
      if (video) {
        // If already ready, call the handler immediately
        if (video.readyState >= 4) {
          onCanPlayThrough(index);
        } else {
          const readyHandler = () => onCanPlayThrough(index);
          video.addEventListener("canplaythrough", readyHandler);
          videoReadyHandlers.set(video, readyHandler);
        }
      }
    });

    return () => {
      videoRefs.current.forEach((video) => {
        if (!video) return;
        const readyHandler = videoReadyHandlers.get(video);
        if (readyHandler) {
          video.removeEventListener("canplaythrough", readyHandler);
          videoReadyHandlers.delete(video);
        }
        const cleanup = videoCleanupHandlers.get(video);
        if (cleanup) {
          cleanup();
          videoCleanupHandlers.delete(video);
        }
      });
    };
  }, [videosInfo, onVideosReady, setIsPlaying]);

  return (
    <>
      {/* Error message */}
      {videoCodecError && (
        <div className="font-medium text-orange-700">
          <p>
            Videos could NOT play because{" "}
            <a
              href="https://en.wikipedia.org/wiki/AV1"
              target="_blank"
              className="underline"
            >
              AV1
            </a>{" "}
            decoding is not available on your browser.
          </p>
          <ul className="list-inside list-decimal">
            <li>
              If iPhone:{" "}
              <span className="italic">
                It is supported with A17 chip or higher.
              </span>
            </li>
            <li>
              If Mac with Safari:{" "}
              <span className="italic">
                It is supported on most browsers except Safari with M1 chip or
                higher and on Safari with M3 chip or higher.
              </span>
            </li>
            <li>
              Other:{" "}
              <span className="italic">
                Contact the maintainers on LeRobot discord channel:
              </span>
              <a
                href="https://discord.com/invite/s3KuuzsPFb"
                target="_blank"
                className="underline"
              >
                https://discord.com/invite/s3KuuzsPFb
              </a>
            </li>
          </ul>
        </div>
      )}

      {/* Show Hidden Videos Button */}
      {hiddenVideos.length > 0 && (
        <div className="relative">
          <button
            ref={showHiddenBtnRef}
            className="flex items-center gap-2 rounded bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 border border-slate-500"
            onClick={() => setShowHiddenMenu((prev) => !prev)}
          >
            <FaEye /> Show Hidden Videos ({hiddenVideos.length})
          </button>
          {showHiddenMenu && (
            <div
              ref={hiddenMenuRef}
              className="absolute left-0 mt-2 w-max rounded border border-slate-500 bg-slate-900 shadow-lg p-2 z-50"
            >
              <div className="mb-2 text-xs text-slate-300">
                Restore hidden videos:
              </div>
              {hiddenVideos.map((filename) => (
                <button
                  key={filename}
                  className="block w-full text-left px-2 py-1 rounded hover:bg-slate-700 text-slate-100"
                  onClick={() =>
                    setHiddenVideos((prev: string[]) =>
                      prev.filter((v: string) => v !== filename),
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
        {videosInfo.map((video, idx) => {
          if (hiddenVideos.includes(video.filename) || videoCodecError)
            return null;
          const isEnlarged = enlargedVideo === video.filename;
          return (
            <div
              key={video.filename}
              ref={(el) => {
                videoContainerRefs.current[video.filename] = el;
              }}
              className={`${isEnlarged ? "z-40 fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center" : "max-w-96"}`}
              style={isEnlarged ? { height: "100vh", width: "100vw" } : {}}
            >
              <p className="truncate w-full rounded-t-xl bg-gray-800 px-2 text-sm text-gray-300 flex items-center justify-between">
                <span>{video.filename}</span>
                <span className="flex gap-1">
                  <button
                    title={isEnlarged ? "Minimize" : "Enlarge"}
                    className="ml-2 p-1 hover:bg-slate-700 rounded focus:outline-none focus:ring-0"
                    onClick={() =>
                      setEnlargedVideo(isEnlarged ? null : video.filename)
                    }
                  >
                    {isEnlarged ? <FaCompress /> : <FaExpand />}
                  </button>
                  <button
                    title="Hide Video"
                    className="ml-1 p-1 hover:bg-slate-700 rounded focus:outline-none focus:ring-0"
                    onClick={() =>
                      setHiddenVideos((prev: string[]) => [
                        ...prev,
                        video.filename,
                      ])
                    }
                    disabled={visibleCount === 1}
                  >
                    <FaTimes />
                  </button>
                </span>
              </p>
              <video
                ref={(el) => {
                  if (el) videoRefs.current[idx] = el;
                }}
                muted
                loop
                preload="auto"
                crossOrigin="anonymous"
                className={`w-full object-contain ${isEnlarged ? "max-h-[90vh] max-w-[90vw]" : ""}`}
                onTimeUpdate={
                  idx === firstVisibleIdx
                    ? makeTimeUpdateHandler(idx)
                    : undefined
                }
                style={isEnlarged ? { zIndex: 41 } : {}}
              >
                <source src={video.url} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          );
        })}
      </div>
    </>
  );
};

export default VideosPlayer;

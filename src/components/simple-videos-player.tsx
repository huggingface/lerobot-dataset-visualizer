"use client";

import React, { useEffect, useRef } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";
import type { VideoInfo } from "@/types";
import { proxyHfUrl } from "@/utils/auth";
import { getTranscodeUrl, isLikelyDepthCamera } from "@/utils/videoClient";
import { VideoOverlayCanvas } from "./video-overlay-canvas";

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
  const { currentTime, seek, externalSeekVersion, isPlaying, setIsPlaying } =
    useTime();
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  // Mirror videoRefs into state so the absolutely-positioned VQA overlay can
  // re-render with the actual <video> element once it mounts. Using a ref
  // alone means the overlay's first render still sees `null`.
  const [videoEls, setVideoEls] = React.useState<(HTMLVideoElement | null)[]>(
    () => [],
  );
  // Stable ref callbacks per index. If we used inline `(el) => { ... }` here
  // React would re-invoke the callback on every render (the function identity
  // changes), which combined with `setVideoEls` would toggle state on each
  // tick and produce a "Maximum update depth exceeded" loop.
  const videoRefCallbacksRef = useRef<
    ((el: HTMLVideoElement | null) => void)[]
  >([]);
  while (videoRefCallbacksRef.current.length < videosInfo.length) {
    const idx = videoRefCallbacksRef.current.length;
    videoRefCallbacksRef.current.push((el: HTMLVideoElement | null) => {
      videoRefs.current[idx] = el;
      setVideoEls((prev) => {
        if (prev[idx] === el) return prev;
        const next = prev.slice();
        next[idx] = el;
        return next;
      });
    });
  }
  const [hiddenVideos, setHiddenVideos] = React.useState<string[]>([]);
  const [enlargedVideo, setEnlargedVideo] = React.useState<string | null>(null);
  const [showHiddenMenu, setShowHiddenMenu] = React.useState(false);
  const [videosReady, setVideosReady] = React.useState(false);
  // Filenames whose native decode failed (e.g. depth cameras stored as
  // gray12le). For these we swap the <video> src to the backend transcode
  // endpoint, which serves a browser-friendly H.264 copy. Empty unless a
  // decode error actually fires AND a transcode backend is configured.
  const [transcodeFallbacks, setTranscodeFallbacks] = React.useState<
    Set<string>
  >(() => new Set());
  // Tracks which fallbacks we've already pushed to the element via load(), so
  // the apply-effect doesn't repeatedly reload the same video.
  const appliedFallbackRef = useRef<Set<string>>(new Set());

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

  // Mirror onVideosReady into a ref for the same reason. Parents typically
  // pass an inline arrow (`onVideosReady={() => setVideosReady(true)}`) which
  // gets a new identity every render. Including it in the videos-ready
  // effect's deps caused that effect to tear down + setup on every parent
  // render. The setup branch then ran `queueMicrotask(handleLoadedData)` for
  // every already-loaded video (true after the first load), seeking each
  // back to segmentStart — videos got pinned on their first frame and never
  // advanced.
  const onVideosReadyRef = useRef(onVideosReady);
  useEffect(() => {
    onVideosReadyRef.current = onVideosReady;
  }, [onVideosReady]);

  // Mirror isPlaying so the transcode-apply effect can re-assert play() after
  // load() without depending on isPlaying (which would churn the effect).
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

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
      onVideosReadyRef.current?.();
      setIsPlaying(true);
    };

    const checkReady = () => {
      readyCount++;
      if (readyCount >= videosInfo.length) markReady();
    };

    const timeout = setTimeout(markReady, VIDEO_READY_TIMEOUT_MS);

    // Coordinated loop reset — when the primary video hits its segment end
    // (or natural end), seek every camera to its own segmentStart in a
    // single synchronous burst. The previous design seeked the primary,
    // then bumped externalSeekVersion which scheduled the other seeks via
    // a React render — leaving an 80ms (throttled) gap where the primary
    // played fresh frames while the others still showed the segment-end
    // frame. Now the gap is microseconds.
    const loopAllVideos = () => {
      videoRefs.current.forEach((other, otherIdx) => {
        if (!other) return;
        const otherInfo = videosInfo[otherIdx];
        if (!otherInfo) return;
        other.currentTime = otherInfo.segmentStart ?? 0;
      });
      // Update the slider as a status report — don't bump externalSeekVersion
      // since we already drove every video to its target.
      seek(0, "video");
    };

    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      const info = videosInfo[index];

      // Count this camera toward readiness at most once.
      let counted = false;
      const countReadyOnce = () => {
        if (counted) return;
        counted = true;
        checkReady();
      };

      // One timeupdate handler per video covers both jobs:
      // (a) loop-reset on segmented videos at segment-end
      // (b) reporting the primary video's currentTime back to the context
      const handleTimeUpdate = () => {
        if (info.isSegmented) {
          const segmentEnd = info.segmentEnd ?? video.duration;
          const segmentStart = info.segmentStart ?? 0;
          if (
            video.currentTime >=
            segmentEnd - THRESHOLDS.VIDEO_SEGMENT_BOUNDARY
          ) {
            // Primary drives the coordinated loop. Non-primary cameras
            // that race ahead just snap to segmentStart and wait — the
            // primary's next loop will re-align everyone.
            if (index === firstVisibleIdxRef.current) {
              loopAllVideos();
            } else {
              video.currentTime = segmentStart;
            }
            return;
          }
        }
        if (index === firstVisibleIdxRef.current) {
          let globalTime = video.currentTime;
          if (info.isSegmented) {
            globalTime = video.currentTime - (info.segmentStart ?? 0);
          }
          seek(globalTime, "video");
        }
      };

      // For segmented videos, snap into the segment when play() is called
      // — covers the case where the user paused outside the segment range.
      const handlePlay = info.isSegmented
        ? () => {
            const segmentStart = info.segmentStart ?? 0;
            const segmentEnd = info.segmentEnd ?? video.duration;
            if (
              video.currentTime < segmentStart ||
              video.currentTime >= segmentEnd
            ) {
              video.currentTime = segmentStart;
            }
          }
        : null;

      const handleLoadedData = info.isSegmented
        ? () => {
            // Seek into the episode's segment. We deliberately DON'T count
            // readiness here: loadeddata only guarantees the first frame at
            // position 0, but segmented v3 cameras share one big file and the
            // byte-range at segmentStart still has to be fetched. Counting now
            // lets play() start before that range arrives — the camera then
            // shows a black/stale frame while a luckier camera plays ahead.
            video.currentTime = info.segmentStart ?? 0;
          }
        : null;

      // A segmented camera is only ready once it can actually play AT the
      // seeked segment offset: the seek has finished (!seeking) and it's
      // buffered to HAVE_FUTURE_DATA. Driven by canplay/seeked below.
      const handleSegmentReady = info.isSegmented
        ? () => {
            if (video.seeking) return;
            if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
              countReadyOnce();
            }
          }
        : null;

      const handleEnded = info.isSegmented
        ? null
        : () => {
            // Same coordinated loop strategy for non-segmented videos at
            // their natural end — primary drives, others wait for primary
            // to align them.
            if (index === firstVisibleIdxRef.current) {
              loopAllVideos();
            } else {
              video.currentTime = 0;
            }
          };

      video.addEventListener("timeupdate", handleTimeUpdate);
      if (handlePlay) video.addEventListener("play", handlePlay);
      if (handleEnded) video.addEventListener("ended", handleEnded);

      // Already-loaded videos (cached or fast network) will never re-fire
      // canplaythrough / loadeddata after we attach the listener — so check
      // readyState synchronously and mark ready in a microtask. Without this,
      // checkReady wouldn't be called and only the 10s fallback timeout would
      // eventually unfreeze the UI.
      if (info.isSegmented && handleLoadedData && handleSegmentReady) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          queueMicrotask(handleLoadedData);
          // Cover the already-buffered case: when segmentStart needs no seek
          // (or its data is already cached) canplay/seeked won't re-fire.
          queueMicrotask(handleSegmentReady);
        } else {
          video.addEventListener("loadeddata", handleLoadedData);
        }
        // canplay fires once the post-seek buffer is playable; seeked covers a
        // segmentStart whose data is already fully cached (no canplay re-fire).
        video.addEventListener("canplay", handleSegmentReady);
        video.addEventListener("seeked", handleSegmentReady);
      } else if (!info.isSegmented) {
        if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
          queueMicrotask(countReadyOnce);
        } else {
          video.addEventListener("canplaythrough", countReadyOnce);
        }
      }

      videoEventCleanup.set(video, () => {
        video.removeEventListener("timeupdate", handleTimeUpdate);
        if (handlePlay) video.removeEventListener("play", handlePlay);
        if (handleLoadedData)
          video.removeEventListener("loadeddata", handleLoadedData);
        if (handleEnded) video.removeEventListener("ended", handleEnded);
        if (handleSegmentReady) {
          video.removeEventListener("canplay", handleSegmentReady);
          video.removeEventListener("seeked", handleSegmentReady);
        } else {
          video.removeEventListener("canplaythrough", countReadyOnce);
        }
      });
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
    // onVideosReady intentionally omitted — read via onVideosReadyRef so
    // an inline parent prop doesn't tear this effect down on every render.
  }, [videosInfo, setIsPlaying, seek]);

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
        targetTime = (info.segmentStart ?? 0) + currentTime;
      }

      if (
        Math.abs(video.currentTime - targetTime) >
        THRESHOLDS.VIDEO_SYNC_TOLERANCE
      ) {
        video.currentTime = targetTime;
      }
    });
  }, [externalSeekVersion, currentTime, videosInfo, videosReady, hiddenSet]);

  // Apply transcode fallbacks: when a filename newly enters the set, React has
  // already re-rendered the <video> with the backend src; calling load() makes
  // the element pick it up. We keep the same element (no remount) so the
  // readiness/loop listeners attached in the big effect above stay live and
  // fire again for the freshly-loaded transcoded source.
  useEffect(() => {
    videoRefs.current.forEach((video, idx) => {
      if (!video) return;
      const filename = videosInfo[idx]?.filename;
      if (!filename) return;
      if (
        transcodeFallbacks.has(filename) &&
        !appliedFallbackRef.current.has(filename)
      ) {
        appliedFallbackRef.current.add(filename);
        video.load();
        // load() resets the element and aborts any in-flight playback. If the
        // player is already playing (the global play() fired before this
        // decode-error reload), nothing else will re-issue play() for this
        // camera — so it would stay frozen while the others run. Re-assert it.
        if (isPlayingRef.current) {
          video.play().catch((e) => {
            if (e.name !== "AbortError") {
              console.error("Error playing video");
            }
          });
        }
      }
    });
  }, [transcodeFallbacks, videosInfo]);

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
          // Depth cameras are routed through the transcode endpoint proactively
          // (the browser may decode them natively as flat grayscale, so the
          // onError fallback would never fire and the colormap never apply).
          // Other cameras only switch to transcode after a decode error.
          const wantsTranscode =
            isLikelyDepthCamera(info.filename) ||
            transcodeFallbacks.has(info.filename);
          const transcodeUrl = wantsTranscode
            ? getTranscodeUrl(info.url)
            : null;
          const videoSrc = transcodeUrl ?? proxyHfUrl(info.url);

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
                    onClick={() => {
                      setHiddenVideos((prev) => [...prev, info.filename]);
                      // If the user hid the camera that was enlarged, clear
                      // the enlarged state too — otherwise it stays pointed
                      // at the now-hidden filename and pops back to fullscreen
                      // the moment the user un-hides it.
                      if (enlargedVideo === info.filename) {
                        setEnlargedVideo(null);
                      }
                    }}
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
              <div className="relative w-full">
                <video
                  ref={videoRefCallbacksRef.current[idx]}
                  className={`w-full object-contain ${
                    isEnlarged ? "max-h-[90vh] max-w-[90vw]" : ""
                  }`}
                  muted
                  preload="auto"
                  crossOrigin="anonymous"
                  src={videoSrc}
                  onError={() => {
                    // Decode failure (e.g. gray12le depth video). Fall back to
                    // the backend transcode endpoint once, if available. When
                    // no backend is configured getTranscodeUrl returns null and
                    // we leave the original error in place (same as before).
                    if (transcodeFallbacks.has(info.filename)) return;
                    if (!getTranscodeUrl(info.url)) return;
                    setTranscodeFallbacks((prev) => {
                      const next = new Set(prev);
                      next.add(info.filename);
                      return next;
                    });
                  }}
                >
                  Your browser does not support the video tag.
                </video>
                {/* VQA bbox/keypoint overlay. Reads atoms + drawMode from
                    AnnotationsContext; pointer-events fall through when
                    not in draw mode so video controls remain usable. */}
                <VideoOverlayCanvas
                  videoEl={videoEls[idx] ?? null}
                  cameraKey={info.filename}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

export default SimpleVideosPlayer;

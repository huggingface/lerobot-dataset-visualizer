"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";

type VideoInfo = {
  filename: string;
  url: string;
  isSegmented?: boolean;
  segmentStart?: number;
  segmentEnd?: number;
  segmentDuration?: number;
};

type VideoPlayerProps = {
  videosInfo: VideoInfo[];
  onVideosReady?: () => void;
};

// Global video cache to persist across component instances
const globalVideoCache = new Map<string, HTMLVideoElement>();
const globalPreloadCache = new Map<string, Promise<void>>();

// Helper to preload a video URL
async function preloadVideo(url: string): Promise<void> {
  // Check if already preloading or preloaded
  if (globalPreloadCache.has(url)) {
    return globalPreloadCache.get(url)!;
  }

  const preloadPromise = new Promise<void>((resolve, reject) => {
    let video = globalVideoCache.get(url);
    
    if (!video) {
      video = document.createElement("video");
      video.src = url;
      video.muted = true;
      video.loop = true;
      video.preload = "auto";
      globalVideoCache.set(url, video);
    }

    if (video.readyState >= 4) {
      resolve();
    } else {
      const handleCanPlay = () => {
        video!.removeEventListener("canplaythrough", handleCanPlay);
        video!.removeEventListener("error", handleError);
        resolve();
      };
      
      const handleError = () => {
        video!.removeEventListener("canplaythrough", handleCanPlay);
        video!.removeEventListener("error", handleError);
        reject(new Error(`Failed to preload video: ${url}`));
      };

      video.addEventListener("canplaythrough", handleCanPlay);
      video.addEventListener("error", handleError);
      
      // Force load
      video.load();
    }
  });

  globalPreloadCache.set(url, preloadPromise);
  return preloadPromise;
}

export const OptimizedVideosPlayer = ({
  videosInfo,
  onVideosReady,
}: VideoPlayerProps) => {
  const { currentTime, setCurrentTime, isPlaying, setIsPlaying } = useTime();
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const videoElementsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [hiddenVideos, setHiddenVideos] = useState<string[]>([]);
  const [enlargedVideo, setEnlargedVideo] = useState<string | null>(null);
  const [showHiddenMenu, setShowHiddenMenu] = useState(false);
  const hiddenMenuRef = useRef<HTMLDivElement | null>(null);
  const showHiddenBtnRef = useRef<HTMLButtonElement | null>(null);
  const [videoCodecError, setVideoCodecError] = useState(false);
  const [videosReady, setVideosReady] = useState(false);
  const readyCountRef = useRef(0);

  // Track first visible video for time sync
  const firstVisibleIdx = videosInfo.findIndex(
    (video) => !hiddenVideos.includes(video.filename)
  );
  const visibleCount = videosInfo.filter(
    (video) => !hiddenVideos.includes(video.filename)
  ).length;

  // Get unique video URLs for caching
  const uniqueVideoUrls = useMemo(() => {
    const urls = new Set<string>();
    videosInfo.forEach(info => urls.add(info.url));
    return Array.from(urls);
  }, [videosInfo]);

  // Check codec support
  useEffect(() => {
    const checkCodecSupport = () => {
      const dummyVideo = document.createElement("video");
      const canPlayVideos = dummyVideo.canPlayType(
        'video/mp4; codecs="av01.0.05M.08"'
      );
      setVideoCodecError(!canPlayVideos);
    };
    checkCodecSupport();
  }, []);

  // Initialize and reuse video elements
  useEffect(() => {
    readyCountRef.current = 0;
    setVideosReady(false);
    const videoElements = new Map<string, HTMLVideoElement>();

    // For each video info, create a video element
    videosInfo.forEach((info) => {
      const video = document.createElement("video");
      video.src = info.url;
      video.muted = true;
      video.loop = true;
      video.preload = "auto";
      
      // Mark in cache if not already there
      if (!globalVideoCache.has(info.url)) {
        globalVideoCache.set(info.url, video);
      }
      
      videoElements.set(info.filename, video);
    });

    videoElementsRef.current = videoElements;

    // Setup video ready handlers
    const checkAllReady = () => {
      readyCountRef.current++;
      if (readyCountRef.current === videosInfo.length && !videosReady) {
        setVideosReady(true);
        if (onVideosReady) {
          onVideosReady();
          setIsPlaying(true);
        }
      }
    };

    videoElements.forEach((video, filename) => {
      const info = videosInfo.find(v => v.filename === filename);
      if (!info) return;

      const handleCanPlay = () => {
        // Setup initial segment time if needed
        if (info.isSegmented) {
          const start = info.segmentStart || 0;
          if (Math.abs(video.currentTime - start) > 0.1) {
            video.currentTime = start;
          }
        }
        checkAllReady();
      };

      if (video.readyState >= 4) {
        // Use setTimeout to avoid synchronous state updates
        setTimeout(() => handleCanPlay(), 0);
      } else {
        video.addEventListener("canplaythrough", handleCanPlay, { once: true });
        // Also listen for loadeddata as a fallback
        video.addEventListener("loadeddata", () => {
          if (video.readyState >= 3) {
            handleCanPlay();
          }
        }, { once: true });
      }
    });

    return () => {
      // Don't destroy global cache, just clear references
      videoElementsRef.current.clear();
    };
  }, [videosInfo, onVideosReady, setIsPlaying]);

  // Handle segment looping
  useEffect(() => {
    const videos = videoElementsRef.current;
    const handlers = new Map<string, (e: Event) => void>();
    
    videos.forEach((video, filename) => {
      const info = videosInfo.find(v => v.filename === filename);
      if (!info || !info.isSegmented || hiddenVideos.includes(filename)) return;

      const handleTimeUpdate = () => {
        // Only handle if video is connected to DOM
        if (!video.isConnected) return;
        
        const segmentEnd = info.segmentEnd || video.duration;
        const segmentStart = info.segmentStart || 0;
        
        if (video.currentTime >= segmentEnd - 0.1) {
          video.currentTime = segmentStart;
          if (!isPlaying) {
            video.pause();
          }
        }
      };

      video.addEventListener("timeupdate", handleTimeUpdate);
      handlers.set(filename, handleTimeUpdate);
    });
    
    return () => {
      videos.forEach((video, filename) => {
        const handler = handlers.get(filename);
        if (handler) {
          video.removeEventListener("timeupdate", handler);
        }
      });
    };
  }, [videosInfo, isPlaying, hiddenVideos]);

  // Handle play/pause
  useEffect(() => {
    if (!videosReady) return;

    const playPromises: Promise<void>[] = [];
    
    videoElementsRef.current.forEach((video, filename) => {
      if (hiddenVideos.includes(filename)) return;
      
      if (isPlaying) {
        // Only play if video is in the document
        if (video.isConnected) {
          const playPromise = video.play().catch(e => {
            // Ignore interruption errors
            if (e.name !== 'AbortError') {
              console.error("Error playing video:", e);
            }
          });
          playPromises.push(playPromise);
        }
      } else {
        video.pause();
      }
    });
    
    // Cleanup function to handle component unmount
    return () => {
      videoElementsRef.current.forEach((video) => {
        if (video.isConnected) {
          video.pause();
        }
      });
    };
  }, [isPlaying, videosReady, hiddenVideos]);

  // Sync video times
  useEffect(() => {
    if (!videosReady) return;

    videoElementsRef.current.forEach((video, filename) => {
      const info = videosInfo.find(v => v.filename === filename);
      if (!info || hiddenVideos.includes(filename)) return;

      let targetTime = currentTime;
      
      if (info.isSegmented) {
        const segmentStart = info.segmentStart || 0;
        targetTime = segmentStart + currentTime;
      }

      if (Math.abs(video.currentTime - targetTime) > 0.2) {
        video.currentTime = targetTime;
      }
    });
  }, [currentTime, videosInfo, videosReady, hiddenVideos]);

  // Handle time update from first visible video
  const handleTimeUpdate = useCallback((e: Event) => {
    const video = e.target as HTMLVideoElement;
    
    // Ensure video is still connected and playing
    if (!video.isConnected || video.paused) return;
    
    const filename = Array.from(videoElementsRef.current.entries())
      .find(([_, v]) => v === video)?.[0];
    
    if (!filename) return;
    
    const info = videosInfo.find(v => v.filename === filename);
    if (!info) return;

    let globalTime = video.currentTime;
    
    if (info.isSegmented) {
      const segmentStart = info.segmentStart || 0;
      globalTime = Math.max(0, video.currentTime - segmentStart);
    }
    
    setCurrentTime(globalTime);
  }, [videosInfo, setCurrentTime]);

  // Handle escape key for enlarged video
  useEffect(() => {
    if (!enlargedVideo) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEnlargedVideo(null);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enlargedVideo]);

  // Handle outside click for hidden menu
  useEffect(() => {
    if (!showHiddenMenu) return;
    
    const handleClick = (e: MouseEvent) => {
      const menu = hiddenMenuRef.current;
      const btn = showHiddenBtnRef.current;
      if (
        menu && !menu.contains(e.target as Node) &&
        btn && !btn.contains(e.target as Node)
      ) {
        setShowHiddenMenu(false);
      }
    };
    
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showHiddenMenu]);

  // Preload adjacent videos
  useEffect(() => {
    // Get current video URLs
    const currentUrls = new Set(videosInfo.map(v => v.url));
    
    // Preload logic would go here - you'd need to pass in adjacent episode info
    // For now, just ensure current videos are loaded
    currentUrls.forEach(url => {
      preloadVideo(url).catch(err => 
        console.warn(`Failed to preload video ${url}:`, err)
      );
    });
  }, [videosInfo]);

  // Attach/detach videos from DOM
  useEffect(() => {
    const containers = containerRefs.current;
    const videos = videoElementsRef.current;
    
    // Attach videos to their containers
    videos.forEach((video, filename) => {
      const container = containers.get(filename);
      if (container && !hiddenVideos.includes(filename)) {
        // Only append if not already a child
        if (video.parentElement !== container) {
          // Pause before moving to avoid interruption
          const wasPlaying = !video.paused;
          if (wasPlaying) {
            video.pause();
          }
          
          container.appendChild(video);
          
          // Resume if was playing
          if (wasPlaying && isPlaying) {
            video.play().catch(e => {
              if (e.name !== 'AbortError') {
                console.error("Error resuming video:", e);
              }
            });
          }
        }
        
        // Update classes and event handlers
        const isEnlarged = enlargedVideo === filename;
        const isFirstVisible = Array.from(videos.keys()).indexOf(filename) === firstVisibleIdx;
        
        video.className = `w-full object-contain ${
          isEnlarged ? "max-h-[90vh] max-w-[90vw]" : ""
        }`;
        video.style.zIndex = isEnlarged ? '41' : '';
        video.ontimeupdate = isFirstVisible ? handleTimeUpdate : null;
      }
    });
    
    // Cleanup function
    return () => {
      videos.forEach((video) => {
        if (video.isConnected) {
          video.pause();
        }
      });
    };
  }, [videosInfo, hiddenVideos, enlargedVideo, firstVisibleIdx, handleTimeUpdate, isPlaying]);

  // Render video element
  const renderVideo = (info: VideoInfo, index: number) => {
    if (hiddenVideos.includes(info.filename)) return null;

    const isEnlarged = enlargedVideo === info.filename;

    return (
      <div
        key={info.filename}
        ref={(el) => {
          if (el) containerRefs.current.set(info.filename, el);
          else containerRefs.current.delete(info.filename);
        }}
        className={`${
          isEnlarged
            ? "z-40 fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center"
            : "max-w-96"
        }`}
        style={isEnlarged ? { height: "100vh", width: "100vw" } : {}}
      >
        <p className="truncate w-full rounded-t-xl bg-gray-800 px-2 text-sm text-gray-300 flex items-center justify-between">
          <span>{info.filename}</span>
          <span className="flex gap-1">
            <button
              title={isEnlarged ? "Minimize" : "Enlarge"}
              className="ml-2 p-1 hover:bg-slate-700 rounded focus:outline-none focus:ring-0"
              onClick={() => setEnlargedVideo(isEnlarged ? null : info.filename)}
            >
              {isEnlarged ? <FaCompress /> : <FaExpand />}
            </button>
            <button
              title="Hide Video"
              className="ml-1 p-1 hover:bg-slate-700 rounded focus:outline-none focus:ring-0"
              onClick={() => setHiddenVideos(prev => [...prev, info.filename])}
              disabled={visibleCount === 1}
            >
              <FaTimes />
            </button>
          </span>
        </p>
        <div
          ref={(container) => {
            if (container) {
              containerRefs.current.set(info.filename, container);
            }
          }}
          className="video-container"
        />
      </div>
    );
  };

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
            onClick={() => setShowHiddenMenu(prev => !prev)}
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
                    setHiddenVideos(prev => prev.filter(v => v !== filename))
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
        {videosInfo.map((video, idx) => renderVideo(video, idx))}
      </div>
    </>
  );
};

export default OptimizedVideosPlayer;

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  PLAYBACK_RATES,
  frameCount,
  stepFrames as framesFrom,
} from "@/utils/playback";

// `external` (default) — user-initiated seek (slider drag, chart click,
//                        loop boundary reset). Bumps `externalSeekVersion`
//                        so sync effects know to drive every video to the
//                        new position.
// `video`              — the primary video reporting its own currentTime
//                        via timeupdate. Does NOT bump the version; the
//                        sync effect should treat the change as a status
//                        report, not a command.
type TimeUpdateSource = "external" | "video";

type TimeControls = {
  seek: (t: number, source?: TimeUpdateSource) => void;
  subscribe: (cb: (t: number) => void) => () => void;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
  /** Pauses and moves `frames` frames (negative: back), staying inside the episode. */
  stepFrames: (frames: number) => void;
  setPlaybackRate: (rate: number) => void;
};

type TimeContextType = TimeControls & {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  /** Frames per second of the episode, or 0 when unknown: no frame stepping then. */
  fps: number;
  /** How many frames the episode has. */
  frames: number;
  /** 1 is real time. */
  playbackRate: number;
  // Monotonically increasing counter that bumps on every `external` seek.
  // Sync effects compare the current value against a stored ref to detect
  // user-initiated seeks without relying on heuristics like "did the time
  // jump by more than 0.3s".
  externalSeekVersion: number;
};

const TimeControlsContext = createContext<TimeControls | undefined>(undefined);
const TimeContext = createContext<TimeContextType | undefined>(undefined);

/** Everything, including `currentTime`: re-renders on every playback tick. */
export const useTime = () => {
  const ctx = useContext(TimeContext);
  if (!ctx) throw new Error("useTime must be used within a TimeProvider");
  return ctx;
};

/**
 * Seeking and play/pause setters, stable for the provider's lifetime. A component that only seeks
 * or toggles playback should use this: reading `useTime()` at all re-renders it on every playback
 * tick, whichever fields it destructures. `isPlaying` and `duration` are read through `useTime()`.
 */
export const useTimeControls = () => {
  const ctx = useContext(TimeControlsContext);
  if (!ctx)
    throw new Error("useTimeControls must be used within a TimeProvider");
  return ctx;
};

const RATE_KEY = "playbackRate";

/** The speed chosen earlier in this browser tab: it should outlive an episode change. */
function storedPlaybackRate(): number {
  try {
    const rate = Number(sessionStorage.getItem(RATE_KEY));
    return (PLAYBACK_RATES as readonly number[]).includes(rate) ? rate : 1;
  } catch {
    return 1;
  }
}

export const TimeProvider: React.FC<{
  children: React.ReactNode;
  duration: number;
  fps?: number;
  /**
   * The episode's frame count, when known. A duration alone is not enough: on v2.x it is the last
   * frame's timestamp, which is one frame short of the episode.
   */
  frames?: number;
}> = ({
  children,
  duration: initialDuration,
  fps = 0,
  frames: knownFrames,
}) => {
  const [currentTime, setCurrentTimeState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(initialDuration);
  const [playbackRate, setPlaybackRateState] = useState(storedPlaybackRate);
  const [externalSeekVersion, setExternalSeekVersion] = useState(0);
  const listeners = useRef<Set<(t: number) => void>>(new Set());

  // Keep the authoritative time in a ref so subscribers and sync effects
  // always see the latest value without waiting for a React render cycle.
  const timeRef = useRef(0);
  const rafId = useRef<number | null>(null);

  const updateTime = useCallback(
    (t: number, source: TimeUpdateSource = "external") => {
      timeRef.current = t;
      listeners.current.forEach((fn) => fn(t));

      if (source === "external") {
        setCurrentTimeState(t);
        setExternalSeekVersion((v) => v + 1);
        return;
      }

      // The primary video reports every painted frame (requestVideoFrameCallback),
      // so coalesce into one React update per animation frame. Only leaf
      // components read currentTime (see useTimeControls), which keeps this
      // cheap. There used to be an 80ms floor on top, which also dropped the
      // last update outright when it landed inside the window.
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          setCurrentTimeState(timeRef.current);
        });
      }
    },
    [],
  );

  // Flush any pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // When playback stops, flush the exact final time so the UI matches
  useEffect(() => {
    if (!isPlaying) {
      setCurrentTimeState(timeRef.current);
    }
  }, [isPlaying]);

  const subscribe = useCallback((cb: (t: number) => void) => {
    listeners.current.add(cb);
    return () => listeners.current.delete(cb);
  }, []);

  const frames =
    knownFrames && knownFrames > 0
      ? knownFrames
      : fps > 0
        ? frameCount(duration, fps)
        : 0;
  // Read through a ref so stepping stays one stable function for the provider's lifetime.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const stepFrames = useCallback(
    (step: number) => {
      if (!(fps > 0)) return;
      // A step is for looking at one frame: playing on would move straight past it.
      setIsPlaying(false);
      updateTime(framesFrom(timeRef.current, fps, framesRef.current, step));
    },
    [fps, updateTime],
  );

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate);
    try {
      sessionStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // Storage blocked: the speed lasts for this episode only.
    }
  }, []);

  const controls = useMemo(
    () => ({
      seek: updateTime,
      subscribe,
      setIsPlaying,
      setDuration,
      stepFrames,
      setPlaybackRate,
    }),
    [updateTime, subscribe, stepFrames, setPlaybackRate],
  );
  const value = useMemo(
    () => ({
      ...controls,
      isPlaying,
      duration,
      currentTime,
      externalSeekVersion,
      fps,
      frames,
      playbackRate,
    }),
    [
      controls,
      isPlaying,
      duration,
      currentTime,
      externalSeekVersion,
      fps,
      frames,
      playbackRate,
    ],
  );

  return (
    <TimeControlsContext.Provider value={controls}>
      <TimeContext.Provider value={value}>{children}</TimeContext.Provider>
    </TimeControlsContext.Provider>
  );
};

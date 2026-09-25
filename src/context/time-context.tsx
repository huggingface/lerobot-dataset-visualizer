import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";

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
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

type TimeContextType = TimeControls & {
  currentTime: number;
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
 * Seeking and play state without `currentTime`. A component that only seeks or toggles playback
 * should use this: reading `useTime()` at all re-renders it on every playback tick, whichever
 * fields it destructures.
 */
export const useTimeControls = () => {
  const ctx = useContext(TimeControlsContext);
  if (!ctx)
    throw new Error("useTimeControls must be used within a TimeProvider");
  return ctx;
};

const TIME_RENDER_THROTTLE_MS = 80;

export const TimeProvider: React.FC<{
  children: React.ReactNode;
  duration: number;
}> = ({ children, duration: initialDuration }) => {
  const [currentTime, setCurrentTimeState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(initialDuration);
  const [externalSeekVersion, setExternalSeekVersion] = useState(0);
  const listeners = useRef<Set<(t: number) => void>>(new Set());

  // Keep the authoritative time in a ref so subscribers and sync effects
  // always see the latest value without waiting for a React render cycle.
  const timeRef = useRef(0);
  const rafId = useRef<number | null>(null);
  const lastRenderTime = useRef(0);

  const updateTime = useCallback(
    (t: number, source: TimeUpdateSource = "external") => {
      timeRef.current = t;
      listeners.current.forEach((fn) => fn(t));

      if (source === "external") {
        lastRenderTime.current = performance.now();
        setCurrentTimeState(t);
        setExternalSeekVersion((v) => v + 1);
        return;
      }

      // Throttle React state updates — during playback, timeupdate fires ~4×/sec
      // per video. Coalescing into rAF + a minimum interval avoids cascading
      // re-renders across PlaybackBar, charts, etc.
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          const now = performance.now();
          if (now - lastRenderTime.current >= TIME_RENDER_THROTTLE_MS) {
            lastRenderTime.current = now;
            setCurrentTimeState(timeRef.current);
          }
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

  const controls = useMemo(
    () => ({
      seek: updateTime,
      subscribe,
      isPlaying,
      setIsPlaying,
      duration,
      setDuration,
    }),
    [updateTime, subscribe, isPlaying, duration],
  );
  const value = useMemo(
    () => ({ ...controls, currentTime, externalSeekVersion }),
    [controls, currentTime, externalSeekVersion],
  );

  return (
    <TimeControlsContext.Provider value={controls}>
      <TimeContext.Provider value={value}>{children}</TimeContext.Provider>
    </TimeControlsContext.Provider>
  );
};

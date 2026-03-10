import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react";

// ── Volatile context ──────────────────────────────────────────────────────────
// Re-renders every consumer on each throttled time update.
// Only subscribe to this if you genuinely need currentTime as React state
// (e.g. URL sync, conditional rendering based on playhead position).
type TimeValueContextType = { currentTime: number };
const TimeValueContext = createContext<TimeValueContextType>({ currentTime: 0 });

// ── Stable context ────────────────────────────────────────────────────────────
// Values here change only rarely (play/pause, duration change).
// Components that use useTimeControl() are never re-rendered by time updates,
// which eliminates cascading renders in PlaybackBar, video players, etc.
type TimeControlContextType = {
  setCurrentTime: (t: number) => void;
  /** Subscribe to every time update imperatively without causing re-renders. */
  subscribe: (cb: (t: number) => void) => () => void;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

const TimeControlContext = createContext<TimeControlContextType | undefined>(
  undefined,
);

/** Full context — re-renders on every throttled time update. */
export const useTime = () => {
  const value = useContext(TimeValueContext);
  const control = useContext(TimeControlContext);
  if (!control) throw new Error("useTime must be used within a TimeProvider");
  return { ...value, ...control };
};

/** Stable context — never re-renders due to time updates. Use subscribe() for
 *  imperative time-driven updates (video sync, slider position, chart cursor). */
export const useTimeControl = () => {
  const control = useContext(TimeControlContext);
  if (!control)
    throw new Error("useTimeControl must be used within a TimeProvider");
  return control;
};

const TIME_RENDER_THROTTLE_MS = 80;

export const TimeProvider: React.FC<{
  children: React.ReactNode;
  duration: number;
}> = ({ children, duration: initialDuration }) => {
  const [currentTime, setCurrentTimeState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(initialDuration);
  const listeners = useRef<Set<(t: number) => void>>(new Set());

  // Keep the authoritative time in a ref so subscribers and sync effects
  // always see the latest value without waiting for a React render cycle.
  const timeRef = useRef(0);
  const rafId = useRef<number | null>(null);
  const lastRenderTime = useRef(0);

  const updateTime = useCallback((t: number) => {
    timeRef.current = t;
    listeners.current.forEach((fn) => fn(t));

    // Throttle React state updates — during playback, timeupdate fires ~4×/sec
    // per video. Coalescing into rAF + a minimum interval avoids cascading
    // re-renders in any component that still reads currentTime as React state.
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
  }, []);

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

  // Stable control value — only re-creates when isPlaying/duration change,
  // never on time updates. Components using useTimeControl() are insulated
  // from the high-frequency setCurrentTimeState calls above.
  const controlValue = useMemo(
    () => ({
      setCurrentTime: updateTime,
      subscribe,
      isPlaying,
      setIsPlaying,
      duration,
      setDuration,
    }),
    [updateTime, subscribe, isPlaying, duration],
  );

  return (
    <TimeControlContext.Provider value={controlValue}>
      <TimeValueContext.Provider value={{ currentTime }}>
        {children}
      </TimeValueContext.Provider>
    </TimeControlContext.Provider>
  );
};

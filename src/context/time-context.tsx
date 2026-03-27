import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
} from "react";

type TimeContextType = {
  currentTime: number;
  setCurrentTime: (t: number) => void;
  subscribe: (cb: (t: number) => void) => () => void;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

const TimeContext = createContext<TimeContextType | undefined>(undefined);

export const useTime = () => {
  const ctx = useContext(TimeContext);
  if (!ctx) throw new Error("useTime must be used within a TimeProvider");
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

  return (
    <TimeContext.Provider
      value={{
        currentTime,
        setCurrentTime: updateTime,
        subscribe,
        isPlaying,
        setIsPlaying,
        duration,
        setDuration,
      }}
    >
      {children}
    </TimeContext.Provider>
  );
};

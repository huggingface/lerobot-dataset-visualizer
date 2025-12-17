import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

type TimeContextType = {
  currentTime: number;
  setCurrentTime: (t: number) => void;
  subscribe: (cb: (t: number) => void) => () => void;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

type PlaybackContextType = {
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
};

const TimeContext = createContext<TimeContextType | undefined>(undefined);
const PlaybackContext = createContext<PlaybackContextType | undefined>(undefined);

export const useTime = (): TimeContextType => {
  const ctx = useContext(TimeContext);
  if (!ctx) throw new Error("useTime must be used within a TimeProvider");
  return ctx;
};

export const usePlayback = (): PlaybackContextType => {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error("usePlayback must be used within a TimeProvider");
  return ctx;
};

export const TimeProvider: React.FC<{
  children: React.ReactNode;
  duration: number;
}> = ({ children, duration: initialDuration }) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const listeners = useRef<Set<(t: number) => void>>(new Set());

  // Call this to update time and notify all listeners
  const updateTime = useCallback((t: number) => {
    setCurrentTime(t);
    listeners.current.forEach((fn) => fn(t));
  }, []);

  // Components can subscribe to time changes (for imperative updates)
  const subscribe = useCallback((cb: (t: number) => void) => {
    listeners.current.add(cb);
    return () => listeners.current.delete(cb);
  }, []);

  const timeValue = useMemo(
    () => ({
      currentTime,
      setCurrentTime: updateTime,
      subscribe,
      duration,
      setDuration,
    }),
    [currentTime, updateTime, subscribe, duration],
  );

  const [isPlaying, setIsPlaying] = useState(false);

  const playbackValue = useMemo(
    () => ({
      isPlaying,
      setIsPlaying,
    }),
    [isPlaying],
  );

  return (
    <TimeContext.Provider value={timeValue}>
      <PlaybackContext.Provider value={playbackValue}>
        {children}
      </PlaybackContext.Provider>
    </TimeContext.Provider>
  );
};

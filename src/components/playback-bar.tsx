import React from "react";
import { useTimeControl } from "../context/time-context";
import {
  FaPlay,
  FaPause,
  FaBackward,
  FaForward,
  FaUndoAlt,
  FaArrowDown,
  FaArrowUp,
} from "react-icons/fa";

// PlaybackBar uses useTimeControl (stable context) so it is never re-rendered
// by time updates. The slider thumb and time display are updated imperatively
// via the subscribe callback instead, which runs at the full timeupdate rate
// without going through React's render cycle.
const PlaybackBar: React.FC = () => {
  const { duration, isPlaying, setIsPlaying, setCurrentTime, subscribe } =
    useTimeControl();

  const sliderRef = React.useRef<HTMLInputElement>(null);
  const timeDisplayRef = React.useRef<HTMLSpanElement>(null);
  const sliderActiveRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  // Track current time in a ref so click handlers can read it without
  // needing currentTime as React state (which would cause re-renders).
  const currentTimeRef = React.useRef(0);

  // Imperatively move the slider and update the time display on every tick.
  React.useEffect(() => {
    return subscribe((t) => {
      currentTimeRef.current = t;
      if (sliderRef.current && !sliderActiveRef.current) {
        sliderRef.current.value = String(t);
      }
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = `${Math.floor(t)} / ${Math.floor(duration)}`;
      }
    });
  }, [subscribe, duration]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    currentTimeRef.current = t;
    setCurrentTime(t);
  };

  const handleSliderMouseDown = () => {
    sliderActiveRef.current = true;
    wasPlayingRef.current = isPlaying;
    setIsPlaying(false);
  };

  const handleSliderMouseUp = () => {
    sliderActiveRef.current = false;
    setCurrentTime(currentTimeRef.current);
    if (wasPlayingRef.current) {
      setIsPlaying(true);
    }
  };

  return (
    <div className="flex items-center gap-4 w-full max-w-4xl mx-auto sticky bottom-0 bg-slate-900/95 px-4 py-3 rounded-3xl mt-auto">
      <button
        title="Jump backward 5 seconds"
        onClick={() => setCurrentTime(Math.max(0, currentTimeRef.current - 5))}
        className="text-2xl hidden md:block"
      >
        <FaBackward size={24} />
      </button>
      <button
        className={`text-3xl transition-transform ${isPlaying ? "scale-90 opacity-60" : "scale-110"}`}
        title="Play. Toggle with Space"
        onClick={() => setIsPlaying(true)}
        style={{ display: isPlaying ? "none" : "inline-block" }}
      >
        <FaPlay size={24} />
      </button>
      <button
        className={`text-3xl transition-transform ${!isPlaying ? "scale-90 opacity-60" : "scale-110"}`}
        title="Pause. Toggle with Space"
        onClick={() => setIsPlaying(false)}
        style={{ display: !isPlaying ? "none" : "inline-block" }}
      >
        <FaPause size={24} />
      </button>
      <button
        title="Jump forward 5 seconds"
        onClick={() => setCurrentTime(Math.min(duration, currentTimeRef.current + 5))}
        className="text-2xl hidden md:block"
      >
        <FaForward size={24} />
      </button>
      <button
        title="Rewind from start"
        onClick={() => setCurrentTime(0)}
        className="text-2xl hidden md:block"
      >
        <FaUndoAlt size={24} />
      </button>
      <input
        ref={sliderRef}
        type="range"
        min={0}
        max={duration}
        step={0.01}
        defaultValue={0}
        onChange={handleSliderChange}
        onMouseDown={handleSliderMouseDown}
        onMouseUp={handleSliderMouseUp}
        onTouchStart={handleSliderMouseDown}
        onTouchEnd={handleSliderMouseUp}
        className="flex-1 mx-2 accent-orange-500 focus:outline-none focus:ring-0"
        aria-label="Seek video"
      />
      <span
        ref={timeDisplayRef}
        className="w-16 text-right tabular-nums text-xs text-slate-200 shrink-0"
      >
        0 / {Math.floor(duration)}
      </span>

      <div className="text-xs text-slate-300 select-none ml-8 flex-col gap-y-0.5 hidden md:flex">
        <p>
          <span className="inline-flex items-center gap-1 font-mono align-middle">
            <span className="px-2 py-0.5 rounded border border-slate-400 bg-slate-800 text-slate-200 text-xs shadow-inner">
              Space
            </span>
          </span>{" "}
          to pause/unpause
        </p>
        <p>
          <span className="inline-flex items-center gap-1 font-mono align-middle">
            <span className="px-1.5 py-0.5 rounded border border-slate-400 bg-slate-800 text-slate-200 text-xs shadow-inner">◀</span>
            <span className="px-1.5 py-0.5 rounded border border-slate-400 bg-slate-800 text-slate-200 text-xs shadow-inner">▶</span>
          </span>{" "}
          step 1 frame (paused) / 10 frames (playing)
        </p>
        <p>
          <span className="inline-flex items-center gap-1 font-mono align-middle">
            <FaArrowUp size={14} />/<FaArrowDown size={14} />
          </span>{" "}
          to previous/next episode
        </p>
      </div>
    </div>
  );
};

export default PlaybackBar;

import React from "react";
import { useTime } from "../context/time-context";
import {
  FaPlay,
  FaPause,
  FaBackward,
  FaForward,
  FaUndoAlt,
  FaArrowDown,
  FaArrowUp,
} from "react-icons/fa";

const PlaybackBar: React.FC = () => {
  const { duration, isPlaying, setIsPlaying, currentTime, setCurrentTime } =
    useTime();

  const sliderActiveRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  const [sliderValue, setSliderValue] = React.useState(currentTime);

  // Only update sliderValue from context if not dragging
  React.useEffect(() => {
    if (!sliderActiveRef.current) {
      setSliderValue(currentTime);
    }
  }, [currentTime]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    setSliderValue(t);
    // Seek videos immediately while dragging (no debounce)
    setCurrentTime(t);
  };

  const handleSliderMouseDown = () => {
    sliderActiveRef.current = true;
    wasPlayingRef.current = isPlaying;
    setIsPlaying(false);
  };

  const handleSliderMouseUp = () => {
    sliderActiveRef.current = false;
    // Final seek to exact slider position
    setCurrentTime(sliderValue);
    if (wasPlayingRef.current) {
      setIsPlaying(true);
    }
  };

  return (
    <div className="sticky bottom-0 mt-auto w-full max-w-4xl mx-auto flex items-center gap-3 panel-raised bg-[var(--surface-0)]/90 backdrop-blur px-3 py-2">
      <button
        title="Jump backward 5 seconds"
        onClick={() => setCurrentTime(Math.max(0, currentTime - 5))}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaBackward size={14} />
      </button>
      <button
        className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-400/10 border border-cyan-400/30 text-cyan-300 hover:bg-cyan-400/15 transition-colors"
        title={
          isPlaying ? "Pause. Toggle with Space" : "Play. Toggle with Space"
        }
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <FaPause size={14} /> : <FaPlay size={14} />}
      </button>
      <button
        title="Jump forward 5 seconds"
        onClick={() => setCurrentTime(Math.min(duration, currentTime + 5))}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaForward size={14} />
      </button>
      <button
        title="Rewind from start"
        onClick={() => setCurrentTime(0)}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaUndoAlt size={14} />
      </button>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={sliderValue}
        onChange={handleSliderChange}
        onMouseDown={handleSliderMouseDown}
        onMouseUp={handleSliderMouseUp}
        onTouchStart={handleSliderMouseDown}
        onTouchEnd={handleSliderMouseUp}
        className="flex-1 mx-1 h-1 accent-cyan-400 cursor-pointer focus:outline-none focus:ring-0"
        aria-label="Seek video"
      />
      <span className="w-16 text-right tabular text-[11px] text-slate-400 shrink-0">
        {Math.floor(sliderValue)} / {Math.floor(duration)}
      </span>

      <div className="hidden lg:flex flex-col gap-y-0.5 ml-4 text-[10px] text-slate-500 select-none">
        <p className="inline-flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-slate-300 text-[10px]">
            Space
          </kbd>
          <span>pause/unpause</span>
        </p>
        <p className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 text-slate-300">
            <FaArrowUp size={10} />
            <FaArrowDown size={10} />
          </span>
          <span>prev/next episode</span>
        </p>
      </div>
    </div>
  );
};

export default PlaybackBar;

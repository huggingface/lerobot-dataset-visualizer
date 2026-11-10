import React from "react";
import { useTime } from "../context/time-context";
import {
  FaPlay,
  FaPause,
  FaBackward,
  FaForward,
  FaStepBackward,
  FaStepForward,
  FaUndoAlt,
  FaArrowDown,
  FaArrowLeft,
  FaArrowRight,
  FaArrowUp,
} from "react-icons/fa";
import { PLAYBACK_RATES, formatClock, frameAt } from "@/utils/playback";

const ICON_BUTTON =
  "h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-fill transition-colors";
const KEY =
  "px-1.5 py-0.5 rounded border border-line bg-fill text-fg-soft text-[10px]";

const PlaybackBar: React.FC = () => {
  const {
    duration,
    isPlaying,
    setIsPlaying,
    currentTime,
    seek,
    fps,
    frames,
    stepFrames,
    playbackRate,
    setPlaybackRate,
  } = useTime();

  const sliderActiveRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  const sliderValueRef = React.useRef(currentTime);
  const [sliderValue, setSliderValue] = React.useState(currentTime);

  // Only update sliderValue from context if not dragging
  React.useEffect(() => {
    if (!sliderActiveRef.current) {
      sliderValueRef.current = currentTime;
      setSliderValue(currentTime);
    }
  }, [currentTime]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    sliderValueRef.current = t;
    setSliderValue(t);
    // Seek videos immediately while dragging (no debounce)
    seek(t);
  };

  const handleSliderMouseDown = () => {
    sliderActiveRef.current = true;
    wasPlayingRef.current = isPlaying;
    setIsPlaying(false);
  };

  const handleSliderMouseUp = () => {
    sliderActiveRef.current = false;
    // Final seek to exact slider position
    seek(sliderValueRef.current);
    if (wasPlayingRef.current) {
      setIsPlaying(true);
    }
  };

  const hasFrames = fps > 0 && frames > 0;
  const frame = hasFrames ? Math.min(frames - 1, frameAt(sliderValue, fps)) : 0;

  return (
    <div className="sticky bottom-0 mt-auto w-full max-w-4xl mx-auto flex items-center gap-2 panel-raised bg-[var(--surface-0)]/90 backdrop-blur px-3 py-2">
      <button
        title="Jump backward 5 seconds"
        aria-label="Jump backward 5 seconds"
        onClick={() => seek(Math.max(0, currentTime - 5))}
        // The 5-second jumps go first when room is short: the slider and the frame steps cover them.
        className={`hidden lg:flex ${ICON_BUTTON}`}
      >
        <FaBackward size={14} />
      </button>
      {hasFrames && (
        <button
          title="Previous frame (←)"
          aria-label="Previous frame"
          onClick={() => stepFrames(-1)}
          className={`flex ${ICON_BUTTON}`}
        >
          <FaStepBackward size={12} />
        </button>
      )}
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 border border-accent/30 text-accent-fg hover:bg-accent/15 transition-colors"
        title={
          isPlaying ? "Pause. Toggle with Space" : "Play. Toggle with Space"
        }
        aria-label={isPlaying ? "Pause" : "Play"}
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <FaPause size={14} /> : <FaPlay size={14} />}
      </button>
      {hasFrames && (
        <button
          title="Next frame (→)"
          aria-label="Next frame"
          onClick={() => stepFrames(1)}
          className={`flex ${ICON_BUTTON}`}
        >
          <FaStepForward size={12} />
        </button>
      )}
      <button
        title="Jump forward 5 seconds"
        aria-label="Jump forward 5 seconds"
        onClick={() => seek(Math.min(duration, currentTime + 5))}
        className={`hidden lg:flex ${ICON_BUTTON}`}
      >
        <FaForward size={14} />
      </button>
      <button
        title="Rewind from start"
        aria-label="Rewind from start"
        onClick={() => seek(0)}
        className={`hidden md:flex ${ICON_BUTTON}`}
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
        className="flex-1 mx-1 h-1 min-w-16 accent-accent cursor-pointer focus:outline-none focus:ring-0"
        aria-label="Seek video"
      />
      {/* Time to the hundredth, and the frame it is: what an annotation or a bug report cites. */}
      <div className="shrink-0 text-right leading-tight tabular">
        <p className="text-[11px] text-fg-soft">
          {formatClock(sliderValue)}
          <span className="text-fg-faint"> / {formatClock(duration)}</span>
        </p>
        {hasFrames && (
          <p className="text-[10px] text-fg-faint">
            frame {frame.toLocaleString()}
            <span className="hidden sm:inline">
              {" "}
              / {(frames - 1).toLocaleString()}
            </span>
          </p>
        )}
      </div>
      <select
        value={playbackRate}
        onChange={(e) => setPlaybackRate(Number(e.target.value))}
        title="Playback speed"
        aria-label="Playback speed"
        className="shrink-0 rounded-md border border-line bg-fill px-1 py-1 text-[11px] text-fg-soft tabular hover:bg-fill-strong focus:border-accent focus:outline-none"
      >
        {PLAYBACK_RATES.map((rate) => (
          <option key={rate} value={rate}>
            {rate}×
          </option>
        ))}
      </select>

      <div className="hidden xl:flex flex-col gap-y-0.5 ml-2 text-[10px] text-fg-faint select-none">
        <p className="inline-flex items-center gap-1.5">
          <kbd className={KEY}>Space</kbd>
          <span>play / pause</span>
        </p>
        {hasFrames && (
          <p className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 text-fg-soft">
              <FaArrowLeft size={10} />
              <FaArrowRight size={10} />
            </span>
            <span>frame</span>
            <kbd className={KEY}>Shift</kbd>
            <span>1 s</span>
          </p>
        )}
        <p className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 text-fg-soft">
            <FaArrowUp size={10} />
            <FaArrowDown size={10} />
          </span>
          <span>prev / next episode</span>
        </p>
      </div>
    </div>
  );
};

export default PlaybackBar;

/** Frame arithmetic for the playback bar: which frame a time shows, and where to seek to show one. */

/**
 * How far past a frame's start to seek. A seek to the exact boundary between two frames can show
 * either; a millisecond in is unambiguous at any frame rate a camera records at, and close enough
 * that the charts still read the same frame's row.
 */
const INTO_FRAME_SEC = 0.001;

export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;

/** The frame on screen at `time`. */
export function frameAt(time: number, fps: number): number {
  // The small allowance absorbs a time that is a frame's start minus rounding error.
  return Math.max(0, Math.floor(time * fps + 1e-3));
}

/**
 * How many frames an episode of `duration` seconds has, for when the count itself is not known.
 * Prefer the real count: a duration can be the last frame's timestamp (v2.x), one frame short.
 */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}

/** The time to seek to so that frame `frame` is the one shown. */
export function timeOfFrame(frame: number, fps: number): number {
  return frame / fps + INTO_FRAME_SEC;
}

/**
 * Where to seek to move `step` frames from `time`, staying inside an episode of `frames` frames:
 * stepping back from the first frame or forward from the last stays put.
 */
export function stepFrames(
  time: number,
  fps: number,
  frames: number,
  step: number,
): number {
  const last = Math.max(0, frames - 1);
  const frame = Math.min(last, Math.max(0, frameAt(time, fps) + step));
  return timeOfFrame(frame, fps);
}

/** `0:05.33`, or `1:02:05.33` past the hour: a clock precise to the frame. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  // Work in centiseconds so 59.999 reads 1:00.00 rather than 0:60.00.
  const total = Math.round(safe * 100);
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor((total % 360000) / 6000);
  const secs = ((total % 6000) / 100).toFixed(2).padStart(5, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

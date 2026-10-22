export interface TimelineWindow {
  start: number;
  end: number;
}

/** Keep a fixed-size window inside the episode, including its final frame. */
export function timelineWindow(
  duration: number,
  time: number,
  seconds = 40,
): TimelineWindow {
  const width = Math.min(Math.max(0, duration), seconds);
  const start = Math.max(0, Math.min(duration - width, time - width / 2));
  return { start, end: start + width };
}

/** Clip spans before positioning them so offscreen boundaries cannot be resized. */
export function visibleSpan(start: number, end: number, view: TimelineWindow) {
  const from = Math.max(start, view.start);
  const to = Math.min(end, view.end);
  if (to <= from || view.end <= view.start) return null;
  return {
    left: ((from - view.start) / (view.end - view.start)) * 100,
    width: ((to - from) / (view.end - view.start)) * 100,
  };
}

/** Use a handful of evenly spaced, round timestamps at any zoom level. */
export function timelineTicks({ start, end }: TimelineWindow): number[] {
  const rawStep = (end - start) / 5;
  if (rawStep <= 0) return [];
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= rawStep)! * magnitude;
  const first = Math.ceil(start / step) * step;
  return Array.from(
    { length: Math.max(0, Math.floor((end - first) / step) + 1) },
    (_, i) => Number((first + i * step).toPrecision(12)),
  );
}

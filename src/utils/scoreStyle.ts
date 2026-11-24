/**
 * The look of lerobot's progress videos (`examples/dataset/create_progress_videos.py`, lerobot#5457),
 * so a score reads the same in the viewer as in a rendered video: the LeRobot brand colours, the
 * signal colours in their order, and Tableau 10 for subtasks.
 */

export const BRAND = {
  background: "#12110d",
  cream: "#f3f0e4",
  muted: "#a8a38e",
  ink: "#15140f",
} as const;

/** Curve colours over video, in order: yellow, blue, orange, cream. */
const SIGNAL_COLORS = ["#ffd21e", "#8fa8ff", "#ff9d00", "#f3f0e4"] as const;

/** Subtask colours (Tableau 10), given out to subtask names in the order they are met. */
const SUBTASK_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
] as const;

/**
 * How curve number `index` is drawn over video. Past the fourth the colours come round dashed;
 * past the eighth, muted. `dash` is in the overlay's layout units, to be scaled with it.
 */
export function scoreColor(index: number): {
  color: string;
  dash: number[] | undefined;
} {
  if (index >= 8) return { color: BRAND.muted, dash: [2, 3] };
  return {
    color: SIGNAL_COLORS[index % 4],
    dash: index >= 4 ? [6, 4] : undefined,
  };
}

/** One colour per subtask name, so an annotated subtask and the same predicted one match. */
export function subtaskColors(names: Iterable<string>): Map<string, string> {
  const colors = new Map<string, string>();
  for (const name of names) {
    if (!colors.has(name)) {
      colors.set(name, SUBTASK_COLORS[colors.size % SUBTASK_COLORS.length]);
    }
  }
  return colors;
}

/** An axis tick as the videos print it: with the unit, or 0 / one decimal. */
export function axisTick(value: number, unit: string | null): string {
  if (unit) return `${Number(value.toPrecision(6))} ${unit}`;
  return value === 0 ? "0" : value.toFixed(1);
}

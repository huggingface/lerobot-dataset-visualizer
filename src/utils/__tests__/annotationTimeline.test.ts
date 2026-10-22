import { describe, expect, test } from "bun:test";
import {
  timelineTicks,
  timelineWindow,
  visibleSpan,
} from "../annotationTimeline";

describe("annotation timeline windows", () => {
  test("keeps the full final interval visible when inspecting 99 seconds", () => {
    const view = timelineWindow(110.97, 99);
    expect(view.start).toBeCloseTo(70.97);
    expect(view.end).toBe(110.97);
  });

  test("fits short and empty episodes without negative bounds", () => {
    expect(timelineWindow(12, 10)).toEqual({ start: 0, end: 12 });
    expect(timelineWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(timelineWindow(120, 0)).toEqual({ start: 0, end: 40 });
  });

  test("clips partially visible spans and excludes adjacent offscreen spans", () => {
    const view = { start: 40, end: 60 };
    expect(visibleSpan(30, 45, view)).toEqual({ left: 0, width: 25 });
    expect(visibleSpan(55, 75, view)).toEqual({ left: 75, width: 25 });
    expect(visibleSpan(0, 40, view)).toBeNull();
    expect(visibleSpan(60, 80, view)).toBeNull();
    expect(visibleSpan(0, 1, { start: 0, end: 0 })).toBeNull();
  });

  test("uses round, bounded ticks for fractional and long episodes", () => {
    expect(timelineTicks(timelineWindow(110.97, 99))).toEqual([
      80, 90, 100, 110,
    ]);
    for (const end of [0.3, 12, 110.97, 3600]) {
      const ticks = timelineTicks({ start: 0, end });
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks.every((t) => t >= 0 && t <= end)).toBe(true);
    }
    expect(timelineTicks({ start: 0, end: 0 })).toEqual([]);
  });
});

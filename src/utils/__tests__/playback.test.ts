import { describe, expect, test } from "bun:test";
import {
  formatClock,
  frameAt,
  frameCount,
  stepFrames,
  timeOfFrame,
} from "@/utils/playback";

describe("frameAt", () => {
  test("a frame is on screen from its start until the next one's", () => {
    expect(frameAt(0, 30)).toBe(0);
    expect(frameAt(0.032, 30)).toBe(0);
    expect(frameAt(1 / 30, 30)).toBe(1);
    expect(frameAt(0.05, 30)).toBe(1);
    expect(frameAt(5.33, 30)).toBe(159);
  });

  test("a frame start that is off by rounding error still counts as that frame", () => {
    // 0.1 + 0.2 style drift: 3 / 30 computed the long way lands just under 0.1.
    expect(frameAt(0.1 - 1e-12, 30)).toBe(3);
    for (let frame = 0; frame < 2000; frame++) {
      expect(frameAt(frame / 50, 50)).toBe(frame);
      expect(frameAt(frame / 30, 30)).toBe(frame);
    }
  });

  test("the time sought for a frame reads back as that frame", () => {
    for (const fps of [10, 15, 24, 30, 50, 60, 120]) {
      for (const frame of [0, 1, 2, 59, 600, 12345]) {
        expect(frameAt(timeOfFrame(frame, fps), fps)).toBe(frame);
      }
    }
  });
});

describe("stepFrames", () => {
  const fps = 30;
  const frames = 210; // 0..209

  test("moves one frame at a time, from wherever inside a frame it starts", () => {
    const fromMidFrame = 5.34; // inside frame 160
    expect(frameAt(stepFrames(fromMidFrame, fps, frames, 1), fps)).toBe(161);
    expect(frameAt(stepFrames(fromMidFrame, fps, frames, -1), fps)).toBe(159);
  });

  test("stepping forward then back returns to the same frame", () => {
    let time = 2.5;
    const start = frameAt(time, fps);
    for (let i = 0; i < 25; i++) time = stepFrames(time, fps, frames, 1);
    expect(frameAt(time, fps)).toBe(start + 25);
    for (let i = 0; i < 25; i++) time = stepFrames(time, fps, frames, -1);
    expect(frameAt(time, fps)).toBe(start);
  });

  test("stays inside the episode at both ends", () => {
    expect(frameAt(stepFrames(0, fps, frames, -1), fps)).toBe(0);
    expect(frameAt(stepFrames(6.99, fps, frames, 1), fps)).toBe(209);
    expect(frameAt(stepFrames(3, fps, frames, 10_000), fps)).toBe(209);
  });

  test("reaches the last frame when the duration is that frame's timestamp", () => {
    // v2.x reports an episode's duration as its last timestamp: 209 / 30, not 210 / 30.
    const lastTimestamp = 209 / fps;
    const inFrame208 = lastTimestamp - 0.01;
    expect(frameAt(inFrame208, fps)).toBe(208);
    expect(frameAt(stepFrames(inFrame208, fps, frames, 1), fps)).toBe(209);
    // A count taken from that duration would stop one frame early.
    expect(frameCount(lastTimestamp, fps)).toBe(209);
  });

  test("a larger step moves that many frames", () => {
    expect(frameAt(stepFrames(1, fps, frames, 30), fps)).toBe(60);
    expect(frameAt(stepFrames(1, fps, frames, -30), fps)).toBe(0);
  });
});

describe("frameCount", () => {
  test("counts the frames of an episode", () => {
    expect(frameCount(7, 30)).toBe(210);
    expect(frameCount(1.5, 30)).toBe(45);
    expect(frameCount(0, 30)).toBe(1);
  });
});

describe("formatClock", () => {
  test("minutes, seconds and hundredths", () => {
    expect(formatClock(0)).toBe("0:00.00");
    expect(formatClock(5.333)).toBe("0:05.33");
    expect(formatClock(65.5)).toBe("1:05.50");
  });

  test("rolls over cleanly instead of showing 60 seconds", () => {
    expect(formatClock(59.999)).toBe("1:00.00");
    expect(formatClock(3599.999)).toBe("1:00:00.00");
  });

  test("hours appear only when needed", () => {
    expect(formatClock(3725.25)).toBe("1:02:05.25");
  });

  test("negative and non-finite times read as zero", () => {
    expect(formatClock(-3)).toBe("0:00.00");
    expect(formatClock(NaN)).toBe("0:00.00");
  });
});

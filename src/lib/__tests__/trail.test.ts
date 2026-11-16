import { describe, expect, test } from "bun:test";
import {
  ribbonArrays,
  smoothPath,
  subdivisionsFor,
  tipSide,
} from "@/lib/trail";

/** One xyz sample per frame. */
const samples = (...points: [number, number, number][]) =>
  new Float32Array(points.flat());

const pointAt = (path: { points: Float32Array }, i: number) =>
  Array.from(path.points.slice(i * 3, i * 3 + 3));

describe("smoothPath", () => {
  test("passes through every frame's sample, at that frame", () => {
    const frames: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 1, 0],
      [2, 2, 1],
      [1, 3, 1],
    ];
    const path = smoothPath(samples(...frames), 4);

    // Four points per step: every fourth one is a frame's own sample.
    expect(path.count).toBe(4 * 4 + 1);
    frames.forEach((frame, k) => {
      expect(path.along[k * 4]).toBe(k);
      pointAt(path, k * 4).forEach((v, c) =>
        expect(v).toBeCloseTo(frame[c], 5),
      );
    });
  });

  test("the frame index never decreases along the path", () => {
    const frames: [number, number, number][] = Array.from(
      { length: 50 },
      (_, k) => [Math.sin(k / 5), Math.cos(k / 7), k / 50],
    );
    const { along, count } = smoothPath(samples(...frames), 3);

    for (let i = 1; i < count; i++) {
      expect(along[i]).toBeGreaterThan(along[i - 1]);
    }
    expect(along[count - 1]).toBe(49);
  });

  test("stays between its samples on a straight line (no overshoot)", () => {
    // Uneven steps along x: a uniform Catmull–Rom would swing back past a sample here.
    const xs = [0, 0.01, 0.02, 1, 1.01, 2];
    const path = smoothPath(
      samples(...xs.map((x) => [x, 0, 0] as [number, number, number])),
      4,
    );

    for (let i = 1; i < path.count; i++) {
      expect(path.points[i * 3]).toBeGreaterThanOrEqual(
        path.points[(i - 1) * 3] - 1e-6,
      );
      expect(Math.abs(path.points[i * 3 + 1])).toBeLessThan(1e-6);
    }
  });

  test("a stretch where the robot holds still is two points, at its first and last frame", () => {
    const path = smoothPath(
      samples([0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [2, 0, 0]),
      1,
    );

    expect(Array.from(path.along)).toEqual([0, 1, 4, 5]);
    expect(pointAt(path, 1)).toEqual(pointAt(path, 2));
  });

  test("the motion after a pause happens on the step it was recorded on", () => {
    // Still from frame 1 to 9, then a move: the curve to the next place is drawn between frames
    // 9 and 10, not spread over the pause (which would show the move before it happened).
    const frames: [number, number, number][] = [[0, 0, 0]];
    for (let k = 1; k <= 9; k++) frames.push([1, 0, 0]);
    frames.push([2, 0, 0]);
    const path = smoothPath(samples(...frames), 4);

    const moving = Array.from(path.along).filter((a) => a > 9 && a < 10);
    expect(moving).toEqual([9.25, 9.5, 9.75]);
  });

  test("skips frames whose sample is missing", () => {
    const path = smoothPath(
      samples([0, 0, 0], [Number.NaN, 0, 0], [2, 0, 0]),
      1,
    );

    expect(path.count).toBe(2);
    expect(Array.from(path.along)).toEqual([0, 2]);
  });

  test("a still robot is one point, and an empty episode none", () => {
    expect(smoothPath(samples([1, 2, 3], [1, 2, 3], [1, 2, 3]), 4).count).toBe(
      2,
    );
    expect(smoothPath(samples([1, 2, 3]), 4).count).toBe(1);
    expect(smoothPath(new Float32Array(0), 4).count).toBe(0);
  });
});

describe("subdivisionsFor", () => {
  test("smooth for short episodes, cheaper for long ones", () => {
    expect(subdivisionsFor(300)).toBe(4);
    expect(subdivisionsFor(8_000)).toBe(3);
    expect(subdivisionsFor(30_000)).toBe(1);
    expect(subdivisionsFor(0)).toBe(4);
  });
});

describe("ribbonArrays", () => {
  test("two vertices per point, two triangles per segment", () => {
    const path = smoothPath(samples([0, 0, 0], [1, 0, 0], [2, 1, 0]), 1);
    const ribbon = ribbonArrays(path);

    expect(ribbon.position.length).toBe(3 * 2 * 3);
    expect(Array.from(ribbon.side)).toEqual([-1, 1, -1, 1, -1, 1]);
    expect(Array.from(ribbon.along)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(Array.from(ribbon.index)).toEqual([
      0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5,
    ]);
  });

  test("each vertex knows its neighbours; the ends repeat their own point", () => {
    const path = smoothPath(samples([0, 0, 0], [1, 0, 0], [2, 1, 0]), 1);
    const { previous, next } = ribbonArrays(path);
    const vec = (a: Float32Array, v: number) =>
      Array.from(a.slice(v * 3, v * 3 + 3));

    expect(vec(previous, 0)).toEqual([0, 0, 0]);
    expect(vec(next, 0)).toEqual([1, 0, 0]);
    expect(vec(previous, 2)).toEqual([0, 0, 0]);
    expect(vec(next, 2)).toEqual([2, 1, 0]);
    expect(vec(next, 5)).toEqual([2, 1, 0]);
  });

  test("an empty path makes an empty ribbon", () => {
    const ribbon = ribbonArrays(smoothPath(new Float32Array(0), 4));
    expect(ribbon.position.length).toBe(0);
    expect(ribbon.index.length).toBe(0);
  });
});

describe("tipSide", () => {
  test("reads the side from the prim's name", () => {
    expect(tipSide("/robot/openarm_left_hand_tcp")).toBe("left");
    expect(tipSide("/g1/right_hand_palm_link")).toBe("right");
    expect(tipSide("/g1/L_hand_base_link")).toBe("left");
    expect(tipSide("/g1/R_hand_base_link")).toBe("right");
    expect(tipSide("/so101/gripper_frame_link")).toBeNull();
    // Not fooled by a word that merely contains the letters.
    expect(tipSide("/robot/lower_link")).toBeNull();
  });
});

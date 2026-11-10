import { describe, expect, test } from "bun:test";
import { niceTicks } from "../charts";

describe("niceTicks", () => {
  test("covers the maximum with round steps", () => {
    expect(niceTicks(44, 3)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(9, 3)).toEqual([0, 5, 10]);
    expect(niceTicks(3, 3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(1200, 4)).toEqual([0, 500, 1000, 1500]);
  });

  test("keeps fractional steps free of rounding noise", () => {
    expect(niceTicks(0.3, 3)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceTicks(1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  test("the last tick is never below the maximum", () => {
    for (const max of [1, 7, 13, 44, 99, 101, 250, 0.07, 3.3]) {
      const ticks = niceTicks(max, 3);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
    }
  });

  test("nothing to count gives a lone zero", () => {
    expect(niceTicks(0, 3)).toEqual([0]);
  });
});

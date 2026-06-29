import { describe, expect, test } from "bun:test";
import { VIRIDIS_LUT, viridisColor, isGrayscaleShape } from "@/utils/colormaps";

describe("VIRIDIS_LUT", () => {
  test("has 256 RGB entries (768 values)", () => {
    expect(VIRIDIS_LUT.length).toBe(256 * 3);
  });

  test("all channel values are in 0..255", () => {
    for (const v of VIRIDIS_LUT) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  test("endpoints match matplotlib viridis (dark purple -> yellow)", () => {
    expect([VIRIDIS_LUT[0], VIRIDIS_LUT[1], VIRIDIS_LUT[2]]).toEqual([
      68, 1, 84,
    ]);
    expect([VIRIDIS_LUT[765], VIRIDIS_LUT[766], VIRIDIS_LUT[767]]).toEqual([
      253, 231, 37,
    ]);
  });
});

describe("viridisColor", () => {
  test("maps 0 to the first LUT entry", () => {
    expect(viridisColor(0)).toEqual([68, 1, 84]);
  });

  test("maps 1 to the last LUT entry", () => {
    expect(viridisColor(1)).toEqual([253, 231, 37]);
  });

  test("clamps out-of-range inputs", () => {
    expect(viridisColor(-5)).toEqual([68, 1, 84]);
    expect(viridisColor(99)).toEqual([253, 231, 37]);
  });
});

describe("isGrayscaleShape", () => {
  test("treats channel count 1 as grayscale", () => {
    expect(isGrayscaleShape([256, 256, 1])).toBe(true);
  });

  test("treats 3-channel (RGB) as not grayscale", () => {
    expect(isGrayscaleShape([256, 256, 3])).toBe(false);
  });

  test("is false when there is no channel dimension", () => {
    expect(isGrayscaleShape([256, 256])).toBe(false);
    expect(isGrayscaleShape(undefined)).toBe(false);
  });
});

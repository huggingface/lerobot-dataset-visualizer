import { describe, expect, test } from "bun:test";
import {
  VIRIDIS_LUT,
  viridisColor,
  isGrayscaleShape,
  depthColormapRange,
  depthEncodingFromFeature,
} from "@/utils/colormaps";

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

describe("depthColormapRange", () => {
  test("reads q10/q90 from lerobot's nested [[[v]]] image-stat shape", () => {
    expect(depthColormapRange({ q10: [[[0.2]]], q90: [[[0.8]]] })).toEqual([
      0.2, 0.8,
    ]);
  });

  test("reads scalar q10/q90", () => {
    expect(depthColormapRange({ q10: 0.1, q90: 0.9 })).toEqual([0.1, 0.9]);
  });

  test("is undefined when q10 or q90 is missing", () => {
    expect(depthColormapRange({ q90: [[[0.8]]] })).toBeUndefined();
    expect(depthColormapRange({})).toBeUndefined();
    expect(depthColormapRange(undefined)).toBeUndefined();
  });

  test("is undefined for a degenerate range (q90 <= q10)", () => {
    expect(depthColormapRange({ q10: 0.8, q90: 0.8 })).toBeUndefined();
    expect(depthColormapRange({ q10: 0.9, q90: 0.2 })).toBeUndefined();
  });

  test("is undefined for non-finite values", () => {
    expect(
      depthColormapRange({ q10: [[[NaN]]], q90: [[[0.8]]] }),
    ).toBeUndefined();
  });

  test("maps a depth feed's mm q10/q90 through the log quantization", () => {
    // Real CarolinePascal/depth_dataset_video stats (mm) + info.json params.
    const [low, high] = depthColormapRange(
      { q10: [[[0.0]]], q90: [[[801.7945796579397]]] },
      { depthMin: 0.01, depthMax: 10.0, shift: 3.5, useLog: true },
    )!;
    // q90 > depth_max ⇒ treated as mm; matches lerobot quantize_depth code.
    expect(low).toBeCloseTo(0, 5);
    expect(high).toBeCloseTo(0.151006, 4);
  });

  test("uses linear quantization when use_log is false", () => {
    // metric q10/q90 (≤ depth_max) stay in metres; (d-min)/(max-min).
    expect(
      depthColormapRange(
        { q10: 1, q90: 6 },
        { depthMin: 0, depthMax: 10, shift: 0, useLog: false },
      ),
    ).toEqual([0.1, 0.6]);
  });
});

describe("depthEncodingFromFeature", () => {
  const depthInfo = {
    is_depth_map: true,
    "video.depth_min": 0.01,
    "video.depth_max": 10.0,
    "video.shift": 3.5,
    "video.use_log": true,
  };

  test("extracts params from a depth-map feature", () => {
    expect(depthEncodingFromFeature({ info: depthInfo })).toEqual({
      depthMin: 0.01,
      depthMax: 10.0,
      shift: 3.5,
      useLog: true,
    });
  });

  test("is undefined for non-depth feeds or missing/invalid params", () => {
    expect(
      depthEncodingFromFeature({ info: { ...depthInfo, is_depth_map: false } }),
    ).toBeUndefined();
    expect(
      depthEncodingFromFeature({ info: { is_depth_map: true } }),
    ).toBeUndefined();
    expect(depthEncodingFromFeature({})).toBeUndefined();
    expect(depthEncodingFromFeature(undefined)).toBeUndefined();
    // log requires depth_min + shift > 0
    expect(
      depthEncodingFromFeature({
        info: { ...depthInfo, "video.depth_min": -5, "video.shift": 1 },
      }),
    ).toBeUndefined();
  });
});

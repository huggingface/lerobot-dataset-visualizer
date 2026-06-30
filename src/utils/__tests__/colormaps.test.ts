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
  const LINEAR = {
    depthMin: 0,
    depthMax: 10,
    shift: 0,
    useLog: false,
    unitToMetres: 1,
  };

  test("reads lerobot's nested [[[v]]] image-stat shape", () => {
    expect(depthColormapRange({ q01: [[[2]]], q99: [[[8]]] }, LINEAR)).toEqual([
      0.2, 0.8,
    ]);
  });

  test("rescales stats when unitToMetres marks them as millimetres", () => {
    expect(
      depthColormapRange(
        { q01: [[[2000]]], q99: [[[8000]]] },
        { ...LINEAR, unitToMetres: 1 / 1000 },
      ),
    ).toEqual([0.2, 0.8]);
  });

  test("falls back to min/max when a quantile is absent", () => {
    expect(depthColormapRange({ min: [[[1]]], max: [[[6]]] }, LINEAR)).toEqual([
      0.1, 0.6,
    ]);
  });

  test("is undefined when bounds are missing", () => {
    expect(depthColormapRange({ q99: [[[8]]] }, LINEAR)).toBeUndefined();
    expect(depthColormapRange({}, LINEAR)).toBeUndefined();
    expect(depthColormapRange(undefined, LINEAR)).toBeUndefined();
  });

  test("is undefined for a degenerate band (q99 <= q01)", () => {
    expect(depthColormapRange({ q01: 5, q99: 5 }, LINEAR)).toBeUndefined();
    expect(depthColormapRange({ q01: 8, q99: 2 }, LINEAR)).toBeUndefined();
  });

  test("is undefined for non-finite values", () => {
    expect(
      depthColormapRange({ q01: [[[NaN]]], q99: [[[8]]] }, LINEAR),
    ).toBeUndefined();
  });

  test("maps a depth feed's mm q01/q99 through the log quantization", () => {
    // Real CarolinePascal/depth_dataset_video stats (mm) + info.json params.
    const [low, high] = depthColormapRange(
      { q01: [[[0.0]]], q99: [[[801.7945796579397]]] },
      {
        depthMin: 0.01,
        depthMax: 10.0,
        shift: 3.5,
        useLog: true,
        unitToMetres: 1 / 1000,
      },
    )!;
    expect(low).toBeCloseTo(0, 5);
    expect(high).toBeCloseTo(0.151006, 4);
  });

  test("uses linear quantization when use_log is false", () => {
    // (d - min) / (max - min) with stats used as-is.
    expect(depthColormapRange({ q01: 1, q99: 6 }, LINEAR)).toEqual([0.1, 0.6]);
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

  test("extracts params; without depth_unit the stats are used as-is", () => {
    expect(depthEncodingFromFeature({ info: depthInfo })).toEqual({
      depthMin: 0.01,
      depthMax: 10.0,
      shift: 3.5,
      useLog: true,
      unitToMetres: 1,
    });
  });

  test("reads depth_unit to set the metres conversion", () => {
    expect(
      depthEncodingFromFeature({ info: { ...depthInfo, depth_unit: "m" } })
        ?.unitToMetres,
    ).toBe(1);
    expect(
      depthEncodingFromFeature({ info: { ...depthInfo, depth_unit: "mm" } })
        ?.unitToMetres,
    ).toBe(1 / 1000);
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

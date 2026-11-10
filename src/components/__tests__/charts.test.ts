import { describe, expect, test } from "bun:test";
import {
  niceTicks,
  roundBinIndex,
  roundBins,
  sequentialColor,
  seriesStyle,
} from "../charts";

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

describe("roundBins", () => {
  test("edges are round and every value is counted once", () => {
    const values = [0.495, 2.1, 3.7, 4.2, 4.5, 4.9, 5.3, 6.9, 13.4];
    const bins = roundBins(values, 9);

    expect(bins.map((b) => b.lo)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(bins[bins.length - 1].hi).toBe(14);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(values.length);
    for (const value of values) {
      const bin = bins[roundBinIndex(value, bins)];
      expect(value).toBeGreaterThanOrEqual(bin.lo);
      expect(value).toBeLessThan(bin.hi);
    }
  });

  test("a largest value on a bin edge still has a bin", () => {
    const bins = roundBins([0, 1, 2, 3, 4], 4);
    expect(bins[bins.length - 1].hi).toBeGreaterThan(4);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(5);
  });

  test("small fractional values keep clean edges", () => {
    const bins = roundBins([0.0521, 0.0563, 0.0612, 0.0641, 0.0729], 10);
    for (const bin of bins) {
      expect(String(bin.lo).length).toBeLessThan(8);
    }
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(5);
  });

  test("identical values make one bin, no values none", () => {
    expect(roundBins([3, 3, 3], 10)).toEqual([{ lo: 3, hi: 3, count: 3 }]);
    expect(roundBins([], 10)).toEqual([]);
  });
});

describe("seriesStyle", () => {
  test("eight hues in order, then the same hues dashed, then muted", () => {
    expect(seriesStyle(0)).toEqual({
      color: "var(--series-1)",
      dash: undefined,
    });
    expect(seriesStyle(7).color).toBe("var(--series-8)");
    expect(seriesStyle(8)).toEqual({ color: "var(--series-1)", dash: "6 4" });
    expect(seriesStyle(15).color).toBe("var(--series-8)");
    expect(seriesStyle(16).color).toBe("var(--fg-faint)");
  });

  test("no two of the first sixteen series look the same", () => {
    const looks = Array.from({ length: 16 }, (_, i) => {
      const { color, dash } = seriesStyle(i);
      return `${color}/${dash ?? "solid"}`;
    });
    expect(new Set(looks).size).toBe(16);
  });
});

describe("sequentialColor", () => {
  const luminance = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  test("zero is the step nearest the surface in each theme", () => {
    // Pale on a light page, deep on a dark one.
    expect(luminance(sequentialColor(0, "light"))).toBeGreaterThan(200);
    expect(luminance(sequentialColor(0, "dark"))).toBeLessThan(70);
  });

  test("grows steadily away from the surface", () => {
    for (const theme of ["light", "dark"] as const) {
      const steps = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) =>
        luminance(sequentialColor(t, theme)),
      );
      for (let i = 1; i < steps.length; i++) {
        if (theme === "light") expect(steps[i]).toBeLessThan(steps[i - 1]);
        else expect(steps[i]).toBeGreaterThan(steps[i - 1]);
      }
    }
  });

  test("values outside 0 to 1, and NaN, are clamped", () => {
    expect(sequentialColor(-3, "light")).toBe(sequentialColor(0, "light"));
    expect(sequentialColor(7, "light")).toBe(sequentialColor(1, "light"));
    expect(sequentialColor(NaN, "dark")).toBe(sequentialColor(0, "dark"));
  });
});

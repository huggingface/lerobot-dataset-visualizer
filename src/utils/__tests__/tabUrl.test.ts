import { describe, expect, test } from "bun:test";
import { searchWithTab } from "@/utils/tabUrl";

describe("searchWithTab", () => {
  test("names a non-default tab", () => {
    expect(searchWithTab("", "filtering", "episodes")).toBe("?tab=filtering");
  });

  test("leaves the default tab out", () => {
    expect(searchWithTab("?tab=filtering", "episodes", "episodes")).toBe("");
  });

  test("keeps the other parameters", () => {
    expect(searchWithTab("?t=12&__theme=dark", "frames", "episodes")).toBe(
      "?t=12&__theme=dark&tab=frames",
    );
    expect(searchWithTab("?t=12&tab=frames", "episodes", "episodes")).toBe(
      "?t=12",
    );
  });

  test("replaces a stale tab, including the legacy 3D Replay id", () => {
    expect(searchWithTab("?tab=urdf", "replay", "episodes")).toBe(
      "?tab=replay",
    );
  });
});

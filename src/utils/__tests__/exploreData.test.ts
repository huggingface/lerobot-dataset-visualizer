import { describe, expect, test } from "bun:test";
import { compactDataset, parseNextCursor } from "@/utils/exploreData";

describe("parseNextCursor", () => {
  test("null / empty → null", () => {
    expect(parseNextCursor(null)).toBeNull();
    expect(parseNextCursor("")).toBeNull();
  });
  test("extracts the rel=next url", () => {
    const header =
      '<https://huggingface.co/api/datasets?filter=LeRobot&cursor=ABC123>; rel="next"';
    expect(parseNextCursor(header)).toBe(
      "https://huggingface.co/api/datasets?filter=LeRobot&cursor=ABC123",
    );
  });
  test("ignores prev, picks next among multiple", () => {
    const header = '<https://x/prev>; rel="prev", <https://x/next>; rel="next"';
    expect(parseNextCursor(header)).toBe("https://x/next");
  });
  test("handles unquoted rel", () => {
    expect(parseNextCursor("<https://x/n>; rel=next")).toBe("https://x/n");
  });
  test("returns null when only prev present", () => {
    expect(parseNextCursor('<https://x/prev>; rel="prev"')).toBeNull();
  });
});

describe("compactDataset", () => {
  test("license precedence: cardData string", () => {
    expect(
      compactDataset({ id: "a/b", cardData: { license: "mit" }, tags: [] })
        .license,
    ).toBe("mit");
  });
  test("license: cardData array → first", () => {
    expect(
      compactDataset({
        id: "a/b",
        cardData: { license: ["apache-2.0", "mit"] },
        tags: [],
      }).license,
    ).toBe("apache-2.0");
  });
  test("license: falls back to license:* tag", () => {
    expect(
      compactDataset({ id: "a/b", tags: ["license:cc-by-4.0", "robotics"] })
        .license,
    ).toBe("cc-by-4.0");
  });
  test("license null when absent", () => {
    expect(
      compactDataset({ id: "a/b", tags: ["robotics"] }).license,
    ).toBeNull();
  });

  test("sizeBytes from mainSize, else null", () => {
    expect(compactDataset({ id: "a/b", mainSize: 12345 }).sizeBytes).toBe(
      12345,
    );
    expect(compactDataset({ id: "a/b" }).sizeBytes).toBeNull();
  });

  test("robotTags: canonical keys, deduped, structured tags dropped", () => {
    const out = compactDataset({
      id: "a/b",
      tags: [
        "so100",
        "so100_stereo", // → also so100
        "SO-101", // → so101 (case-insensitive)
        "task_categories:robotics", // structured → dropped
        "license:mit", // structured → dropped
      ],
    });
    expect(out.robotTags.sort()).toEqual(["so100", "so101"]);
  });

  test("freeTags: lowercased, excludes robots/structured/stopwords", () => {
    const out = compactDataset({
      id: "a/b",
      tags: [
        "Manipulation",
        "LeRobot", // stopword
        "robotics", // stopword
        "so100", // robot → excluded from freeTags
        "modality:video", // structured → dropped
        "tutorial",
      ],
    });
    expect(out.freeTags.sort()).toEqual(["manipulation", "tutorial"]);
    expect(out.robotTags).toEqual(["so100"]);
  });

  test("downloads/likes default to 0", () => {
    const out = compactDataset({ id: "a/b" });
    expect(out.downloads).toBe(0);
    expect(out.likes).toBe(0);
  });
});

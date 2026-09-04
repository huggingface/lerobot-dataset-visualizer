import { describe, expect, test } from "bun:test";
import {
  buildDatasetId,
  buildDatasetRoute,
  buildHuggingFaceDatasetPageUrl,
  joinDatasetPath,
  parseDatasetSource,
} from "@/utils/datasetSource";

describe("datasetSource", () => {
  test("keeps a root-level Hugging Face dataset on the existing route", () => {
    expect(buildDatasetRoute("lerobot/pusht")).toBe("/lerobot/pusht/episode_0");
  });

  test("round-trips a Hugging Face dataset with a subdirectory", () => {
    const route = buildDatasetRoute(
      "simple-world-lab/HiFi-UMI-2K/chunk-0000/part-0000",
      3,
    );
    expect(route).toBe(
      "/_hf/simple-world-lab%2FHiFi-UMI-2K%2Fchunk-0000%2Fpart-0000/episode_3",
    );
    expect(
      buildDatasetId(
        "_hf",
        "simple-world-lab%2FHiFi-UMI-2K%2Fchunk-0000%2Fpart-0000",
      ),
    ).toBe("simple-world-lab/HiFi-UMI-2K/chunk-0000/part-0000");
  });

  test("accepts a copied Hugging Face tree URL", () => {
    expect(
      buildDatasetRoute(
        "https://huggingface.co/datasets/simple-world-lab/HiFi-UMI-2K/tree/main/chunk-0000/part-0000",
      ),
    ).toContain("simple-world-lab%2FHiFi-UMI-2K%2Fchunk-0000%2Fpart-0000");
  });

  test("round-trips an absolute local path", () => {
    const route = buildDatasetRoute("/data/lerobot/demo/");
    expect(route).toBe("/_local/%2Fdata%2Flerobot%2Fdemo/episode_0");
    expect(buildDatasetId("_local", "%2Fdata%2Flerobot%2Fdemo")).toBe(
      "local:/data/lerobot/demo",
    );
  });

  test("prefixes every dataset file with the HF subdirectory", () => {
    const id = "simple-world-lab/HiFi-UMI-2K/chunk-0000/part-0000";
    expect(joinDatasetPath(id, "meta/info.json")).toBe(
      "chunk-0000/part-0000/meta/info.json",
    );
  });

  test("builds the matching Hub tree page", () => {
    expect(
      buildHuggingFaceDatasetPageUrl(
        "simple-world-lab/HiFi-UMI-2K/chunk-0000/part-0000",
      ),
    ).toBe(
      "https://huggingface.co/datasets/simple-world-lab/HiFi-UMI-2K/tree/main/chunk-0000/part-0000",
    );
  });

  test("rejects traversal in a subdirectory", () => {
    expect(() => parseDatasetSource("org/repo/../secret")).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildDatasetId,
  buildDatasetRoute,
  buildLocalDatasetAssetUrl,
  decodeLocalDatasetPath,
  encodeLocalDatasetPath,
  getDatasetDisplayName,
  getLocalDatasetPath,
  isLikelyLocalDatasetInput,
  isLocalDatasetId,
  parseLocalDatasetUrl,
} from "@/utils/datasetSource";

describe("datasetSource local path handling", () => {
  test("detects local dataset path inputs", () => {
    expect(isLikelyLocalDatasetInput("/data/aloha")).toBe(true);
    expect(isLikelyLocalDatasetInput("~/data/aloha")).toBe(true);
    expect(isLikelyLocalDatasetInput("file:///tmp/aloha")).toBe(true);
    expect(isLikelyLocalDatasetInput("./data/aloha")).toBe(false);
    expect(isLikelyLocalDatasetInput("../data/aloha")).toBe(false);
    expect(isLikelyLocalDatasetInput("lerobot/aloha_static_cups_open")).toBe(
      false,
    );
  });

  test("encodes and decodes local dataset paths for routing", () => {
    const encoded = encodeLocalDatasetPath("~/data/aloha_static_cups_open/");
    expect(encoded).toBe("~%2Fdata%2Faloha_static_cups_open");
    expect(decodeLocalDatasetPath(encoded)).toBe(
      "~/data/aloha_static_cups_open",
    );
  });

  test("builds local dataset routes and ids", () => {
    const route = buildDatasetRoute("/tmp/aloha_static_cups_open", 7);
    expect(route).toBe("/local/%2Ftmp%2Faloha_static_cups_open/episode_7");

    const datasetId = buildDatasetId(
      "local",
      "%2Ftmp%2Faloha_static_cups_open",
    );
    expect(datasetId).toBe("local:/tmp/aloha_static_cups_open");
    expect(isLocalDatasetId(datasetId)).toBe(true);
    expect(getLocalDatasetPath(datasetId)).toBe("/tmp/aloha_static_cups_open");
    expect(getDatasetDisplayName(datasetId)).toBe(
      "/tmp/aloha_static_cups_open",
    );
  });

  test("builds and parses internal local asset urls", () => {
    const url = buildLocalDatasetAssetUrl("/tmp/aloha", "meta/info.json");
    expect(url).toBe(
      "/api/local-dataset/file?root=%2Ftmp%2Faloha&path=meta%2Finfo.json",
    );

    const parsed = parseLocalDatasetUrl(
      "local://dataset-file?root=%2Ftmp%2Faloha&path=videos%2Ftop.mp4",
    );
    expect(parsed).toEqual({
      root: "/tmp/aloha",
      path: "videos/top.mp4",
    });
  });
});

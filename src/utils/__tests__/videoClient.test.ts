import { describe, expect, test } from "bun:test";
import {
  parseHfDatasetUrl,
  buildTranscodeUrl,
  isLikelyDepthCamera,
} from "@/utils/videoClient";

describe("isLikelyDepthCamera", () => {
  test("matches depth camera keys", () => {
    expect(isLikelyDepthCamera("observation.images.top_depth")).toBe(true);
    expect(isLikelyDepthCamera("observation.images.wrist_depth")).toBe(true);
    expect(isLikelyDepthCamera("Depth_Camera")).toBe(true);
  });

  test("does not match regular camera keys", () => {
    expect(isLikelyDepthCamera("observation.images.wrist")).toBe(false);
    expect(isLikelyDepthCamera("observation.images.front")).toBe(false);
  });
});

describe("parseHfDatasetUrl", () => {
  test("parses a v3 segmented video URL", () => {
    const url =
      "https://huggingface.co/datasets/lerobot/svla_so101/resolve/main/videos/observation.images.front/chunk-000/file-000.mp4";
    expect(parseHfDatasetUrl(url)).toEqual({
      repoId: "lerobot/svla_so101",
      revision: "main",
      path: "videos/observation.images.front/chunk-000/file-000.mp4",
    });
  });

  test("parses a v2 per-episode video URL", () => {
    const url =
      "https://huggingface.co/datasets/org/ds/resolve/main/videos/chunk-000/observation.images.cam/episode_000042.mp4";
    expect(parseHfDatasetUrl(url)).toEqual({
      repoId: "org/ds",
      revision: "main",
      path: "videos/chunk-000/observation.images.cam/episode_000042.mp4",
    });
  });

  test("keeps a non-main revision", () => {
    const url =
      "https://huggingface.co/datasets/org/ds/resolve/v2.1/videos/x/file.mp4";
    expect(parseHfDatasetUrl(url)?.revision).toBe("v2.1");
  });

  test("returns null for an already-proxied same-origin path", () => {
    expect(
      parseHfDatasetUrl("/api/proxy/datasets/org/ds/resolve/main/x.mp4"),
    ).toBeNull();
  });

  test("returns null for a non-dataset HF URL", () => {
    expect(
      parseHfDatasetUrl("https://huggingface.co/org/ds/resolve/main/x.mp4"),
    ).toBeNull();
  });

  test("returns null for garbage input", () => {
    expect(parseHfDatasetUrl("not a url")).toBeNull();
  });
});

describe("buildTranscodeUrl", () => {
  const hfUrl =
    "https://huggingface.co/datasets/lerobot/depth/resolve/main/videos/observation.images.depth/chunk-000/file-000.mp4";

  test("builds the backend endpoint with query params", () => {
    const out = buildTranscodeUrl("http://127.0.0.1:7861", hfUrl);
    const parsed = new URL(out!);
    expect(parsed.origin).toBe("http://127.0.0.1:7861");
    expect(parsed.pathname).toBe("/api/video/transcode");
    expect(parsed.searchParams.get("repo_id")).toBe("lerobot/depth");
    expect(parsed.searchParams.get("revision")).toBe("main");
    expect(parsed.searchParams.get("path")).toBe(
      "videos/observation.images.depth/chunk-000/file-000.mp4",
    );
    expect(parsed.searchParams.has("hf_token")).toBe(false);
  });

  test("forwards an HF token when provided", () => {
    const out = buildTranscodeUrl("http://127.0.0.1:7861", hfUrl, "hf_abc123");
    expect(new URL(out!).searchParams.get("hf_token")).toBe("hf_abc123");
  });

  test("respects a backend base that includes a path prefix", () => {
    const out = buildTranscodeUrl("http://localhost:7861/", hfUrl);
    expect(new URL(out!).pathname).toBe("/api/video/transcode");
  });

  test("returns null when the HF URL can't be parsed", () => {
    expect(buildTranscodeUrl("http://127.0.0.1:7861", "not a url")).toBeNull();
  });
});

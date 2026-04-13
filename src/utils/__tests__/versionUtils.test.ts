import { describe, expect, test, mock, afterEach } from "bun:test";
import { buildVersionedUrl } from "@/utils/versionUtils";

// ---------------------------------------------------------------------------
// buildVersionedUrl — pure function, no mocking needed
// ---------------------------------------------------------------------------
describe("buildVersionedUrl", () => {
  test("builds URL for v2.0 dataset data path", () => {
    const url = buildVersionedUrl(
      "rabhishek100/so100_train_dataset",
      "v2.0",
      "data/000/episode_000000.parquet",
    );
    expect(url).toBe(
      "https://huggingface.co/datasets/rabhishek100/so100_train_dataset/resolve/main/data/000/episode_000000.parquet",
    );
  });

  test("builds URL for v2.1 dataset video path", () => {
    const url = buildVersionedUrl(
      "youliangtan/so101-table-cleanup",
      "v2.1",
      "videos/observation.images.top/chunk-000/episode_000007.mp4",
    );
    expect(url).toBe(
      "https://huggingface.co/datasets/youliangtan/so101-table-cleanup/resolve/main/videos/observation.images.top/chunk-000/episode_000007.mp4",
    );
  });

  test("builds URL for v3.0 episode metadata", () => {
    const url = buildVersionedUrl(
      "lerobot-data-collection/level12_rac_2_2026-02-07",
      "v3.0",
      "meta/episodes/chunk-000/file-000.parquet",
    );
    expect(url).toBe(
      "https://huggingface.co/datasets/lerobot-data-collection/level12_rac_2_2026-02-07/resolve/main/meta/episodes/chunk-000/file-000.parquet",
    );
  });

  test("builds URL for v3.0 data chunk", () => {
    const url = buildVersionedUrl(
      "lerobot-data-collection/level12_rac_2_2026-02-07",
      "v3.0",
      "data/chunk-001/file-003.parquet",
    );
    expect(url).toBe(
      "https://huggingface.co/datasets/lerobot-data-collection/level12_rac_2_2026-02-07/resolve/main/data/chunk-001/file-003.parquet",
    );
  });

  test("builds URL for meta/info.json", () => {
    const url = buildVersionedUrl("myorg/mydataset", "v3.0", "meta/info.json");
    expect(url).toBe(
      "https://huggingface.co/datasets/myorg/mydataset/resolve/main/meta/info.json",
    );
  });

  test("builds local dataset urls for server-side asset access", () => {
    const url = buildVersionedUrl(
      "local:/tmp/aloha_static_cups_open",
      "v3.0",
      "meta/info.json",
    );
    expect(url).toBe(
      "local://dataset-file?root=%2Ftmp%2Faloha_static_cups_open&path=meta%2Finfo.json",
    );
  });
});

// ---------------------------------------------------------------------------
// getDatasetVersionAndInfo — tested with mocked fetch
// ---------------------------------------------------------------------------
describe("getDatasetVersionAndInfo", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("accepts v2.0 codebase_version", async () => {
    const infoV20 = {
      codebase_version: "v2.0",
      robot_type: "so100",
      total_episodes: 50,
      total_frames: 5000,
      total_tasks: 1,
      chunks_size: 1000,
      data_files_size_in_mb: 10,
      video_files_size_in_mb: 500,
      fps: 30,
      splits: { train: "0:50" },
      data_path: "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": {
          dtype: "float32",
          shape: [1, 6],
          names: ["j0", "j1", "j2", "j3", "j4", "j5"],
        },
        action: {
          dtype: "float32",
          shape: [1, 6],
          names: ["j0", "j1", "j2", "j3", "j4", "j5"],
        },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV20), { status: 200 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      "rabhishek100/so100_train_dataset",
    );
    expect(result.version).toBe("v2.0");
    expect(result.info.total_episodes).toBe(50);
  });

  test("accepts v2.1 codebase_version", async () => {
    const infoV21 = {
      codebase_version: "v2.1",
      robot_type: "so101",
      total_episodes: 100,
      total_frames: 10000,
      total_tasks: 1,
      chunks_size: 1000,
      data_files_size_in_mb: 20,
      video_files_size_in_mb: 1000,
      fps: 30,
      splits: { train: "0:100" },
      data_path: "data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": { dtype: "float32", shape: [1, 6], names: null },
        action: { dtype: "float32", shape: [1, 6], names: null },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV21), { status: 200 })),
    ) as unknown as typeof fetch;

    // Use fresh import to bypass cache — or just call with a different repoId
    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      "youliangtan/so101-table-cleanup",
    );
    expect(result.version).toBe("v2.1");
  });

  test("accepts v3.0 codebase_version", async () => {
    const infoV30 = {
      codebase_version: "v3.0",
      robot_type: "openarm",
      total_episodes: 200,
      total_frames: 40000,
      total_tasks: 1,
      chunks_size: 100,
      data_files_size_in_mb: 50,
      video_files_size_in_mb: 2000,
      fps: 50,
      splits: { train: "0:200" },
      data_path: null,
      video_path: null,
      features: {
        "observation.images.top": {
          dtype: "video",
          shape: [480, 640, 3],
          names: null,
        },
        "observation.state": { dtype: "float32", shape: [1, 14], names: null },
        action: { dtype: "float32", shape: [1, 14], names: null },
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(infoV30), { status: 200 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    const result = await getDatasetVersionAndInfo(
      "lerobot-data-collection/level12_rac_2_2026-02-07",
    );
    expect(result.version).toBe("v3.0");
    expect(result.info.total_episodes).toBe(200);
  });

  test("throws for unsupported version", async () => {
    const infoUnsupported = {
      codebase_version: "v1.0",
      features: { dummy: { dtype: "float32", shape: [1], names: null } },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(infoUnsupported), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(getDatasetVersionAndInfo("old/dataset")).rejects.toThrow(
      "not supported",
    );
  });

  test("throws when info.json has no features field", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ codebase_version: "v3.0" }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(getDatasetVersionAndInfo("broken/dataset")).rejects.toThrow();
  });

  test("throws when fetch fails (network error)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const { getDatasetVersionAndInfo } = await import("@/utils/versionUtils");
    await expect(
      getDatasetVersionAndInfo("nonexistent/repo"),
    ).rejects.toThrow();
  });
});

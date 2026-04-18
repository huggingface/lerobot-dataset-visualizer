import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET, HEAD } from "../route";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

async function createDatasetDir(): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "lerobot-local-route-"));
  await mkdir(path.join(tempRoot, "meta"), { recursive: true });
  await mkdir(path.join(tempRoot, "videos"), { recursive: true });
  return tempRoot;
}

describe("local dataset file route", () => {
  test("serves local files from inside the dataset root", async () => {
    const root = await createDatasetDir();
    await writeFile(path.join(root, "meta", "info.json"), '{"ok":true}');

    const request = new Request(
      `http://localhost/api/local-dataset/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent("meta/info.json")}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"ok":true}');
  });

  test("blocks path traversal outside the dataset root", async () => {
    const root = await createDatasetDir();

    const request = new Request(
      `http://localhost/api/local-dataset/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent("../secret.txt")}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("outside the dataset directory");
  });

  test("supports ranged HEAD requests for local video files", async () => {
    const root = await createDatasetDir();
    await writeFile(
      path.join(root, "videos", "episode.mp4"),
      Buffer.from("0123456789"),
    );

    const request = new Request(
      `http://localhost/api/local-dataset/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent("videos/episode.mp4")}`,
      {
        method: "HEAD",
        headers: { range: "bytes=2-5" },
      },
    );
    const response = await HEAD(request);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET, HEAD } from "../route";

const tempRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lerobot-viz-route-"));
  tempRoots.push(root);
  await writeFile(path.join(root, "video.mp4"), Buffer.from("0123456789"));
  return root;
}

function request(root: string, range?: string) {
  const params = new URLSearchParams({ root, path: "video.mp4" });
  return new Request(`http://localhost/api/local-dataset/file?${params}`, {
    headers: range ? { range } : undefined,
  });
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local dataset file route", () => {
  test("streams a complete local file", async () => {
    const root = await fixture();
    const response = await GET(request(root));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("0123456789");
  });

  test("supports bounded and suffix byte ranges", async () => {
    const root = await fixture();
    const bounded = await GET(request(root, "bytes=2-5"));
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await bounded.text()).toBe("2345");

    const suffix = await GET(request(root, "bytes=-3"));
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");
  });

  test("returns headers without a body for HEAD", async () => {
    const root = await fixture();
    const response = await HEAD(request(root, "bytes=1-3"));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("3");
    expect(await response.text()).toBe("");
  });

  test("rejects files outside the selected root", async () => {
    const root = await fixture();
    const params = new URLSearchParams({ root, path: "../outside.mp4" });
    const response = await GET(
      new Request(`http://localhost/api/local-dataset/file?${params}`),
    );
    expect([403, 404]).toContain(response.status);
  });
});

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join, resolve, sep } from "path";

const LOCAL_DATASET_PATH = process.env.LOCAL_DATASET_PATH;

const EXT_CONTENT_TYPE: Record<string, string> = {
  json: "application/json",
  jsonl: "application/x-ndjson",
  parquet: "application/octet-stream",
  mp4: "video/mp4",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  if (!LOCAL_DATASET_PATH) {
    return NextResponse.json(
      { error: "Local dataset mode not enabled" },
      { status: 404 },
    );
  }

  const pathSegments = (await params).path;

  // Validate: all segments must be safe (no ".." or absolute paths)
  if (pathSegments.some((s) => s === ".." || s.startsWith("/"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const base = resolve(process.cwd(), LOCAL_DATASET_PATH);
  const target = resolve(join(base, ...pathSegments));

  // Secondary path-traversal guard
  const normalizedBase = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(normalizedBase) && target !== base) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(target);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = target.split(".").pop()?.toLowerCase() ?? "";
  const contentType = EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";

  // Support HTTP range requests so browsers can seek in video files
  const rangeHeader = request.headers.get("range");
  if (contentType === "video/mp4" && rangeHeader) {
    const total = buffer.length;
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const safeEnd = Math.min(end, total - 1);
      const chunk = new Uint8Array(buffer).subarray(start, safeEnd + 1);
      return new NextResponse(chunk.buffer as ArrayBuffer, {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes ${start}-${safeEnd}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.length),
        },
      });
    }
  }

  const bytes = new Uint8Array(buffer);
  return new NextResponse(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(buffer.length),
    },
  });
}

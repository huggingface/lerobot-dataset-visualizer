import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function expandLocalRoot(input: string): string {
  const withoutProtocol = input.replace(/^file:\/\//, "");
  if (withoutProtocol === "~") return process.env.HOME ?? withoutProtocol;
  if (withoutProtocol.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", withoutProtocol.slice(2));
  }
  return withoutProtocol;
}

async function resolveDatasetFile(root: string, relativePath: string) {
  const normalizedRoot = path.resolve(expandLocalRoot(root));
  const target = path.resolve(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the dataset directory");
  }
  return target;
}

function contentType(filePath: string): string {
  const types: Record<string, string> = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".mp4": "video/mp4",
    ".parquet": "application/octet-stream",
    ".webm": "video/webm",
  };
  return (
    types[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

function webStream(filePath: string, start?: number, end?: number) {
  return Readable.toWeb(
    createReadStream(filePath, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;
}

function parseRange(value: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }

  if (start < 0 || start >= size || end < start) return null;
  return [start, Math.min(end, size - 1)];
}

async function respond(request: Request, includeBody: boolean) {
  const params = new URL(request.url).searchParams;
  const root = params.get("root");
  const relativePath = params.get("path");
  if (!root || !relativePath) {
    return new Response("Missing root or path parameter", { status: 400 });
  }

  let filePath: string;
  try {
    filePath = await resolveDatasetFile(root, relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid path";
    return new Response(
      message.includes("outside") ? message : "File not found",
      {
        status: message.includes("outside") ? 403 : 404,
      },
    );
  }

  const stats = await fs.stat(filePath);
  if (!stats.isFile()) return new Response("Not a file", { status: 400 });

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(stats.size),
    "content-type": contentType(filePath),
  });
  const requestedRange = request.headers.get("range");
  if (!requestedRange) {
    return new Response(includeBody ? webStream(filePath) : null, {
      status: 200,
      headers,
    });
  }

  const range = parseRange(requestedRange, stats.size);
  if (!range) {
    headers.set("content-range", `bytes */${stats.size}`);
    return new Response("Invalid range", { status: 416, headers });
  }
  const [start, end] = range;
  headers.set("content-length", String(end - start + 1));
  headers.set("content-range", `bytes ${start}-${end}/${stats.size}`);
  return new Response(includeBody ? webStream(filePath, start, end) : null, {
    status: 206,
    headers,
  });
}

export async function GET(request: Request) {
  return respond(request, true);
}

export async function HEAD(request: Request) {
  return respond(request, false);
}

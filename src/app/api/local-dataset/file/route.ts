import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

function createWebStream(filePath: string, start?: number, end?: number) {
  const nodeStream = createReadStream(filePath, { start, end });
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        try {
          controller.close();
        } catch {
          // The response may have already closed the controller after abort.
        } finally {
          closed = true;
        }
      };

      const fail = (error: unknown) => {
        if (closed) return;
        try {
          controller.error(
            error instanceof Error ? error : new Error(String(error)),
          );
        } catch {
          // Ignore late errors after the consumer has already closed.
        } finally {
          closed = true;
        }
      };

      nodeStream.on("data", (chunk: string | Buffer) => {
        if (closed) return;
        try {
          const chunkBytes =
            typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(chunkBytes));
        } catch {
          closed = true;
          nodeStream.destroy();
        }
      });

      nodeStream.once("end", close);
      nodeStream.once("close", () => {
        closed = true;
      });
      nodeStream.once("error", fail);
    },
    cancel() {
      closed = true;
      nodeStream.destroy();
    },
  });
}

function expandHomeDir(inputPath: string): string {
  if (inputPath === "~") {
    return process.env.HOME ?? inputPath;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", inputPath.slice(2));
  }
  return inputPath;
}

function resolveRoot(root: string): string {
  const withoutFileProtocol = root.replace(/^file:\/\//, "");
  return path.resolve(expandHomeDir(withoutFileProtocol));
}

function resolveDatasetFile(root: string, relativePath: string): string {
  const normalizedRoot = resolveRoot(root);
  const targetPath = path.resolve(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the dataset directory");
  }
  return targetPath;
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".parquet":
      return "application/octet-stream";
    case ".webm":
      return "video/webm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

async function buildResponse(
  request: Request,
  includeBody: boolean,
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const root = searchParams.get("root");
  const relativePath = searchParams.get("path");

  if (!root || !relativePath) {
    return new Response("Missing root or path parameter", { status: 400 });
  }

  let filePath: string;
  try {
    filePath = resolveDatasetFile(root, relativePath);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Invalid path",
      {
        status: 400,
      },
    );
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return new Response("File not found", { status: 404 });
  }

  if (!stats.isFile()) {
    return new Response("Not a file", { status: 400 });
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": getContentType(filePath),
    "content-length": String(stats.size),
    "cache-control": "no-store",
  });

  const range = request.headers.get("range");
  if (!range) {
    if (!includeBody) {
      return new Response(null, { status: 200, headers });
    }

    const stream = createWebStream(filePath);
    return new Response(stream, { status: 200, headers });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    return new Response("Invalid range", { status: 416 });
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    end >= stats.size
  ) {
    return new Response("Invalid range", { status: 416 });
  }

  headers.set("content-length", String(end - start + 1));
  headers.set("content-range", `bytes ${start}-${end}/${stats.size}`);

  if (!includeBody) {
    return new Response(null, { status: 206, headers });
  }

  const stream = createWebStream(filePath, start, end);
  return new Response(stream, { status: 206, headers });
}

export async function GET(request: Request): Promise<Response> {
  return buildResponse(request, true);
}

export async function HEAD(request: Request): Promise<Response> {
  return buildResponse(request, false);
}

import { open, stat } from "node:fs/promises";
import { resolveLocalFile } from "@/lib/localDatasets";

// Same-origin file server for LOCAL datasets. Serves
// `/local-data/{repo}/resolve/{ref}/{path}` from disk with HTTP Range support
// (hyparquet byte-range reads + <video> seeking). Because it lives in the app,
// there's no separate process, no CORS, and no data port to forward.
//
// Inert on the hosted deployment: resolveLocalFile() returns null when no local
// registry env is set, so every request 404s. Path traversal is blocked in
// resolveLocalFile().
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOLVE_RE = /^(.+?)\/resolve\/[^/]+\/(.+)$/;

// Only mp4 (needed for <video> playback) and json need a real type; parquet and
// everything else fall through to the octet-stream default.
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".json": "application/json",
};

function contentType(p: string): string {
  const i = p.lastIndexOf(".");
  return (
    (i >= 0 && CONTENT_TYPES[p.slice(i).toLowerCase()]) ||
    "application/octet-stream"
  );
}

function resolvePath(parts: string[]): string | null {
  const joined = parts.map((s) => decodeURIComponent(s)).join("/");
  const m = RESOLVE_RE.exec(joined);
  if (!m) return null;
  return resolveLocalFile(m[1], m[2]);
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

async function serve(
  req: Request,
  parts: string[],
  headOnly: boolean,
): Promise<Response> {
  const file = resolvePath(parts);
  if (!file) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const st = await stat(file);
    if (!st.isFile()) return new Response("Not found", { status: 404 });
    size = st.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const rng = parseRange(req.headers.get("range"), size);
  if (rng === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  const start = rng ? rng.start : 0;
  const end = rng ? rng.end : size - 1;
  const length = end - start + 1;

  const headers = new Headers({
    "Content-Type": contentType(file),
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (rng) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  if (headOnly) return new Response(null, { status: rng ? 206 : 200, headers });

  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    const body = bytesRead === length ? buf : buf.subarray(0, bytesRead);
    return new Response(body, { status: rng ? 206 : 200, headers });
  } finally {
    await fh.close();
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  return serve(req, (await ctx.params).path, false);
}

export async function HEAD(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  return serve(req, (await ctx.params).path, true);
}

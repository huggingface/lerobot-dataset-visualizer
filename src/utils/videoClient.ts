/**
 * Helpers for serving videos the browser can't decode natively (e.g. depth
 * cameras encoded as `gray12le`/`gray16le`) through the optional FastAPI
 * backend's lazy transcode endpoint (`/api/video/transcode`).
 *
 * The hot path is untouched: videos still stream directly from Hugging Face
 * via `/api/proxy`. Only when a `<video>` element fails to decode do we fall
 * back to the backend, which transcodes once to browser-friendly H.264
 * (`yuv420p`), caches the result on disk, and serves it with Range support.
 *
 * When the backend is not configured these helpers return `null`, so the UI
 * behaves exactly as before (unsupported videos simply fail to play).
 */

import { getAnnotateBackendUrl } from "./annotationsClient";
import { getAuthToken } from "./auth";

/**
 * Heuristic: does this camera key look like a depth/IR stream?
 *
 * Depth videos are usually stored in pixel formats (e.g. gray12le) or codecs
 * (HEVC) that some browsers decode natively as flat grayscale — so an
 * error-driven transcode fallback never fires for them. We instead route
 * likely-depth cameras through the backend transcode endpoint proactively so
 * the viridis colormap is always applied. Matches keys like
 * `observation.images.top_depth`, `depth_camera`, `wrist_depth`, etc.
 */
export function isLikelyDepthCamera(filename: string): boolean {
  return /depth/i.test(filename);
}

export interface ParsedHfDatasetUrl {
  repoId: string;
  revision: string;
  path: string;
}

/**
 * Parse a Hugging Face dataset resolve URL into its parts.
 *
 * Expected shape (produced by `buildVersionedUrl`):
 *   https://huggingface.co/datasets/{org}/{dataset}/resolve/{revision}/{path}
 *
 * Returns `null` for any URL that doesn't match (e.g. already-proxied
 * same-origin URLs, or non-dataset hosts).
 */
export function parseHfDatasetUrl(url: string): ParsedHfDatasetUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // repoId is `org/dataset` (non-greedy so it stops at the first `/resolve/`).
  // revision is a single path segment; path is everything after it.
  const match = parsed.pathname.match(
    /^\/datasets\/(.+?)\/resolve\/([^/]+)\/(.+)$/,
  );
  if (!match) return null;
  const [, repoId, revision, path] = match;
  if (!repoId || !revision || !path) return null;
  return {
    repoId: decodeURIComponent(repoId),
    revision: decodeURIComponent(revision),
    path: decodeURIComponent(path),
  };
}

/**
 * Build the backend transcode URL for a given HF dataset video URL.
 *
 * `backendBase` is the configured annotate-backend origin. `hfToken`, when
 * present, is forwarded so private datasets can be downloaded server-side
 * (the native `<video>` element can't send an Authorization header, so it
 * has to travel as a query param).
 *
 * Returns `null` when the URL can't be parsed.
 */
export function buildTranscodeUrl(
  backendBase: string,
  hfUrl: string,
  hfToken?: string | null,
): string | null {
  const parsed = parseHfDatasetUrl(hfUrl);
  if (!parsed) return null;
  let out: URL;
  try {
    out = new URL("/api/video/transcode", backendBase);
  } catch {
    return null;
  }
  out.searchParams.set("repo_id", parsed.repoId);
  out.searchParams.set("revision", parsed.revision);
  out.searchParams.set("path", parsed.path);
  if (hfToken) out.searchParams.set("hf_token", hfToken);
  return out.toString();
}

/**
 * Resolve the transcode fallback URL for a video, using the configured
 * backend and the signed-in user's HF token. Returns `null` when the backend
 * is not configured or the URL can't be parsed — callers should treat that as
 * "no fallback available" and leave the original load error in place.
 */
export function getTranscodeUrl(hfUrl: string): string | null {
  const base = getAnnotateBackendUrl();
  if (!base) return null;
  return buildTranscodeUrl(base, hfUrl, getAuthToken());
}

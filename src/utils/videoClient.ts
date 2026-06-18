/**
 * Helpers for routing videos the browser can't decode (e.g. depth cameras in
 * `gray12le`) through the optional backend transcode endpoint. When no backend
 * is configured the helpers return `null` and the UI behaves as before.
 */

import { getAnnotateBackendUrl } from "./annotationsClient";
import { getAuthToken } from "./auth";

// Depth/IR streams render as flat grayscale (no decode error), so we route
// them through the colormap transcode proactively rather than on error.
export function isLikelyDepthCamera(filename: string): boolean {
  return /depth/i.test(filename);
}

export interface ParsedHfDatasetUrl {
  repoId: string;
  revision: string;
  path: string;
}

// Parses https://huggingface.co/datasets/{org}/{dataset}/resolve/{rev}/{path};
// returns null for anything that isn't an HF dataset resolve URL.
export function parseHfDatasetUrl(url: string): ParsedHfDatasetUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
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
  // <video> can't send an Authorization header, so the token rides as a param.
  if (hfToken) out.searchParams.set("hf_token", hfToken);
  return out.toString();
}

export function getTranscodeUrl(hfUrl: string): string | null {
  const base = getAnnotateBackendUrl();
  if (!base) return null;
  return buildTranscodeUrl(base, hfUrl, getAuthToken());
}

import { NextRequest } from "next/server";

// Same-origin streaming proxy for huggingface.co. The native <video> element
// can't carry an Authorization header, so we proxy through this route, which
// pulls the user's HF access token from the HttpOnly `hf_access_token` cookie
// (set by /api/auth/session after OAuth) and forwards Range requests upstream.
//
// Public datasets work too — the upstream simply ignores the bearer token.
//
// Allowed path prefixes are constrained so this can't be turned into an open
// proxy for arbitrary huggingface.co URLs (e.g. user profile, billing pages).

const HF_HOST = "https://huggingface.co";
const COOKIE_NAME = "hf_access_token";
const ALLOWED_PREFIXES = ["datasets/", "buckets/"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORWARD_REQUEST_HEADERS = [
  "range",
  "if-modified-since",
  "if-none-match",
  "accept",
  "accept-encoding",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

// Build the upstream URL and validate it. Returns the URL or null if the
// request should be rejected.
//
// Two attack surfaces this guards against:
// 1. Path traversal — `subPath = "datasets/../api/tokens"` passes a naive
//    startsWith("datasets/") check, but URL normalization resolves it to
//    huggingface.co/api/tokens. We re-check the prefix on the *normalized*
//    pathname after construction, so traversal is caught.
// 2. Origin escape — exotic URL syntax could cause new URL() to land on a
//    different host. We assert origin === HF_HOST.
function resolveUpstreamUrl(
  subPath: string,
  searchParams: URLSearchParams,
): URL | null {
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(`${HF_HOST}/${subPath}`);
  } catch {
    return null;
  }

  if (upstreamUrl.origin !== HF_HOST) return null;

  const normalized = upstreamUrl.pathname.replace(/^\/+/, "");
  if (!ALLOWED_PREFIXES.some((p) => normalized.startsWith(p))) return null;

  for (const [k, v] of searchParams) {
    upstreamUrl.searchParams.set(k, v);
  }
  return upstreamUrl;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const upstreamUrl = resolveUpstreamUrl(
    path.join("/"),
    req.nextUrl.searchParams,
  );
  if (!upstreamUrl) return new Response("Forbidden", { status: 403 });

  const headers = new Headers();
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      cache: "no-store",
    });
  } catch (err) {
    // Network error reaching huggingface.co (DNS, reset, etc.). The native
    // <video> turns this into a generic load error with no details, so log
    // server-side and return a useful 502 the client can surface in devtools.
    console.error("[proxy] upstream fetch failed", err);
    return new Response("Bad gateway: upstream fetch failed", { status: 502 });
  }

  const respHeaders = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const upstreamUrl = resolveUpstreamUrl(
    path.join("/"),
    req.nextUrl.searchParams,
  );
  if (!upstreamUrl) return new Response(null, { status: 403 });

  const headers = new Headers();
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "HEAD",
      headers,
      redirect: "follow",
      cache: "no-store",
    });
  } catch (err) {
    console.error("[proxy] upstream HEAD failed", err);
    return new Response(null, { status: 502 });
  }

  const respHeaders = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  return new Response(null, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

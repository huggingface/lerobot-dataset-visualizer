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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const subPath = path.join("/");

  if (!ALLOWED_PREFIXES.some((p) => subPath.startsWith(p))) {
    return new Response("Forbidden", { status: 403 });
  }

  const upstreamUrl = new URL(`${HF_HOST}/${subPath}`);
  for (const [k, v] of req.nextUrl.searchParams) {
    upstreamUrl.searchParams.set(k, v);
  }

  const headers = new Headers();
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const upstream = await fetch(upstreamUrl, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
  });

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
  const subPath = path.join("/");

  if (!ALLOWED_PREFIXES.some((p) => subPath.startsWith(p))) {
    return new Response(null, { status: 403 });
  }

  const upstreamUrl = new URL(`${HF_HOST}/${subPath}`);
  for (const [k, v] of req.nextUrl.searchParams) {
    upstreamUrl.searchParams.set(k, v);
  }

  const headers = new Headers();
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const upstream = await fetch(upstreamUrl, {
    method: "HEAD",
    headers,
    redirect: "follow",
    cache: "no-store",
  });

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

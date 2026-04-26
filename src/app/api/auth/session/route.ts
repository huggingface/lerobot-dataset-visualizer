import { NextRequest, NextResponse } from "next/server";

// Mirror of Hugging Face's default OAuth token lifetime so the cookie expires
// alongside the upstream token. README sets hf_oauth_expiration_minutes: 480.
const COOKIE_NAME = "hf_access_token";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST sets the auth cookie from the Authorization header sent by the client
// after a successful OAuth flow. The cookie is HttpOnly so the access token
// is never exposed to JS — only the proxy route reads it.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return new NextResponse("Missing bearer token", { status: 400 });
  }
  const token = auth.slice("bearer ".length).trim();
  if (!token) {
    return new NextResponse("Empty token", { status: 400 });
  }

  // The Space is iframed inside huggingface.co/spaces/<owner>/<name>, so the
  // top-level site differs from the cookie's site (*.hf.space). SameSite=Lax
  // would block the cookie on subresource requests like <video> in that
  // cross-site embedding context, which is exactly when we need it. Use
  // SameSite=None + Secure + Partitioned (CHIPS) so the cookie rides along
  // on subresource requests inside the iframe while remaining isolated to
  // the (top-frame, this-domain) pair.
  const res = new NextResponse(null, { status: 204 });
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    partitioned: isProd,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE() {
  // To clear a Partitioned cookie, the clearing Set-Cookie must include the
  // Partitioned attribute too — otherwise it lands in a different cookie
  // jar than the one we're trying to clear. Mirror the same attributes used
  // when setting it, with maxAge=0 so it expires immediately.
  const res = new NextResponse(null, { status: 204 });
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    partitioned: isProd,
    path: "/",
    maxAge: 0,
  });
  return res;
}

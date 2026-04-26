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

  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = new NextResponse(null, { status: 204 });
  res.cookies.delete(COOKIE_NAME);
  return res;
}

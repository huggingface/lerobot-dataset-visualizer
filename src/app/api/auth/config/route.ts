import { NextResponse } from "next/server";

// HF Spaces auto-injects `window.huggingface.variables.OAUTH_CLIENT_ID` for
// static Spaces only. Docker Spaces (this one) just get OAUTH_CLIENT_ID /
// OAUTH_SCOPES as container env vars, so we surface them to the client via
// this endpoint. The client_id and scopes are public; the secret stays
// server-side and never leaves the proxy.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const scopes = process.env.OAUTH_SCOPES;
  if (!clientId) {
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({
    enabled: true,
    clientId,
    scopes: scopes ?? "openid profile",
  });
}

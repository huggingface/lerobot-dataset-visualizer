import { NextRequest, NextResponse } from "next/server";

/**
 * Get HuggingFace token from environment or cache (server-side only)
 */
function getHFToken(): string | undefined {
  // First try environment variable
  if (process.env.HF_TOKEN) {
    return process.env.HF_TOKEN;
  }

  // Fallback to reading from HuggingFace cache
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const tokenPath = path.join(
      os.homedir(),
      ".cache",
      "huggingface",
      "token"
    );
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Video proxy API route that fetches private HuggingFace videos with authentication
 * and streams them to the client. Supports range requests for video seeking.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const videoUrl = searchParams.get("url");

  if (!videoUrl) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // Validate the URL is from HuggingFace
  if (!videoUrl.startsWith("https://huggingface.co/")) {
    return NextResponse.json(
      { error: "Only HuggingFace URLs are allowed" },
      { status: 403 }
    );
  }

  const token = getHFToken();
  if (!token) {
    return NextResponse.json(
      { error: "No HuggingFace token available" },
      { status: 401 }
    );
  }

  try {
    // Build headers for the upstream request
    const upstreamHeaders: HeadersInit = {
      Authorization: `Bearer ${token}`,
    };

    // Forward range header for video seeking support
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      upstreamHeaders["Range"] = rangeHeader;
    }

    const response = await fetch(videoUrl, {
      headers: upstreamHeaders,
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Upstream error: ${response.status} ${response.statusText}` },
        { status: response.status }
      );
    }

    // Get the response body as a stream
    const body = response.body;
    if (!body) {
      return NextResponse.json(
        { error: "No response body from upstream" },
        { status: 502 }
      );
    }

    // Build response headers
    const responseHeaders = new Headers();

    // Forward essential headers from upstream
    const headersToForward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ];
    headersToForward.forEach((header) => {
      const value = response.headers.get(header);
      if (value) {
        responseHeaders.set(header, value);
      }
    });

    // Add CORS headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    // Cache the response for 1 hour to reduce load on HuggingFace
    responseHeaders.set("Cache-Control", "public, max-age=3600");

    // Return the streamed response
    return new NextResponse(body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Video proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch video" },
      { status: 500 }
    );
  }
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
    },
  });
}

import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["three"],
  // Avoid the 200-800ms cold-start cost of barrel-file imports.
  // react-icons re-exports thousands of icon components from /fa, etc.;
  // recharts and @huggingface/hub also have wide entry surfaces.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts", "@huggingface/hub"],
  },
  generateBuildId: () => packageJson.version,
  // Local mode only: when `bun run local` points at a single dataset it sets REPO_ID,
  // and this lands the bare "/" straight on it (server-side, so no client flash). Gated
  // on LEROBOT_LOCAL_DATASET_ROOTS — which only the local launcher sets — so the hosted
  // deployment (which never sets it) is unaffected and keeps its normal landing.
  async redirects() {
    const repo = process.env.REPO_ID;
    if (repo && process.env.LEROBOT_LOCAL_DATASET_ROOTS) {
      return [
        { source: "/", destination: `/${repo}/episode_0`, permanent: false },
      ];
    }
    return [];
  },
};

export default nextConfig;

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
  generateBuildId: () => packageJson.version,
  env: {
    NEXT_PUBLIC_LOCAL_MODE: process.env.LOCAL_DATASET_PATH ? "1" : "",
  },
};

export default nextConfig;

import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  generateBuildId: () => packageJson.version,
};

export default nextConfig;

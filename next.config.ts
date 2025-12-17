import type { NextConfig } from "next";
import packageJson from './package.json';

// Node 25+ exposes a globalThis.localStorage that returns {} when --localstorage-file is missing/invalid.
// This breaks SSR guards like `if (typeof localStorage !== 'undefined')` because localStorage exists
// but lacks Storage methods (getItem, setItem, etc.). Deleting it restores correct SSR behaviour.
if (
  typeof (globalThis as any).localStorage !== "undefined" &&
  typeof (globalThis as any).localStorage?.getItem !== "function"
) {
  delete (globalThis as any).localStorage;
}

const nextConfig: NextConfig = {

  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => packageJson.version,
};

export default nextConfig;

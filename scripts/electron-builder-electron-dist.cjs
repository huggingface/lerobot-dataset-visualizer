const fs = require("node:fs");
const path = require("node:path");

function existing(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  return fs.existsSync(resolved) ? resolved : null;
}

exports.default = function electronDist(options) {
  const override = existing(process.env.ELECTRON_BUILDER_ELECTRON_DIST);
  if (override) return override;

  if (options?.platformName === "linux") {
    const local = existing(
      path.join(process.cwd(), "node_modules", "electron", "dist"),
    );
    if (local) return local;
    throw new Error("Electron distribution is missing; run bun install first.");
  }
  return null;
};

import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
await fs.access(path.join(standalone, "server.js"));
await fs.mkdir(path.join(standalone, ".next"), { recursive: true });
await fs.cp(
  path.join(root, ".next", "static"),
  path.join(standalone, ".next", "static"),
  {
    recursive: true,
    force: true,
  },
);

try {
  await fs.access(path.join(root, "public"));
  await fs.cp(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
    force: true,
  });
} catch {
  // A public directory is optional.
}

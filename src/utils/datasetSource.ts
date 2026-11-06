import { LeRobotDataset, isSafeRepoPath } from "@huggingface/lerobot";
import type { LeRobotDatasetOptions } from "@huggingface/lerobot";

/** A repo ID alone continues to select the dataset at its root. */
export type DatasetSource = string | { repoId: string; path?: string };

export function normalizeDatasetPath(path = ""): string {
  if (/[\\\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid dataset path");
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error("Dataset path cannot contain '..'");
  return parts.join("/");
}

export function datasetSource(source: DatasetSource): {
  repoId: string;
  path: string;
} {
  return typeof source === "string"
    ? { repoId: source, path: "" }
    : { repoId: source.repoId, path: normalizeDatasetPath(source.path) };
}

export function datasetSourceKey(source: DatasetSource): string {
  const { repoId, path } = datasetSource(source);
  return JSON.stringify([repoId, path]);
}

export function datasetFilePath(source: DatasetSource, file: string): string {
  if (!isSafeRepoPath(file))
    throw new Error(`Invalid dataset file path: ${file}`);
  const { path } = datasetSource(source);
  return path ? `${path}/${file}` : file;
}

/** Adapter until @huggingface/lerobot exposes a dataset-directory option. */
export class SubpathLeRobotDataset extends LeRobotDataset {
  private readonly source: DatasetSource;

  constructor(source: DatasetSource, options?: LeRobotDatasetOptions) {
    const normalized = datasetSource(source);
    super(normalized.repoId, options);
    this.source = normalized;
  }

  override fileUrl(file: string): string {
    return super.fileUrl(datasetFilePath(this.source, file));
  }
}

/** Preserve the dataset selection between episodes; seek times belong to one episode. */
export function episodeHref(episode: number, path = ""): string {
  const params = new URLSearchParams();
  const normalized = normalizeDatasetPath(path);
  if (normalized) params.set("path", normalized);
  return `./episode_${episode}${params.size ? `?${params}` : ""}`;
}

/** Space `path` is already a route; datasetPath is the optional directory in that repo. */
export function spaceRedirect(params: URLSearchParams): string | null {
  const route =
    params.get("path") ||
    (params.get("dataset")
      ? `/${params.get("dataset")}${params.has("episode") ? `/episode_${params.get("episode")}` : ""}`
      : null);
  if (!route) return null;
  // Only navigate to viewer routes, including old links with their own query string.
  if (!/^\/[^/?#]+\/[^/?#]+(?:\/episode_\d+)?\/?(?:\?|$)/.test(route))
    return null;
  const url = new URL(route, "https://viewer.invalid");
  for (const name of ["t", "tab", "__theme"]) {
    if (params.has(name)) url.searchParams.set(name, params.get(name)!);
  }
  if (params.has("datasetPath"))
    url.searchParams.set("path", params.get("datasetPath")!);
  return url.pathname + url.search;
}

const LOCAL_DATASET_ORG = "local";
const LOCAL_REPO_PREFIX = "local:";
const LOCAL_URL_PROTOCOL = "local://dataset-file";

function stripTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

export function isLikelyLocalDatasetInput(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

export function encodeLocalDatasetPath(localPath: string): string {
  return encodeURIComponent(stripTrailingSlash(localPath.trim()));
}

export function decodeLocalDatasetPath(encodedPath: string): string {
  return decodeURIComponent(encodedPath);
}

export function buildDatasetRoute(input: string, episode = 0): string {
  const trimmed = input.trim();
  if (isLikelyLocalDatasetInput(trimmed)) {
    return `/${LOCAL_DATASET_ORG}/${encodeLocalDatasetPath(trimmed)}/episode_${episode}`;
  }

  const normalized = trimmed.replace(
    /^https?:\/\/huggingface\.co\/datasets\//,
    "",
  );
  return `/${normalized}/episode_${episode}`;
}

export function buildDatasetId(org: string, dataset: string): string {
  if (org === LOCAL_DATASET_ORG) {
    return `${LOCAL_REPO_PREFIX}${decodeLocalDatasetPath(dataset)}`;
  }

  return `${org}/${dataset}`;
}

export function isLocalDatasetId(datasetId: string): boolean {
  return datasetId.startsWith(LOCAL_REPO_PREFIX);
}

export function getLocalDatasetPath(datasetId: string): string {
  return datasetId.slice(LOCAL_REPO_PREFIX.length);
}

export function buildLocalDatasetUrl(
  path: string,
  relativePath: string,
): string {
  const url = new URL(LOCAL_URL_PROTOCOL);
  url.searchParams.set("root", path);
  url.searchParams.set("path", relativePath);
  return url.toString();
}

export function parseLocalDatasetUrl(url: string): {
  root: string;
  path: string;
} | null {
  if (!url.startsWith(LOCAL_URL_PROTOCOL)) {
    return null;
  }

  const parsed = new URL(url);
  const root = parsed.searchParams.get("root");
  const path = parsed.searchParams.get("path");
  if (!root || !path) {
    return null;
  }

  return { root, path };
}

export function getDatasetDisplayName(datasetId: string): string {
  return isLocalDatasetId(datasetId)
    ? getLocalDatasetPath(datasetId)
    : datasetId;
}

export function buildLocalDatasetAssetUrl(
  localDatasetPath: string,
  relativePath: string,
): string {
  const params = new URLSearchParams({
    root: localDatasetPath,
    path: relativePath,
  });
  return `/api/local-dataset/file?${params.toString()}`;
}

export { LOCAL_DATASET_ORG };

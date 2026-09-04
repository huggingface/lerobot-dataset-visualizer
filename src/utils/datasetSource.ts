const LOCAL_DATASET_ORG = "_local";
const HF_SUBDIR_ORG = "_hf";
const LOCAL_REPO_PREFIX = "local:";
const LOCAL_URL_PROTOCOL = "local://dataset-file";

export type DatasetSource =
  | { kind: "local"; root: string }
  | { kind: "huggingface"; repoId: string; subdirectory: string };

function stripTrailingSlashes(value: string): string {
  if (value === "/" || /^[A-Za-z]:[\\/]$/.test(value)) return value;
  return value.replace(/[\\/]+$/, "");
}

function normalizeSubdirectory(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Dataset subdirectory must not contain '.' or '..'");
  }
  return normalized;
}

function normalizeHuggingFaceInput(value: string): string {
  let normalized = value.trim();
  const urlPrefix = /^https?:\/\/huggingface\.co\/datasets\//;
  normalized = normalized.replace(urlPrefix, "");
  normalized = normalized.replace(/\?.*$/, "").replace(/#.*$/, "");

  // Accept copied Hub tree URLs as well as the compact org/repo/subdir form.
  const treeMarker = normalized.indexOf("/tree/");
  if (treeMarker >= 0) {
    const repo = normalized.slice(0, treeMarker);
    const treePath = normalized.slice(treeMarker + "/tree/".length);
    const slash = treePath.indexOf("/");
    normalized = slash >= 0 ? `${repo}/${treePath.slice(slash + 1)}` : repo;
  }

  return normalized.replace(/^\/+|\/+$/g, "");
}

export function isLikelyLocalDatasetInput(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

export function isHuggingFaceSubdirectoryInput(value: string): boolean {
  if (isLikelyLocalDatasetInput(value)) return false;
  try {
    const source = parseDatasetSource(value);
    return source.kind === "huggingface" && source.subdirectory.length > 0;
  } catch {
    return false;
  }
}

export function parseDatasetSource(datasetId: string): DatasetSource {
  if (datasetId.startsWith(LOCAL_REPO_PREFIX)) {
    const root = stripTrailingSlashes(
      datasetId.slice(LOCAL_REPO_PREFIX.length),
    );
    if (!root) throw new Error("Local dataset path is empty");
    return { kind: "local", root };
  }

  const normalized = normalizeHuggingFaceInput(datasetId);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Hugging Face dataset must use the form org/dataset");
  }
  return {
    kind: "huggingface",
    repoId: `${parts[0]}/${parts[1]}`,
    subdirectory: normalizeSubdirectory(parts.slice(2).join("/")),
  };
}

export function encodeDatasetRouteValue(value: string): string {
  return encodeURIComponent(value);
}

export function decodeDatasetRouteValue(value: string): string {
  return decodeURIComponent(value);
}

export function buildDatasetRoute(input: string, episode = 0): string {
  const trimmed = input.trim();
  if (isLikelyLocalDatasetInput(trimmed)) {
    const localPath = stripTrailingSlashes(trimmed);
    return `/${LOCAL_DATASET_ORG}/${encodeDatasetRouteValue(localPath)}/episode_${episode}`;
  }

  const source = parseDatasetSource(trimmed);
  if (source.kind === "local") {
    return `/${LOCAL_DATASET_ORG}/${encodeDatasetRouteValue(source.root)}/episode_${episode}`;
  }
  const fullId = [source.repoId, source.subdirectory].filter(Boolean).join("/");
  if (source.subdirectory) {
    return `/${HF_SUBDIR_ORG}/${encodeDatasetRouteValue(fullId)}/episode_${episode}`;
  }
  return `/${source.repoId}/episode_${episode}`;
}

export function buildDatasetId(org: string, dataset: string): string {
  if (org === LOCAL_DATASET_ORG) {
    return `${LOCAL_REPO_PREFIX}${decodeDatasetRouteValue(dataset)}`;
  }
  if (org === HF_SUBDIR_ORG) {
    return decodeDatasetRouteValue(dataset);
  }
  return `${org}/${dataset}`;
}

export function isLocalDatasetId(datasetId: string): boolean {
  return datasetId.startsWith(LOCAL_REPO_PREFIX);
}

export function isLocalDatasetRoute(org: string): boolean {
  return org === LOCAL_DATASET_ORG;
}

export function getDatasetDisplayName(datasetId: string): string {
  const source = parseDatasetSource(datasetId);
  return source.kind === "local"
    ? source.root
    : [source.repoId, source.subdirectory].filter(Boolean).join("/");
}

export function buildHuggingFaceDatasetPageUrl(
  datasetId: string,
): string | null {
  const source = parseDatasetSource(datasetId);
  if (source.kind === "local") return null;
  const base = `https://huggingface.co/datasets/${source.repoId}`;
  return source.subdirectory
    ? `${base}/tree/main/${source.subdirectory}`
    : base;
}

export function joinDatasetPath(
  datasetId: string,
  relativePath: string,
): string {
  const source = parseDatasetSource(datasetId);
  const child = normalizeSubdirectory(relativePath);
  if (source.kind === "local") return child;
  return [source.subdirectory, child].filter(Boolean).join("/");
}

export function buildLocalDatasetUrl(
  root: string,
  relativePath: string,
): string {
  const url = new URL(LOCAL_URL_PROTOCOL);
  url.searchParams.set("root", root);
  url.searchParams.set("path", normalizeSubdirectory(relativePath));
  return url.toString();
}

export function parseLocalDatasetUrl(url: string): {
  root: string;
  path: string;
} | null {
  if (!url.startsWith(LOCAL_URL_PROTOCOL)) return null;
  const parsed = new URL(url);
  const root = parsed.searchParams.get("root");
  const path = parsed.searchParams.get("path");
  return root && path ? { root, path } : null;
}

export function buildLocalDatasetAssetUrl(
  root: string,
  relativePath: string,
): string {
  const params = new URLSearchParams({
    root,
    path: normalizeSubdirectory(relativePath),
  });
  return `/api/local-dataset/file?${params.toString()}`;
}

export { HF_SUBDIR_ORG, LOCAL_DATASET_ORG };

/**
 * Client-safe local dataset helpers (no Node.js builtins).
 *
 * These functions can be imported in both server and client components.
 * All filesystem access goes through the /api/local-dataset/ route.
 */

export function isLocalMode(): boolean {
  return (
    !!process.env.LOCAL_DATASET_PATH || !!process.env.NEXT_PUBLIC_LOCAL_MODE
  );
}

/**
 * Strips the org prefix from a repoId ("org/dataset" → "dataset").
 */
export function datasetNameFromRepoId(repoId: string): string {
  const slash = repoId.indexOf("/");
  return slash === -1 ? repoId : repoId.slice(slash + 1);
}

/**
 * Returns a URL to the local-dataset API route.
 * Server-side: absolute URL (needed for server-side fetch).
 * Client-side: relative URL (works naturally in the browser).
 */
function localApiUrl(dataset: string, path: string): string {
  const rel = `/api/local-dataset/${dataset}/${path}`;
  if (typeof window !== "undefined") {
    return rel;
  }
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}${rel}`;
}

/**
 * Builds a URL for reading a dataset file.
 * In local mode → points to the /api/local-dataset/ route.
 * Otherwise this function should NOT be called (use buildVersionedUrl).
 */
export function buildLocalUrl(repoId: string, path: string): string {
  const dataset = datasetNameFromRepoId(repoId);
  return localApiUrl(dataset, path);
}

/**
 * Utility functions for checking dataset version compatibility
 */

const DATASET_URL = process.env.DATASET_URL || "https://huggingface.co/datasets";

/**
 * Checks if a specific version/branch exists for a dataset
 */
async function checkVersionExists(repoId: string, version: string): Promise<boolean> {
  try {
    const testUrl = `${DATASET_URL}/${repoId}/resolve/${version}/meta/info.json`;
    
    // Try a simple GET request with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch(testUrl, { 
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // Check if it's a successful response
    if (response.ok) {
      // Try to parse a bit of the JSON to make sure it's valid
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        return !!data.features; // Only return true if it has features
      } catch (parseError) {
        return false;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Checks if a dataset has v3.0 chunked structure
 */
async function checkV3ChunkedStructure(repoId: string): Promise<boolean> {
  try {
    const testUrl = `${DATASET_URL}/${repoId}/resolve/v3.0/meta/episodes/chunk-000/file-000.parquet`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(testUrl, { 
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Determines the best available version for a dataset.
 * Prefers v3.0, falls back to v2.1, then v2.0, or throws an error if none exist.
 */
export async function getDatasetVersion(repoId: string): Promise<string> {
  // Check for v3.0 first - must have both info.json AND chunked episode structure
  const hasV3Info = await checkVersionExists(repoId, "v3.0");
  
  if (hasV3Info) {
    const hasV3Structure = await checkV3ChunkedStructure(repoId);
    
    if (hasV3Structure) {
      return "v3.0";
    }
  }
  
  // Check for v2.1
  const hasV21 = await checkVersionExists(repoId, "v2.1");
  if (hasV21) {
    return "v2.1";
  }
  
  // Fall back to v2.0
  const hasV20 = await checkVersionExists(repoId, "v2.0");
  if (hasV20) {
    return "v2.0";
  }
  
  // If none of the supported versions exist, throw an error
  throw new Error(
    `Dataset ${repoId} is not compatible with this visualizer. ` +
    "This tool only works with dataset versions 3.0, 2.1, or 2.0. " +
    "Please use a compatible dataset version."
  );
}

/**
 * Constructs a versioned URL for dataset resources
 */
export function buildVersionedUrl(repoId: string, version: string, path: string): string {
  return `${DATASET_URL}/${repoId}/resolve/${version}/${path}`;
}


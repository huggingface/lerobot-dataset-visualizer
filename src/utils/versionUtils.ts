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
  console.log(`[VERSION DEBUG] Checking versions for ${repoId}`);
  
  // Check for v3.0 first - must have both info.json AND chunked episode structure
  const hasV3Info = await checkVersionExists(repoId, "v3.0");
  console.log(`[VERSION DEBUG] v3.0 info.json exists: ${hasV3Info}`);
  
  if (hasV3Info) {
    const hasV3Structure = await checkV3ChunkedStructure(repoId);
    console.log(`[VERSION DEBUG] v3.0 chunked structure exists: ${hasV3Structure}`);
    
    if (hasV3Structure) {
      console.log(`[VERSION DEBUG] Using v3.0 for ${repoId}`);
      return "v3.0";
    }
  }
  
  // Check for v2.1
  const hasV21 = await checkVersionExists(repoId, "v2.1");
  console.log(`[VERSION DEBUG] v2.1 exists: ${hasV21}`);
  if (hasV21) {
    console.log(`[VERSION DEBUG] Using v2.1 for ${repoId}`);
    return "v2.1";
  }
  
  // Fall back to v2.0
  const hasV20 = await checkVersionExists(repoId, "v2.0");
  console.log(`[VERSION DEBUG] v2.0 exists: ${hasV20}`);
  if (hasV20) {
    console.log(`[VERSION DEBUG] Using v2.0 for ${repoId}`);
    return "v2.0";
  }
  
  // If none of the supported versions exist, throw an error
  console.log(`[VERSION DEBUG] No compatible versions found for ${repoId}`);
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

/**
 * Debug function to test version checking manually
 */
export async function testVersionCheck(repoId: string): Promise<void> {
  console.log(`Testing version check for: ${repoId}`);
  try {
    const version = await getDatasetVersion(repoId);
    console.log(`Success! Best version found: ${version}`);
  } catch (error) {
    console.error(`Failed:`, error);
  }
}

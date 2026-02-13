/**
 * String formatting utilities for path construction
 * Consolidates repeated padding and path building logic
 */

import { PADDING } from "./constants";

/**
 * Pad number to specified length with leading zeros
 *
 * @param num - Number to pad
 * @param length - Desired string length
 * @returns Zero-padded string
 */
export function padNumber(num: number, length: number): string {
  return num.toString().padStart(length, "0");
}

/**
 * Format episode chunk index with standard padding
 *
 * @param chunkIndex - Chunk index number
 * @returns Padded chunk index string (e.g., "001")
 */
export function formatEpisodeChunk(chunkIndex: number): string {
  return padNumber(chunkIndex, PADDING.EPISODE_CHUNK);
}

/**
 * Format episode index with standard padding
 *
 * @param episodeIndex - Episode index number
 * @returns Padded episode index string (e.g., "000042")
 */
export function formatEpisodeIndex(episodeIndex: number): string {
  return padNumber(episodeIndex, PADDING.EPISODE_INDEX);
}

/**
 * Format file index with standard padding
 *
 * @param fileIndex - File index number
 * @returns Padded file index string (e.g., "001")
 */
export function formatFileIndex(fileIndex: number): string {
  return padNumber(fileIndex, PADDING.FILE_INDEX);
}

/**
 * Format chunk index with standard padding
 *
 * @param chunkIndex - Chunk index number
 * @returns Padded chunk index string (e.g., "001")
 */
export function formatChunkIndex(chunkIndex: number): string {
  return padNumber(chunkIndex, PADDING.CHUNK_INDEX);
}

/**
 * Build video path for v3 datasets
 *
 * @param videoKey - Video key/name (e.g., "observation.image")
 * @param chunkIndex - Data chunk index
 * @param fileIndex - File index within chunk
 * @returns Formatted video path (e.g., "videos/observation.image/chunk-001/file-000.mp4")
 */
export function buildV3VideoPath(
  videoKey: string,
  chunkIndex: number,
  fileIndex: number,
): string {
  return `videos/${videoKey}/chunk-${formatChunkIndex(chunkIndex)}/file-${formatFileIndex(fileIndex)}.mp4`;
}

/**
 * Build data path for v3 datasets
 *
 * @param chunkIndex - Data chunk index
 * @param fileIndex - File index within chunk
 * @returns Formatted data path (e.g., "data/chunk-001/file-000.parquet")
 */
export function buildV3DataPath(chunkIndex: number, fileIndex: number): string {
  return `data/chunk-${formatChunkIndex(chunkIndex)}/file-${formatFileIndex(fileIndex)}.parquet`;
}

/**
 * Build episodes metadata path for v3 datasets
 *
 * @param chunkIndex - Episode chunk index
 * @param fileIndex - File index within chunk
 * @returns Formatted episodes metadata path (e.g., "meta/episodes/chunk-001/file-000.parquet")
 */
export function buildV3EpisodesMetadataPath(
  chunkIndex: number,
  fileIndex: number,
): string {
  return `meta/episodes/chunk-${formatChunkIndex(chunkIndex)}/file-${formatFileIndex(fileIndex)}.parquet`;
}

/**
 * Video type definitions
 */

// Video information structure
export interface VideoInfo {
  filename: string;
  url: string;
  isSegmented?: boolean;
  segmentStart?: number;
  segmentEnd?: number;
  segmentDuration?: number;
  // Single-channel feed (info.json feature shape [h, w, 1]) — rendered with
  // the viridis colormap instead of raw grayscale.
  isGrayscale?: boolean;
}

// Adjacent episode video info for preloading
export interface AdjacentEpisodeVideos {
  episodeId: number;
  videosInfo: VideoInfo[];
}

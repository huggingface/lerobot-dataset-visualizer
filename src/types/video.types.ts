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
}

// Adjacent episode video info for preloading
export interface AdjacentEpisodeVideos {
  episodeId: number;
  videosInfo: VideoInfo[];
}

"use server";

import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";
import { buildDatasetId } from "@/utils/datasetSource";
import type { AdjacentEpisodeVideos } from "@/types";
import {
  getAdjacentEpisodesVideoInfo,
  getEpisodeDataSafe,
  loadAllEpisodeLengthsV3,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  loadEpisodeFlatChartData,
  type EpisodeLengthStats,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
  type EpisodeData,
} from "./fetch-data";

export async function fetchEpisodeDataSafe(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<{ data?: EpisodeData; error?: string }> {
  return getEpisodeDataSafe(org, dataset, episodeId);
}

export async function fetchAdjacentEpisodeVideos(
  org: string,
  dataset: string,
  episodeId: number,
  radius = 2,
): Promise<AdjacentEpisodeVideos[]> {
  return getAdjacentEpisodesVideoInfo(org, dataset, episodeId, radius);
}

export async function fetchEpisodeLengthStats(
  org: string,
  dataset: string,
): Promise<EpisodeLengthStats | null> {
  const repoId = buildDatasetId(org, dataset);
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  if (version !== "v3.0") return null;
  return loadAllEpisodeLengthsV3(repoId, version, info.fps);
}

export async function fetchEpisodeFrames(
  org: string,
  dataset: string,
): Promise<EpisodeFramesData> {
  const repoId = buildDatasetId(org, dataset);
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadAllEpisodeFrameInfo(
    repoId,
    version,
    info as unknown as DatasetMetadata,
  );
}

export async function fetchCrossEpisodeVariance(
  org: string,
  dataset: string,
): Promise<CrossEpisodeVarianceData | null> {
  const repoId = buildDatasetId(org, dataset);
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadCrossEpisodeActionVariance(
    repoId,
    version,
    info as unknown as DatasetMetadata,
    info.fps,
  );
}

export async function fetchEpisodeChartData(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<Record<string, number>[]> {
  const repoId = buildDatasetId(org, dataset);
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadEpisodeFlatChartData(
    repoId,
    version,
    info as unknown as DatasetMetadata,
    episodeId,
  );
}

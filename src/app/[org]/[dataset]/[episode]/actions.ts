"use server";

import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";
import {
  loadAllEpisodeLengthsV3,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  loadEpisodeFlatChartData,
  type EpisodeLengthStats,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
} from "./fetch-data";

export async function fetchEpisodeLengthStats(
  org: string,
  dataset: string,
): Promise<EpisodeLengthStats | null> {
  const repoId = `${org}/${dataset}`;
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  if (version !== "v3.0") return null;
  return loadAllEpisodeLengthsV3(repoId, version, info.fps);
}

export async function fetchEpisodeFrames(
  org: string,
  dataset: string,
): Promise<EpisodeFramesData> {
  const repoId = `${org}/${dataset}`;
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadAllEpisodeFrameInfo(repoId, version, info as unknown as DatasetMetadata);
}

export async function fetchCrossEpisodeVariance(
  org: string,
  dataset: string,
): Promise<CrossEpisodeVarianceData | null> {
  const repoId = `${org}/${dataset}`;
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadCrossEpisodeActionVariance(repoId, version, info as unknown as DatasetMetadata, info.fps);
}

export async function fetchEpisodeChartData(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<Record<string, number>[]> {
  const repoId = `${org}/${dataset}`;
  const { version, info } = await getDatasetVersionAndInfo(repoId);
  return loadEpisodeFlatChartData(repoId, version, info as unknown as DatasetMetadata, episodeId);
}


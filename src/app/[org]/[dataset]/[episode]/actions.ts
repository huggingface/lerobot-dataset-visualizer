"use server";

import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";
import {
  loadAllEpisodeLengthsV3,
  loadAllEpisodeFrameInfo,
  type EpisodeLengthStats,
  type EpisodeFramesData,
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


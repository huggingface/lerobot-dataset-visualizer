import EpisodeViewer from "./episode-viewer";
import { Suspense } from "react";
import { buildDatasetId, getDatasetDisplayName } from "@/utils/datasetSource";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  const { org, dataset, episode } = await params;
  return {
    title: `${getDatasetDisplayName(buildDatasetId(org, dataset))} | episode ${episode}`,
  };
}

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  // episode is like 'episode_1'
  const { org, dataset, episode } = await params;
  // fetchData should be updated if needed to support this path pattern
  const episodeNumber = Number(episode.replace(/^episode_/, ""));
  return (
    <Suspense fallback={null}>
      <EpisodeViewer org={org} dataset={dataset} episodeId={episodeNumber} />
    </Suspense>
  );
}

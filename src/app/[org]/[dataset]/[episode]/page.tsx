import EpisodeViewer from "./episode-viewer";
import { Suspense } from "react";
import { buildDatasetId, getDatasetDisplayName } from "@/utils/datasetSource";
import { fetchEpisodeDataSafe } from "./actions";

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
  const { org, dataset, episode } = await params;
  const episodeNumber = Number(episode.replace(/^episode_/, ""));
  const initialResult = await fetchEpisodeDataSafe(org, dataset, episodeNumber);

  return (
    <Suspense fallback={null}>
      <EpisodeViewer
        org={org}
        dataset={dataset}
        episodeId={episodeNumber}
        initialData={initialResult.data ?? null}
        initialError={initialResult.error ?? null}
      />
    </Suspense>
  );
}

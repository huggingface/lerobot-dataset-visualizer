import { normalizeDatasetPath } from "@/utils/datasetSource";
import EpisodeViewer from "./episode-viewer";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  const { org, dataset, episode } = await params;
  return {
    title: `${org}/${dataset} | episode ${episode}`,
  };
}

export default async function EpisodePage({
  params,
  searchParams,
}: {
  searchParams: Promise<{ path?: string; datasetPath?: string }>;
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  const query = await searchParams;
  const path = normalizeDatasetPath(query.path ?? query.datasetPath);
  // episode is like 'episode_1'
  const { org, dataset, episode } = await params;
  // fetchData should be updated if needed to support this path pattern
  const episodeNumber = Number(episode.replace(/^episode_/, ""));
  return (
    <Suspense fallback={null}>
      <EpisodeViewer
        key={`${org}/${dataset}:${path}`}
        path={path}
        org={org}
        dataset={dataset}
        episodeId={episodeNumber}
      />
    </Suspense>
  );
}

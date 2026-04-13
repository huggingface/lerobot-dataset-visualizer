import { redirect } from "next/navigation";

export default async function DatasetRootPage({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  const { org, dataset: rawDataset } = await params;
  const dataset = decodeURIComponent(rawDataset);
  const episodeN =
    process.env.EPISODES?.split(/\s+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => !isNaN(x))[0] ?? 0;

  redirect(`/${org}/${encodeURIComponent(dataset)}/episode_${episodeN}`);
}

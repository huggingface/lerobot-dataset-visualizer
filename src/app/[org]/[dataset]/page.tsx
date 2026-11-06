import { redirect } from "next/navigation";

export default async function DatasetRootPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ org: string; dataset: string }>;
}) {
  const { org, dataset } = await params;
  const episodeN =
    process.env.EPISODES?.split(/\s+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => !isNaN(x))[0] ?? 0;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") query.set(key, value);
    else if (value) for (const item of value) query.append(key, item);
  }
  redirect(
    `/${org}/${dataset}/episode_${episodeN}${query.size ? `?${query}` : ""}`,
  );
}

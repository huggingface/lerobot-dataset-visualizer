import React from "react";
import ExploreClient from "./explore-client";
import { fetchExploreDatasets, type ExploreData } from "@/utils/exploreData";

export default async function ExplorePage() {
  let data: ExploreData;
  try {
    data = await fetchExploreDatasets();
  } catch {
    return <div className="p-8 text-red-600">Failed to load datasets.</div>;
  }

  return (
    <ExploreClient
      datasets={data.datasets}
      globalStats={data.globalStats}
      totalCount={data.totalCount}
    />
  );
}

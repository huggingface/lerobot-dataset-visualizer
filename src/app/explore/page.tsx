import React, { Suspense } from "react";
import ExploreClient from "./explore-client";
import StatsBar, { StatsBarSkeleton } from "./stats-bar";
import type { ExploreDataset } from "@/types/dataset.types";
import { fetchExploreGrid, fetchGlobalStats } from "@/utils/exploreData";

// Streamed in via Suspense: the corpus-wide stats crawl is slow (~62 sequential
// pages), so it must not block the grid's first paint.
async function GlobalStats() {
  let stats;
  try {
    stats = await fetchGlobalStats();
  } catch {
    return null; // stats unavailable — the grid still works without them
  }
  return <StatsBar stats={stats} />;
}

export default async function ExplorePage() {
  let datasets: ExploreDataset[];
  try {
    datasets = await fetchExploreGrid();
  } catch {
    return <div className="p-8 text-red-600">Failed to load datasets.</div>;
  }

  return (
    <ExploreClient
      datasets={datasets}
      statsSlot={
        <Suspense fallback={<StatsBarSkeleton />}>
          <GlobalStats />
        </Suspense>
      }
    />
  );
}

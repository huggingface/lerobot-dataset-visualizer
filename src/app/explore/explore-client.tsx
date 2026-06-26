"use client";

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import HfAuthButton from "@/components/hf-auth-button";
import type { ExploreDataset } from "@/types/dataset.types";
import {
  applyFilters,
  computeFacets,
  emptySelection,
  FACET_GROUP_IDS,
  type ExploreStats,
  type FacetGroupId,
  type FacetSelection,
} from "@/utils/explore-facets";
import FiltersSidebar from "./filters-sidebar";
import StatsBar from "./stats-bar";
import DatasetCard from "./dataset-card";

const PER_PAGE = 30;

type SortKey = "lastModified" | "downloads" | "likes" | "size";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "lastModified", label: "Recently updated" },
  { value: "downloads", label: "Most downloads" },
  { value: "likes", label: "Most likes" },
  { value: "size", label: "Largest size" },
];

function sortDatasets(list: ExploreDataset[], key: SortKey): ExploreDataset[] {
  const arr = [...list];
  switch (key) {
    case "downloads":
      return arr.sort((a, b) => b.downloads - a.downloads);
    case "likes":
      return arr.sort((a, b) => b.likes - a.likes);
    case "size":
      return arr.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
    case "lastModified":
    default:
      return arr.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }
}

interface ExploreClientProps {
  datasets: ExploreDataset[];
  globalStats: ExploreStats;
  totalCount: number;
}

export default function ExploreClient(props: ExploreClientProps) {
  return (
    <Suspense fallback={null}>
      <ExploreInner {...props} />
    </Suspense>
  );
}

function ExploreInner({
  datasets,
  globalStats,
  totalCount,
}: ExploreClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Initialize state from the URL once (lazy initializers run on first render only).
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [selection, setSelection] = useState<FacetSelection>(() => {
    const sel = emptySelection();
    for (const g of FACET_GROUP_IDS) {
      const raw = searchParams.get(g);
      if (raw) sel[g] = new Set(raw.split(",").filter(Boolean));
    }
    return sel;
  });
  const [sort, setSort] = useState<SortKey>(
    () => (searchParams.get("sort") as SortKey) || "lastModified",
  );
  const [page, setPage] = useState(() =>
    Math.max(1, parseInt(searchParams.get("p") ?? "1", 10) || 1),
  );

  // Debounce the search term so typing doesn't thrash the memoized pipeline.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  const searched = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return q
      ? datasets.filter((d) => d.id.toLowerCase().includes(q))
      : datasets;
  }, [datasets, debouncedQuery]);

  const filtered = useMemo(
    () => applyFilters(searched, selection),
    [searched, selection],
  );
  const sorted = useMemo(() => sortDatasets(filtered, sort), [filtered, sort]);
  const facets = useMemo(
    () => computeFacets(searched, selection),
    [searched, selection],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageSlice = useMemo(
    () => sorted.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE),
    [sorted, safePage],
  );

  // Reset to page 1 when the result set changes — but not on the initial mount,
  // so a shared `?p=` deep link is preserved.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setPage(1);
  }, [debouncedQuery, selection, sort]);

  // Mirror state into the URL (shareable) and keep the HF Spaces parent iframe synced.
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    for (const g of FACET_GROUP_IDS) {
      if (selection[g].size > 0) params.set(g, [...selection[g]].join(","));
    }
    if (sort !== "lastModified") params.set("sort", sort);
    if (safePage > 1) params.set("p", String(safePage));
    const qs = params.toString();
    const path = qs ? `/explore?${qs}` : "/explore";
    router.replace(path, { scroll: false });
    postParentMessageWithParams((p) => p.set("path", path));
  }, [debouncedQuery, selection, sort, safePage, router]);

  const toggleFacet = useCallback((group: FacetGroupId, value: string) => {
    setSelection((prev) => {
      const set = new Set(prev[group]);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...prev, [group]: set };
    });
  }, []);

  const clearAll = useCallback(() => setSelection(emptySelection()), []);

  const activeCount = FACET_GROUP_IDS.reduce(
    (n, g) => n + selection[g].size,
    0,
  );

  const loaded = datasets.length;
  const narrowed = filtered.length !== loaded;
  const gridCountLabel = narrowed
    ? `${filtered.length.toLocaleString()} match${filtered.length === 1 ? "" : "es"} in the ${loaded.toLocaleString()} most-recent datasets`
    : totalCount > loaded
      ? `Browsing the ${loaded.toLocaleString()} most-recent of ${totalCount.toLocaleString()} datasets`
      : `Browsing ${loaded.toLocaleString()} datasets`;

  return (
    <main className="flex min-h-screen">
      <FiltersSidebar
        facets={facets}
        selection={selection}
        onToggle={toggleFacet}
        onClearAll={clearAll}
        activeCount={activeCount}
      />

      <div className="flex-1 min-w-0 px-6 py-8">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <h1 className="text-xl font-medium tracking-tight text-slate-100">
            Explore LeRobot datasets
          </h1>
          <HfAuthButton />
        </div>

        <StatsBar stats={globalStats} />

        {/* Search + sort */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
              />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search datasets by name…"
              className="w-full pl-10 pr-4 py-2 rounded-md text-sm text-slate-100 bg-[var(--surface-1)] border border-white/10 focus:outline-none focus:border-cyan-400 placeholder:text-slate-500 transition-colors"
              autoComplete="off"
            />
          </div>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-[var(--surface-1)] text-slate-200 text-sm rounded-md px-3 py-2 border border-white/10 focus:outline-none focus:border-cyan-400"
            aria-label="Sort datasets"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <p className="text-xs text-slate-500 mb-3">{gridCountLabel}</p>

        {/* Grid */}
        {pageSlice.length === 0 ? (
          <div className="text-slate-400 text-sm py-16 text-center">
            No datasets match your search and filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {pageSlice.map((ds) => (
              <DatasetCard key={ds.id} ds={ds} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-8">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="px-4 py-2 rounded-md panel text-sm text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ‹ Previous
            </button>
            <span className="text-sm text-slate-400 tabular-nums">
              Page {safePage} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="px-4 py-2 rounded-md bg-cyan-400/10 border border-cyan-400/30 text-cyan-300 text-sm hover:bg-cyan-400/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next ›
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

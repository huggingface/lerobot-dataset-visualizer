/**
 * Data layer for the /explore page.
 *
 * The LeRobot corpus is large (60k+ datasets), so we use a hybrid model:
 * - `fetchExploreDatasets` (server): crawls the entire HuggingFace datasets list API
 *   once (cached) to compute accurate global stats over ALL datasets, but ships only
 *   the most-recent `GRID_LIMIT` compacted records to the client for in-memory search /
 *   faceting. Keeps the payload light while the headline totals stay corpus-wide.
 * - `fetchPreview` (client): lazy, per-card fetch of a dataset's episode-0 preview
 *   video URL + exact `robot_type` from meta/info.json.
 */

import type { ExploreDataset } from "@/types/dataset.types";
import { ROBOT_TAG_TO_KEY, EXPLORE_TAG_STOPWORDS } from "@/utils/constants";
import { computeStats, type ExploreStats } from "@/utils/explore-facets";
import { formatStringWithVars } from "@/utils/parquetUtils";
import {
  getDatasetVersionAndInfo,
  buildVersionedUrl,
} from "@/utils/versionUtils";
import { proxyHfUrl } from "@/utils/auth";

const HF_DATASETS_API = "https://huggingface.co/api/datasets";

// Fields requested per dataset. NOTE: `expand[]` cannot be combined with `full=true`
// (the API returns 400), and `mainSize` (exact repo bytes) is only available via the
// `expand[]` form — not under `full=true`.
const EXPAND_FIELDS = [
  "tags",
  "cardData",
  "downloads",
  "likes",
  "lastModified",
  "mainSize",
];

// The API caps each page at 1000 results. The corpus is ~60k datasets (~62 pages);
// MAX_PAGES is a generous runaway backstop, not an intended cap.
const MAX_PAGES = 100;

// How many of the most-recent datasets are shipped to the client for the browsable,
// filterable grid. Global stats are still computed over the full crawl.
const GRID_LIMIT = 10000;

// ISR window for the cached crawl. The full-corpus stats crawl is expensive (~62
// sequential pages), so cache it for an hour; the grid's first pages share the cache.
const REVALIDATE_SECONDS = 3600;

/** Raw shape of a dataset entry from the HF list API (only fields we read). */
interface RawDataset {
  id: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags?: string[];
  cardData?: { license?: string | string[] | null } | null;
  mainSize?: number | null;
}

/** Extract the `rel="next"` URL from an HTTP `Link` header, or null. */
export function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

/** Map a raw list-API entry to the compact record shipped to the client. */
export function compactDataset(raw: RawDataset): ExploreDataset {
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  // License: prefer cardData.license, fall back to a "license:*" tag.
  let license: string | null = null;
  const cardLicense = raw.cardData?.license;
  if (typeof cardLicense === "string" && cardLicense.trim()) {
    license = cardLicense.trim();
  } else if (Array.isArray(cardLicense) && cardLicense.length > 0) {
    license = String(cardLicense[0]);
  } else {
    const licenseTag = tags.find((t) => t.startsWith("license:"));
    if (licenseTag) license = licenseTag.slice("license:".length) || null;
  }

  // Split tags into canonical robots and free-form (descriptive) tags. Structured
  // "x:y" tags (license:, size_categories:, modality:, library:, ...) are dropped.
  const robots = new Set<string>();
  const freeTags = new Set<string>();
  for (const tag of tags) {
    if (tag.includes(":")) continue;
    const lower = tag.toLowerCase();
    const robotKey = ROBOT_TAG_TO_KEY[lower];
    if (robotKey) robots.add(robotKey);
    else if (!EXPLORE_TAG_STOPWORDS.has(lower)) freeTags.add(lower);
  }

  return {
    id: raw.id,
    downloads: typeof raw.downloads === "number" ? raw.downloads : 0,
    likes: typeof raw.likes === "number" ? raw.likes : 0,
    lastModified: raw.lastModified ?? "",
    sizeBytes: typeof raw.mainSize === "number" ? raw.mainSize : null,
    license,
    robotTags: [...robots],
    freeTags: [...freeTags],
  };
}

/**
 * Crawl the LeRobot dataset list (server-side), following the `Link: rel="next"` cursor.
 * Stops once `maxItems` datasets are collected (null = whole corpus) or `MAX_PAGES` is hit.
 * Cached via Next ISR, so the grid's first pages and the full stats crawl share fetches.
 */
async function crawl(maxItems: number | null): Promise<ExploreDataset[]> {
  const params = new URLSearchParams({
    filter: "LeRobot",
    sort: "lastModified",
    limit: "1000",
  });
  for (const field of EXPAND_FIELDS) params.append("expand[]", field);

  let url: string | null = `${HF_DATASETS_API}?${params.toString()}`;
  const all: ExploreDataset[] = [];
  const seen = new Set<string>();
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    if (maxItems != null && all.length >= maxItems) break;
    // `next` is a Next extension absent from the ambient (Bun) RequestInit type,
    // so it is passed via an intersection cast.
    const res: Response = await fetch(url, {
      next: { revalidate: REVALIDATE_SECONDS },
    } as RequestInit & { next: { revalidate: number } });
    if (!res.ok) {
      if (pages === 0) {
        throw new Error(`Failed to fetch datasets: ${res.status}`);
      }
      break; // a partial corpus beats failing the whole page on a later cursor error
    }
    const batch = (await res.json()) as RawDataset[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const raw of batch) {
      if (!raw?.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      all.push(compactDataset(raw));
    }

    url = parseNextCursor(res.headers.get("link"));
    pages += 1;
  }

  return all;
}

/**
 * Fast fetch for the browsable grid: only the most-recent `GRID_LIMIT` datasets
 * (~10 pages). Renders immediately while global stats stream in separately.
 */
export async function fetchExploreGrid(): Promise<ExploreDataset[]> {
  const recent = await crawl(GRID_LIMIT);
  return recent.slice(0, GRID_LIMIT);
}

/**
 * Slow fetch for the corpus-wide stats panel: crawls every page so totals (count,
 * total size, breakdowns) cover all datasets. Streamed via Suspense on the page.
 */
export async function fetchGlobalStats(): Promise<ExploreStats> {
  const all = await crawl(null);
  return computeStats(all);
}

/**
 * Lazily resolve a dataset's episode-0 preview video URL and exact robot_type from
 * meta/info.json (client-side). Reuses the cached `getDatasetVersionAndInfo`. Returns
 * nulls on any failure so a single bad dataset never breaks its card.
 */
export async function fetchPreview(
  repoId: string,
): Promise<{ videoUrl: string | null; robotType: string | null }> {
  try {
    const { version, info } = await getDatasetVersionAndInfo(repoId);
    const robotType = info.robot_type ?? null;

    let videoUrl: string | null = null;
    const videoEntry = Object.entries(info.features).find(
      ([, value]) => value.dtype === "video",
    );
    if (videoEntry && info.video_path) {
      const [key] = videoEntry;
      const videoPath = formatStringWithVars(info.video_path, {
        video_key: key,
        episode_chunk: "0".padStart(3, "0"),
        episode_index: "0".padStart(6, "0"),
      });
      const url = proxyHfUrl(buildVersionedUrl(repoId, version, videoPath));
      try {
        const headRes = await fetch(url, { method: "HEAD" });
        if (headRes.ok) videoUrl = url;
      } catch {
        // leave videoUrl null on network/CORS failure
      }
    }

    return { videoUrl, robotType };
  } catch {
    return { videoUrl: null, robotType: null };
  }
}

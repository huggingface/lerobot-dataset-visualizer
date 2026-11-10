"use client";

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime, useTimeControls } from "@/context/time-context";
import { useAuth } from "@/context/auth-context";
import { getAuthToken } from "@/utils/auth";
import {
  FlaggedEpisodesProvider,
  useFlaggedEpisodes,
} from "@/context/flagged-episodes-context";
import {
  AnnotationsProvider,
  useAnnotations,
} from "@/context/annotations-context";
import { AnnotationsPanel } from "@/components/annotations-panel";
import { AnnotationsTimeline } from "@/components/annotations-timeline";
import Sidebar from "@/components/side-nav";
import StatsPanel from "@/components/stats-panel";
import OverviewPanel from "@/components/overview-panel";
import Loading from "@/components/loading-component";
import HfAuthButton from "@/components/hf-auth-button";
import { EpisodeHeader, ThemeToggle } from "@/components/ui";
import { useTheme } from "@/utils/theme";
import { hasRobotModel } from "@/lib/so101-robot";
import {
  crossEpisodeCache,
  datasetCacheKey,
  datasetSchemaCache,
  episodeFramesCache,
  episodeLengthsCache,
  getEpisodeDataSafe,
  loadAllEpisodeLengths,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  loadDatasetSchema,
  type EpisodeData,
} from "./fetch-data";
import { useCachedResource } from "@/utils/useCachedResource";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import { CHART_CONFIG } from "@/utils/constants";
import { searchWithTab } from "@/utils/tabUrl";
import { parseInfo } from "@huggingface/lerobot";
import type { DatasetMetadata } from "@/utils/parquetUtils";

const ReplayViewer = lazy(() => import("@/components/replay-viewer"));
const HandReplay = lazy(() => import("@/components/hand-replay"));
const ActionInsightsPanel = lazy(
  () => import("@/components/action-insights-panel"),
);
const FilteringPanel = lazy(() => import("@/components/filtering-panel"));
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));

/** Skip global playback / navigation shortcuts while typing in a field. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "INPUT" ||
    tag === "BUTTON" ||
    (tag === "A" && target.hasAttribute("href"))
  );
}

const TABS = [
  "episodes",
  "annotations",
  "statistics",
  "frames",
  "insights",
  "filtering",
  "doctor",
  "replay",
  "hands",
] as const;
type ActiveTab = (typeof TABS)[number];

/// 3D Replay's id was `urdf`, which links shared before still carry.
function tabId(tab: string | null): string | null {
  return tab === "urdf" ? "replay" : tab;
}

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync() {
  const { currentTime, isPlaying } = useTime();
  const lastUrlSecondRef = useRef<number>(-1);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(window.location.search);
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
      postParentMessageWithParams((params: URLSearchParams) => {
        params.set("path", window.location.pathname + window.location.search);
      });
    }
  }, [isPlaying, currentTime]);

  return null;
}

// Hoisted to module scope. Defining inside EpisodeViewerInner created a new
// component type on every parent render — and the parent re-renders ~12.5×/s
// during playback because it consumes `currentTime` from useTime. React
// would unmount and remount every tab on every tick.
/** Analysis tabs, grouped under "Advanced" so the bar leads with Episodes and 3D Replay. */
const ADVANCED_TABS: { tab: ActiveTab; label: string; hint: string }[] = [
  {
    tab: "annotations",
    label: "Annotations",
    hint: "Subtasks, plans, memory and VQA on the timeline",
  },
  {
    tab: "hands",
    label: "3D Hands",
    hint: "Wrists, hands and camera overlays in sync",
  },
  {
    tab: "statistics",
    label: "Statistics",
    hint: "Size, cameras and episode lengths",
  },
  {
    tab: "filtering",
    label: "Filtering",
    hint: "Find and flag episodes to remove",
  },
  {
    tab: "frames",
    label: "Frames",
    hint: "First and last frame of every episode",
  },
  {
    tab: "insights",
    label: "Action Insights",
    hint: "Chunk length, control delay, variance",
  },
  {
    tab: "doctor",
    label: "Doctor",
    hint: "Quality checks by lerobot-doctor",
  },
];

function AdvancedTabsMenu({
  activeTab,
  onSelect,
  handsAvailable,
}: {
  activeTab: ActiveTab;
  onSelect: (tab: ActiveTab) => void;
  handsAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { count: flaggedCount } = useFlaggedEpisodes();
  const tabs = ADVANCED_TABS.filter((t) => t.tab !== "hands" || handsAvailable);
  const active = tabs.find((t) => t.tab === activeTab);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening moves focus into the menu, onto the open tab when it is one of these.
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"]',
    );
    if (!items?.length) return;
    const current = [...items].find(
      (item) => item.getAttribute("aria-checked") === "true",
    );
    (current ?? items[0]).focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => {
      e.preventDefault();
      // The viewer's own arrow-key handler changes episode; these keys belong to the menu.
      e.stopPropagation();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") focus(index + 1);
    else if (e.key === "ArrowUp") focus(index - 1);
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-active={active ? true : undefined}
        className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 lg:px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors ${
          active ? "text-accent-fg" : "text-fg-muted hover:text-fg"
        }`}
      >
        {active ? `Advanced · ${active.label}` : "Advanced"}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span
          className={`pointer-events-none absolute bottom-0 left-3 right-3 h-px transition-all ${
            active
              ? "bg-accent shadow-[0_0_8px_var(--accent-ring)]"
              : "bg-transparent"
          }`}
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Advanced tabs"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1rem)] panel-raised bg-[var(--surface-1)] p-1.5 shadow-xl animate-menu-pop [transform-origin:top_left]"
        >
          {tabs.map(({ tab, label, hint }) => {
            const current = tab === activeTab;
            return (
              <button
                key={tab}
                role="menuitemradio"
                aria-checked={current}
                onClick={() => {
                  onSelect(tab);
                  close(true);
                }}
                className={`block w-full rounded-md px-2.5 py-1.5 text-left transition-colors focus:outline-none ${
                  current
                    ? "bg-accent/10"
                    : "hover:bg-fill focus-visible:bg-fill"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`text-sm ${current ? "text-accent-fg" : "text-fg"}`}
                  >
                    {label}
                  </span>
                  {tab === "filtering" && flaggedCount > 0 && (
                    <span className="tabular rounded border border-rose-500/30 bg-rose-500/15 px-1.5 text-[10px] text-flag-fg">
                      {flaggedCount} flagged
                    </span>
                  )}
                </span>
                <span className="block text-xs text-fg-muted">{hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  title,
  onPointerEnter,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  onPointerEnter?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      title={title}
      data-active={active || undefined}
      className={`relative shrink-0 whitespace-nowrap px-3 lg:px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors ${
        active ? "text-accent-fg" : "text-fg-muted hover:text-fg"
      }`}
    >
      {label}
      <span
        className={`pointer-events-none absolute bottom-0 left-3 right-3 h-px transition-all ${
          active
            ? "bg-accent shadow-[0_0_8px_var(--accent-ring)]"
            : "bg-transparent"
        }`}
      />
    </button>
  );
}

export default function EpisodeViewer({
  org,
  dataset,
  episodeId,
}: {
  org: string;
  dataset: string;
  episodeId: number;
}) {
  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noEpisodes, setNoEpisodes] = useState(false);
  const requestIdRef = useRef(0);
  const loadedRef = useRef<{ key: string; token: string | null } | null>(null);
  const { oauth } = useAuth();
  const accessToken = oauth?.accessToken ?? null;

  // Opening straight onto 3D Replay: start the robot meshes downloading now,
  // alongside the episode data, rather than once it has loaded and the viewer
  // mounts. info.json is all it needs, and the episode load fetches it anyway.
  useEffect(() => {
    if (tabId(sessionStorage.getItem("activeTab")) !== "replay") return;
    getDatasetVersionAndInfo(`${org}/${dataset}`)
      .then(({ info }) => {
        if (
          hasRobotModel(info.robot_type ?? null) &&
          info.codebase_version >= "v3.0"
        ) {
          const { joints } = parseInfo(JSON.stringify(info));
          const columns = Object.entries(joints).flatMap(([feature, names]) =>
            names.map(
              (n) => `${feature}${CHART_CONFIG.SERIES_NAME_DELIMITER}${n}`,
            ),
          );
          return import("@/components/replay-viewer").then((m) =>
            m.prefetchRobotModel(info.robot_type ?? null, columns),
          );
        }
      })
      .catch(() => {});
  }, [org, dataset]);

  useEffect(() => {
    if (Number.isNaN(episodeId)) {
      setError("Invalid episode id.");
      setData(null);
      return;
    }
    // Requests read the token from storage, so the first load already uses a
    // saved sign-in, which AuthProvider restores into `accessToken` only
    // afterwards. Reload for a new token, not for that one.
    const key = `${org}/${dataset}/${episodeId}`;
    const token = getAuthToken();
    if (loadedRef.current?.key === key && loadedRef.current.token === token)
      return;
    loadedRef.current = { key, token };
    const requestId = ++requestIdRef.current;
    setError(null);
    setNoEpisodes(false);
    setData(null);
    getEpisodeDataSafe(org, dataset, episodeId)
      .then(({ data: loaded, error: loadError, noEpisodes: empty }) => {
        if (requestIdRef.current !== requestId) return;
        if (empty) {
          setNoEpisodes(true);
          return;
        }
        if (loadError) {
          setError(loadError);
          setData(null);
          return;
        }
        setData(loaded ?? null);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Unknown error");
        setData(null);
      });
  }, [org, dataset, episodeId, accessToken]);

  if (noEpisodes) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
        <div className="panel-raised max-w-xl p-6">
          <h2 className="text-xl font-medium text-fg mb-2">No episodes yet</h2>
          <p className="text-sm text-fg-muted">
            <a
              href={`https://huggingface.co/datasets/${org}/${dataset}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-fg hover:text-accent-fg transition-colors"
            >
              {org}/{dataset}
            </a>{" "}
            has a <code className="font-mono">meta/info.json</code> but no
            recorded episodes, so there is nothing to play.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-red-600 dark:text-red-300">
        <div className="panel-raised max-w-xl p-6 border-red-500/40">
          <h2 className="text-xl font-medium mb-3">Something went wrong</h2>
          <p className="text-sm font-mono whitespace-pre-wrap text-red-700/90 dark:text-red-200/90">
            {error}
          </p>
          <div className="mt-4">
            <HfAuthButton variant="ghost" />
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="relative h-screen bg-[var(--bg)]">
        <Loading />
      </div>
    );
  }

  return (
    <TimeProvider duration={data!.duration}>
      <FlaggedEpisodesProvider
        key={data!.datasetInfo.repoId}
        repoId={data!.datasetInfo.repoId}
      >
        <AnnotationsProvider>
          <EpisodeBootstrap data={data!} />
          <EpisodeViewerInner data={data!} org={org} dataset={dataset} />
        </AnnotationsProvider>
      </FlaggedEpisodesProvider>
    </TimeProvider>
  );
}

/** Wires the loaded episode into the AnnotationsProvider. */
function EpisodeBootstrap({ data }: { data: EpisodeData }) {
  const { setEpisode } = useAnnotations();
  useEffect(() => {
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [
    data.episodeId,
    data.datasetInfo.repoId,
    data.languageAtoms,
    data.frameTimestamps,
    setEpisode,
  ]);
  return null;
}

function EpisodeViewerInner({
  data,
  org,
  dataset,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
}) {
  const {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    episodes,
    task,
  } = data;

  const [videosReady, setVideosReady] = useState(!videosInfo.length);
  const [chartsReady, setChartsReady] = useState(false);

  const loadStartRef = useRef(performance.now());

  const router = useRouter();

  const replaySupported =
    hasRobotModel(datasetInfo.robot_type) &&
    datasetInfo.codebase_version >= "v3.0";

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (typeof window !== "undefined") {
      const requested = tabId(
        new URLSearchParams(window.location.search).get("tab"),
      );
      if (
        TABS.includes(requested as ActiveTab) &&
        (requested !== "hands" || data.handTracking) &&
        (requested !== "replay" || replaySupported)
      )
        return requested as ActiveTab;
      const stored = tabId(sessionStorage.getItem("activeTab"));
      /// A tab saved on another dataset may not exist here (3D Replay needs a supported robot).
      if (
        TABS.includes(stored as ActiveTab) &&
        (stored !== "replay" || replaySupported) &&
        (stored !== "hands" || data.handTracking)
      ) {
        return stored as ActiveTab;
      }
    }
    return "episodes";
  });
  const isLoading = activeTab === "episodes" && (!videosReady || !chartsReady);

  useEffect(() => {
    if (!isLoading) {
      console.log(
        `[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? "✓" : "…"}, charts: ${chartsReady ? "✓" : "…"})`,
      );
    }
  }, [isLoading, videosReady, chartsReady]);
  const [framesFlaggedOnly, setFramesFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("framesFlaggedOnly") === "true"
      : false,
  );
  const [sidebarFlaggedOnly, setSidebarFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("sidebarFlaggedOnly") === "true"
      : false,
  );
  // Dataset-wide analyses, loaded when a tab first needs them and kept in a cache keyed by the
  // dataset: this component remounts on every episode change, and none of them depends on the
  // episode. Coming back to a tab, or opening another episode, finds them already there.
  const repoId = datasetInfo.repoId;
  const cacheKey = datasetCacheKey(repoId);
  const lengths = useCachedResource(
    episodeLengthsCache,
    cacheKey,
    activeTab === "statistics" || activeTab === "filtering",
    () => loadAllEpisodeLengths(repoId, datasetInfo.fps),
  );
  const frames = useCachedResource(
    episodeFramesCache,
    cacheKey,
    activeTab === "frames",
    async () => {
      const { version, info } = await getDatasetVersionAndInfo(repoId);
      return loadAllEpisodeFrameInfo(
        repoId,
        version,
        info as unknown as DatasetMetadata,
      );
    },
  );
  const crossEpisode = useCachedResource(
    crossEpisodeCache,
    cacheKey,
    activeTab === "insights" || activeTab === "filtering",
    async (onProgress) => {
      const { version, info } = await getDatasetVersionAndInfo(repoId);
      return loadCrossEpisodeActionVariance(
        repoId,
        version,
        info as unknown as DatasetMetadata,
        info.fps,
        { onProgress },
      );
    },
  );
  const schema = useCachedResource(
    datasetSchemaCache,
    cacheKey,
    activeTab === "statistics",
    () => loadDatasetSchema(repoId),
  );
  const episodeLengthStats = lengths.data;
  const crossEpData = crossEpisode.data;

  // Eagerly load the ReplayViewer bundle while the user is on the Episodes tab,
  // so the 3D Replay tab opens faster.
  useEffect(() => {
    if (replaySupported) {
      void import("@/components/replay-viewer");
    }
  }, [replaySupported]);

  // The address bar names the open tab, so a copied link (or Back, after following an episode link
  // out of an analysis tab) returns to this view. replaceState: switching tabs adds no history.
  useEffect(() => {
    const search = searchWithTab(window.location.search, activeTab, "episodes");
    if (search === window.location.search) return;
    const path = `${window.location.pathname}${search}`;
    window.history.replaceState({}, "", path);
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", path);
    });
  }, [activeTab]);

  // Persist UI state across episode navigations. One effect instead of
  // three near-identical writes — fewer commit hooks per render and the
  // intent (mirror three primitives to sessionStorage) reads as one unit.
  useEffect(() => {
    sessionStorage.setItem("activeTab", activeTab);
    sessionStorage.setItem("sidebarFlaggedOnly", String(sidebarFlaggedOnly));
    sessionStorage.setItem("framesFlaggedOnly", String(framesFlaggedOnly));
  }, [activeTab, sidebarFlaggedOnly, framesFlaggedOnly]);

  const handleTabChange = setActiveTab;

  // Not `useTime()`: any consumer of it re-renders on every playback tick,
  // which would redraw this whole component ~12×/s. <UrlTimeSync /> handles
  // the one thing here that needs `currentTime` (the ?t= URL writer).
  const { seek, setIsPlaying } = useTimeControls();
  /// Passed to the embedded lerobot-doctor Space, which follows `__theme` like any HF Space.
  const theme = useTheme();

  // ReplayViewer episode changer and play toggle — populated by ReplayViewer on mount
  const replayChangerRef = useRef<((ep: number) => void) | undefined>(
    undefined,
  );
  const replayPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const [replayEpisode, setReplayEpisode] = useState(episodeId);
  useEffect(() => setReplayEpisode(episodeId), [episodeId]);

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(episodes.length / pageSize);
  const paginatedEpisodes = episodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Mount-only: UrlTimeSync's replaceState goes through Next's patched
  // history and changes useSearchParams, so depending on it would re-seek
  // every camera to the floored second on each ?t= write. A new episode
  // remounts this component.
  useEffect(() => {
    const timeValue = parseFloat(
      new URLSearchParams(window.location.search).get("t") ?? "",
    );
    if (!isNaN(timeValue)) seek(timeValue);
  }, [seek]);

  // sync with parent window hf.co/spaces
  useEffect(() => {
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", window.location.pathname + window.location.search);
    });
  }, []);

  // Initialize page based on the current episode. Splitting this out from
  // the keyboard listener effect lets the listener attach exactly once.
  useEffect(() => {
    const episodeIndex = episodes.indexOf(episodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }
  }, [episodes, episodeId, pageSize]);

  // Mirror the values the keydown handler needs into a ref. Without this,
  // `useCallback` would produce a new handler whenever `activeTab` /
  // `episodeId` / `replayEpisode` changed, and the keydown effect would
  // detach + reattach the listener each time. Now the listener attaches
  // once and reads the latest state via the ref.
  // Vercel rule: advanced-event-handler-refs.
  const keyStateRef = useRef({ activeTab, episodeId, episodes, replayEpisode });
  keyStateRef.current = { activeTab, episodeId, episodes, replayEpisode };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const s = keyStateRef.current;
      const inTextEntry = isKeyboardFocusInsideTextEntry(e.target);

      if (key === " ") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "replay") {
          replayPlayToggleRef.current?.();
        } else {
          setIsPlaying((prev: boolean) => !prev);
        }
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (inTextEntry) return;
        e.preventDefault();
        if (s.activeTab === "replay") {
          const nextEp =
            key === "ArrowDown" ? s.replayEpisode + 1 : s.replayEpisode - 1;
          const lowest = s.episodes[0];
          const highest = s.episodes[s.episodes.length - 1];
          if (nextEp >= lowest && nextEp <= highest) {
            setReplayEpisode(nextEp);
            replayChangerRef.current?.(nextEp);
          }
        } else {
          const nextEpisodeId =
            key === "ArrowDown" ? s.episodeId + 1 : s.episodeId - 1;
          const lowestEpisodeId = s.episodes[0];
          const highestEpisodeId = s.episodes[s.episodes.length - 1];
          if (
            nextEpisodeId >= lowestEpisodeId &&
            nextEpisodeId <= highestEpisodeId
          ) {
            router.push(`./episode_${nextEpisodeId}`);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // router / setIsPlaying are stable; the rest is read via keyStateRef.
  }, [router, setIsPlaying]);

  // Pagination functions
  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const renderTab = (tab: ActiveTab, label: string, title?: string) => (
    <TabButton
      active={activeTab === tab}
      onClick={() => handleTabChange(tab)}
      label={label}
      title={title}
      /// Hovering 3D Replay is a strong hint it's next; get the meshes going.
      onPointerEnter={
        tab === "replay"
          ? () =>
              void import("@/components/replay-viewer").then((m) =>
                m.prefetchRobotModel(
                  datasetInfo.robot_type,
                  Object.keys(data.flatChartData[0] ?? {}),
                ),
              )
          : undefined
      }
    />
  );

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <UrlTimeSync />
      {/* Top tab bar */}
      <div className="relative z-30 flex items-center border-b border-line-subtle bg-[var(--surface-0)] shrink-0">
        {renderTab("episodes", "Episodes")}
        {replaySupported && renderTab("replay", "3D Replay")}
        <AdvancedTabsMenu
          activeTab={activeTab}
          onSelect={handleTabChange}
          handsAvailable={!!data.handTracking}
        />
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <ThemeToggle />
          <HfAuthButton variant="tab" />
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — on Episodes and 3D Replay tabs */}
        {(activeTab === "episodes" ||
          activeTab === "annotations" ||
          activeTab === "hands" ||
          activeTab === "replay") && (
          <Sidebar
            datasetInfo={datasetInfo}
            paginatedEpisodes={paginatedEpisodes}
            episodeId={activeTab === "replay" ? replayEpisode : episodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
            showFlaggedOnly={sidebarFlaggedOnly}
            onShowFlaggedOnlyChange={setSidebarFlaggedOnly}
            onEpisodeSelect={
              activeTab === "replay"
                ? (ep) => {
                    setReplayEpisode(ep);
                    replayChangerRef.current?.(ep);
                  }
                : activeTab === "annotations"
                  ? (ep) => router.push(`./episode_${ep}`)
                  : undefined
            }
          />
        )}

        {/* Main content */}
        <div
          className={`flex flex-col gap-4 p-4 flex-1 relative ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {isLoading && <Loading />}

          {activeTab === "episodes" && (
            <>
              <EpisodeHeader
                repoId={datasetInfo.repoId}
                episodeId={episodeId}
              />

              {/* Videos */}
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  onVideosReady={() => setVideosReady(true)}
                  handTracking={data.handTracking}
                />
              )}

              {/* Language Instruction */}
              {task && (
                <div className="mb-6 panel p-4">
                  <p className="text-[10px] uppercase tracking-wide text-fg-faint">
                    Language Instruction
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-sm text-fg">
                    {task
                      .split("\n")
                      .map((instruction: string, index: number) => (
                        <p key={index}>{instruction}</p>
                      ))}
                  </div>
                </div>
              )}

              {/* Graph */}
              <div className="mb-4">
                <Suspense fallback={null}>
                  <DataRecharts
                    data={chartDataGroups}
                    onChartsReady={() => setChartsReady(true)}
                  />
                </Suspense>
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "annotations" && (
            <div className="annotations-skin flex flex-col gap-4">
              <EpisodeHeader
                repoId={datasetInfo.repoId}
                episodeId={episodeId}
              />
              <AnnotationsPanel cameraKeys={videosInfo.map((v) => v.filename)}>
                {task && (
                  <div className="annotation-task">
                    <span className="section-kicker">Task</span>
                    <p>{task}</p>
                  </div>
                )}
                {videosInfo.length > 0 && (
                  <div className="annotation-videos">
                    <SimpleVideosPlayer
                      videosInfo={videosInfo}
                      onVideosReady={() => setVideosReady(true)}
                      handTracking={data.handTracking}
                    />
                  </div>
                )}
                <AnnotationsTimeline duration={data.duration} />
              </AnnotationsPanel>
            </div>
          )}

          {activeTab === "statistics" && (
            <StatsPanel
              datasetInfo={datasetInfo}
              episodeLengthStats={episodeLengthStats}
              loading={lengths.loading}
              schema={schema.data}
              schemaLoading={schema.loading}
            />
          )}

          {activeTab === "frames" && (
            <OverviewPanel
              data={
                frames.data ??
                (frames.failed
                  ? {
                      cameras: [],
                      framesByCamera: {},
                      totalEpisodes: datasetInfo.total_episodes,
                      halfFrameSec: 0.5 / (datasetInfo.fps || 30),
                    }
                  : null)
              }
              cameras={datasetInfo.cameras}
              loading={frames.loading}
              flaggedOnly={framesFlaggedOnly}
              onFlaggedOnlyChange={setFramesFlaggedOnly}
            />
          )}

          {activeTab === "insights" && (
            <Suspense fallback={<Loading />}>
              <ActionInsightsPanel
                flatChartData={data.flatChartData}
                fps={datasetInfo.fps}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={crossEpisode.loading}
                crossEpisodeProgress={crossEpisode.progress}
              />
            </Suspense>
          )}

          {activeTab === "filtering" && (
            <Suspense fallback={<Loading />}>
              <FilteringPanel
                repoId={datasetInfo.repoId}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={crossEpisode.loading}
                crossEpisodeProgress={crossEpisode.progress}
                episodeLengthStats={episodeLengthStats}
                flatChartData={data.flatChartData}
                onViewFlaggedEpisodes={() => {
                  setSidebarFlaggedOnly(true);
                  handleTabChange("episodes");
                }}
              />
            </Suspense>
          )}

          {activeTab === "doctor" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between px-1 pb-2 text-xs text-fg-muted">
                <span>
                  Dataset quality diagnostics &mdash; powered by{" "}
                  <a
                    href="https://github.com/jashshah999/lerobot-doctor"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-fg"
                  >
                    lerobot-doctor
                  </a>
                </span>
                <a
                  href={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg"
                >
                  Open in new tab
                </a>
              </div>
              <iframe
                src={`https://jashshah999-lerobot-doctor.hf.space/?dataset=${org}/${dataset}&__theme=${theme}`}
                title="lerobot-doctor"
                className="flex-1 w-full rounded-lg border border-line bg-[var(--surface-0)]"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            </div>
          )}

          {activeTab === "replay" && (
            <Suspense fallback={<Loading />}>
              <ReplayViewer
                data={data}
                org={org}
                dataset={dataset}
                episodeChangerRef={replayChangerRef}
                playToggleRef={replayPlayToggleRef}
              />
            </Suspense>
          )}
          {activeTab === "hands" && data.handTracking && (
            <>
              <EpisodeHeader
                repoId={datasetInfo.repoId}
                episodeId={episodeId}
              />
              <Suspense fallback={<Loading />}>
                <HandReplay
                  tracking={data.handTracking}
                  videosInfo={videosInfo}
                />
              </Suspense>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import DataRecharts from "@/components/data-recharts";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime } from "@/context/time-context";
import Sidebar from "@/components/side-nav";
import StatsPanel from "@/components/stats-panel";
import OverviewPanel from "@/components/overview-panel";
import Loading from "@/components/loading-component";
import { isSO101Robot } from "@/lib/so101-robot";
import {
  getAdjacentEpisodesVideoInfo,
  computeColumnMinMax,
  type EpisodeData,
  type ColumnMinMax,
  type EpisodeLengthStats,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
} from "./fetch-data";
import { fetchEpisodeLengthStats, fetchEpisodeFrames, fetchCrossEpisodeVariance } from "./actions";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
const ActionInsightsPanel = lazy(() => import("@/components/action-insights-panel"));

type ActiveTab = "episodes" | "statistics" | "frames" | "insights" | "urdf";

export default function EpisodeViewer({
  data,
  error,
  org,
  dataset,
}: {
  data?: EpisodeData;
  error?: string;
  org?: string;
  dataset?: string;
}) {
  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-red-400">
        <div className="max-w-xl p-8 rounded bg-slate-900 border border-red-500 shadow-lg">
          <h2 className="text-2xl font-bold mb-4">Something went wrong</h2>
          <p className="text-lg font-mono whitespace-pre-wrap mb-4">{error}</p>
        </div>
      </div>
    );
  }
  return (
    <TimeProvider duration={data!.duration}>
      <EpisodeViewerInner data={data!} org={org} dataset={dataset} />
    </TimeProvider>
  );
}

function EpisodeViewerInner({ data, org, dataset }: { data: EpisodeData; org?: string; dataset?: string }) {
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
  const isLoading = !videosReady || !chartsReady;

  const loadStartRef = useRef(performance.now());
  useEffect(() => {
    if (!isLoading) {
      console.log(`[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? '✓' : '…'}, charts: ${chartsReady ? '✓' : '…'})`);
    }
  }, [isLoading]);

  const router = useRouter();
  const searchParams = useSearchParams();

  // Tab state & lazy stats
  const [activeTab, setActiveTab] = useState<ActiveTab>("episodes");
  const [columnMinMax, setColumnMinMax] = useState<ColumnMinMax[] | null>(null);
  const [episodeLengthStats, setEpisodeLengthStats] = useState<EpisodeLengthStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadedRef = useRef(false);
  const [episodeFramesData, setEpisodeFramesData] = useState<EpisodeFramesData | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const framesLoadedRef = useRef(false);
  const [crossEpData, setCrossEpData] = useState<CrossEpisodeVarianceData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsLoadedRef = useRef(false);

  const loadStats = () => {
    if (statsLoadedRef.current) return;
    statsLoadedRef.current = true;
    setStatsLoading(true);
    setColumnMinMax(computeColumnMinMax(data.chartDataGroups));
    if (org && dataset) {
      fetchEpisodeLengthStats(org, dataset)
        .then((result) => setEpisodeLengthStats(result))
        .catch(() => {})
        .finally(() => setStatsLoading(false));
    } else {
      setStatsLoading(false);
    }
  };

  const loadFrames = () => {
    if (framesLoadedRef.current || !org || !dataset) return;
    framesLoadedRef.current = true;
    setFramesLoading(true);
    fetchEpisodeFrames(org, dataset)
      .then(setEpisodeFramesData)
      .catch(() => setEpisodeFramesData({ cameras: [], framesByCamera: {} }))
      .finally(() => setFramesLoading(false));
  };

  const loadInsights = () => {
    if (insightsLoadedRef.current || !org || !dataset) return;
    insightsLoadedRef.current = true;
    setInsightsLoading(true);
    fetchCrossEpisodeVariance(org, dataset)
      .then(setCrossEpData)
      .catch((err) => console.error("[cross-ep] Failed:", err))
      .finally(() => setInsightsLoading(false));
  };

  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === "statistics") loadStats();
    if (tab === "frames") loadFrames();
    if (tab === "insights") loadInsights();
  };

  // Use context for time sync
  const { currentTime, setCurrentTime, setIsPlaying, isPlaying } = useTime();

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(episodes.length / pageSize);
  const paginatedEpisodes = episodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  
  // Preload adjacent episodes' videos via <link rel="preload"> tags
  useEffect(() => {
    if (!org || !dataset) return;
    const links: HTMLLinkElement[] = [];

    getAdjacentEpisodesVideoInfo(org, dataset, episodeId, 2)
      .then((adjacentVideos) => {
        for (const ep of adjacentVideos) {
          for (const v of ep.videosInfo) {
            const link = document.createElement("link");
            link.rel = "preload";
            link.as = "video";
            link.href = v.url;
            document.head.appendChild(link);
            links.push(link);
      }
        }
      })
      .catch(() => {});

    return () => {
      links.forEach((l) => l.remove());
    };
  }, [org, dataset, episodeId]);

  // Initialize based on URL time parameter
  useEffect(() => {
    const timeParam = searchParams.get("t");
    if (timeParam) {
      const timeValue = parseFloat(timeParam);
      if (!isNaN(timeValue)) {
        setCurrentTime(timeValue);
      }
    }
  }, []);

  // sync with parent window hf.co/spaces
  useEffect(() => {
    postParentMessageWithParams((params: URLSearchParams) => {
      params.set("path", window.location.pathname + window.location.search);
    });
  }, []);

  // Initialize based on URL time parameter
  useEffect(() => {
    // Initialize page based on current episode
    const episodeIndex = episodes.indexOf(episodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }

    // Add keyboard event listener
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [episodes, episodeId, pageSize, searchParams]);

  // Only update URL ?t= param when the integer second changes
  const lastUrlSecondRef = useRef<number>(-1);
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(searchParams.toString());
      newParams.set("t", currentSec.toString());
      // Replace state instead of pushing to avoid navigation stack bloat
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
      postParentMessageWithParams((params: URLSearchParams) => {
        params.set("path", window.location.pathname + window.location.search);
      });
    }
  }, [isPlaying, currentTime, searchParams]);

  // Handle keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    const { key } = e;

    if (key === " ") {
      e.preventDefault();
      setIsPlaying((prev: boolean) => !prev);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      const nextEpisodeId = key === "ArrowDown" ? episodeId + 1 : episodeId - 1;
      const lowestEpisodeId = episodes[0];
      const highestEpisodeId = episodes[episodes.length - 1];

      if (
        nextEpisodeId >= lowestEpisodeId &&
        nextEpisodeId <= highestEpisodeId
      ) {
        router.push(`./episode_${nextEpisodeId}`);
      }
    }
  };

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

  return (
    <div className="flex flex-col h-screen max-h-screen bg-slate-950 text-gray-200">
      {/* Top tab bar */}
      <div className="flex items-center border-b border-slate-700 bg-slate-900 shrink-0">
        <button
          className={`px-6 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "episodes"
              ? "text-orange-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => handleTabChange("episodes")}
        >
          Episodes
          {activeTab === "episodes" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500" />
          )}
        </button>
        <button
          className={`px-6 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "statistics"
              ? "text-orange-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => handleTabChange("statistics")}
        >
          Statistics
          {activeTab === "statistics" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500" />
          )}
        </button>
        <button
          className={`px-6 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "frames"
              ? "text-orange-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => handleTabChange("frames")}
        >
          Frames
          {activeTab === "frames" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500" />
          )}
        </button>
        <button
          className={`px-6 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "insights"
              ? "text-orange-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => handleTabChange("insights")}
        >
          Action Insights
          {activeTab === "insights" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500" />
          )}
        </button>
        {isSO101Robot(datasetInfo.robot_type) && (
          <button
            className={`px-6 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === "urdf"
                ? "text-orange-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
            onClick={() => handleTabChange("urdf")}
          >
            3D Replay
            {activeTab === "urdf" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500" />
            )}
          </button>
        )}
      </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — only on Episodes tab */}
        {activeTab === "episodes" && (
          <Sidebar
            datasetInfo={datasetInfo}
            paginatedEpisodes={paginatedEpisodes}
            episodeId={episodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
          />
        )}

        {/* Main content */}
        <div
          className={`flex flex-col gap-4 p-4 flex-1 relative ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {isLoading && <Loading />}

          {activeTab === "episodes" && (
            <>
              <div className="flex items-center justify-start my-4">
                <a
                  href="https://github.com/huggingface/lerobot"
                  target="_blank"
                  className="block"
                >
                  <img
                    src="https://github.com/huggingface/lerobot/raw/main/media/readme/lerobot-logo-thumbnail.png"
                    alt="LeRobot Logo"
                    className="w-32"
                  />
                </a>

                <div>
                  <a
                    href={`https://huggingface.co/datasets/${datasetInfo.repoId}`}
                    target="_blank"
                  >
                    <p className="text-lg font-semibold">{datasetInfo.repoId}</p>
                  </a>

                  <p className="font-mono text-lg font-semibold">
                    episode {episodeId}
                  </p>
                </div>
              </div>

              {/* Videos */}
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}

              {/* Language Instruction */}
              {task && (
                <div className="mb-6 p-4 bg-slate-800 rounded-lg border border-slate-600">
                  <p className="text-slate-300">
                    <span className="font-semibold text-slate-100">Language Instruction:</span>
                  </p>
                  <div className="mt-2 text-slate-300">
                    {task.split('\n').map((instruction: string, index: number) => (
                      <p key={index} className="mb-1">
                        {instruction}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* Graph */}
              <div className="mb-4">
                <DataRecharts
                  data={chartDataGroups}
                  onChartsReady={() => setChartsReady(true)}
                />
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "statistics" && (
            <StatsPanel
              datasetInfo={datasetInfo}
              episodeId={episodeId}
              columnMinMax={columnMinMax}
              episodeLengthStats={episodeLengthStats}
              loading={statsLoading}
            />
          )}

          {activeTab === "frames" && (
            <OverviewPanel data={episodeFramesData} loading={framesLoading} />
          )}

          {activeTab === "insights" && (
            <Suspense fallback={<Loading />}>
              <ActionInsightsPanel
                flatChartData={data.flatChartData}
                fps={datasetInfo.fps}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
              />
            </Suspense>
          )}

          {activeTab === "urdf" && (
            <Suspense fallback={<Loading />}>
              <URDFViewer data={data} org={org} dataset={dataset} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

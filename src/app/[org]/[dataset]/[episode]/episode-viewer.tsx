"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { postParentMessageWithParams } from "@/utils/postParentMessage";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import DataRecharts from "@/components/data-recharts";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime } from "@/context/time-context";
import Sidebar from "@/components/side-nav";
import Loading from "@/components/loading-component";
import { getAdjacentEpisodesVideoInfo } from "./fetch-data";

export default function EpisodeViewer({
  data,
  error,
  org,
  dataset,
}: {
  data?: any;
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
    <TimeProvider duration={data.duration}>
      <EpisodeViewerInner data={data} org={org} dataset={dataset} />
    </TimeProvider>
  );
}

function EpisodeViewerInner({ data, org, dataset }: { data: any; org?: string; dataset?: string; }) {
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

  const router = useRouter();
  const searchParams = useSearchParams();

  // State
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
  
  // Preload adjacent episodes' videos
  useEffect(() => {
    if (!org || !dataset) return;
    
    const preloadAdjacent = async () => {
      try {
        await getAdjacentEpisodesVideoInfo(org, dataset, episodeId, 2);
        // Preload adjacent episodes for smoother navigation
      } catch {
        // Skip preloading on error
      }
    };
    
    preloadAdjacent();
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
    <div className="flex h-screen max-h-screen bg-slate-950 text-gray-200">
      {/* Sidebar */}
      <Sidebar
        datasetInfo={datasetInfo}
        paginatedEpisodes={paginatedEpisodes}
        episodeId={episodeId}
        totalPages={totalPages}
        currentPage={currentPage}
        prevPage={prevPage}
        nextPage={nextPage}
      />

      {/* Content */}
      <div
        className={`flex max-h-screen flex-col gap-4 p-4 md:flex-1 relative ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
      >
        {isLoading && <Loading />}

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
        {videosInfo.length && (
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
              {task.split('\n').map((instruction, index) => (
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
      </div>
    </div>
  );
}

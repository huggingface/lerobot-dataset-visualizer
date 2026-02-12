"use client";

import Link from "next/link";
import React from "react";

import type { DatasetDisplayInfo } from "@/app/[org]/[dataset]/[episode]/fetch-data";

interface SidebarProps {
  datasetInfo: DatasetDisplayInfo;
  paginatedEpisodes: number[];
  episodeId: number;
  totalPages: number;
  currentPage: number;
  prevPage: () => void;
  nextPage: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  datasetInfo,
  paginatedEpisodes,
  episodeId,
  totalPages,
  currentPage,
  prevPage,
  nextPage,
}) => {
  // On mobile, allow toggling; on desktop the sidebar is always visible
  const [mobileVisible, setMobileVisible] = React.useState(false);

  return (
    <div className="flex z-10 shrink-0">
      {/* Sidebar panel — always visible on md+, togglable on mobile */}
      <nav
        className={`shrink-0 overflow-y-auto bg-slate-900 p-5 break-words w-60 ${
          mobileVisible ? "block" : "hidden"
        } md:block`}
        aria-label="Sidebar navigation"
      >
        {/* Basic dataset info */}
        <ul className="text-sm text-slate-300 space-y-0.5">
          <li>Frames: {datasetInfo.total_frames.toLocaleString()}</li>
          <li>Episodes: {datasetInfo.total_episodes.toLocaleString()}</li>
          <li>FPS: {datasetInfo.fps}</li>
        </ul>

        <p className="mt-4 text-sm font-semibold text-slate-200">Episodes:</p>

        {/* Episodes list */}
        <div className="ml-2 mt-1">
          <ul>
            {paginatedEpisodes.map((episode) => (
              <li key={episode} className="mt-0.5 font-mono text-sm">
                <Link
                  href={`./episode_${episode}`}
                  className={`underline ${episode === episodeId ? "-ml-1 font-bold" : ""}`}
                >
                  Episode {episode}
                </Link>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="mt-3 flex items-center text-xs">
              <button
                onClick={prevPage}
                className={`mr-2 rounded bg-slate-800 px-2 py-1 ${
                  currentPage === 1 ? "cursor-not-allowed opacity-50" : ""
                }`}
                disabled={currentPage === 1}
              >
                « Prev
              </button>
              <span className="mr-2 font-mono">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={nextPage}
                className={`rounded bg-slate-800 px-2 py-1 ${
                  currentPage === totalPages
                    ? "cursor-not-allowed opacity-50"
                    : ""
                }`}
                disabled={currentPage === totalPages}
              >
                Next »
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* Mobile toggle button */}
      <button
        className="mx-1 flex items-center opacity-50 hover:opacity-100 focus:outline-none focus:ring-0 md:hidden"
        onClick={() => setMobileVisible((prev) => !prev)}
        title="Toggle sidebar"
      >
        <div className="h-10 w-2 rounded-full bg-slate-500" />
      </button>
    </div>
  );
};

export default Sidebar;

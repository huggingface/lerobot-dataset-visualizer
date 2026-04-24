"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";

import type { DatasetDisplayInfo } from "@/app/[org]/[dataset]/[episode]/fetch-data";

interface SidebarProps {
  datasetInfo: DatasetDisplayInfo;
  paginatedEpisodes: number[];
  episodeId: number;
  totalPages: number;
  currentPage: number;
  prevPage: () => void;
  nextPage: () => void;
  showFlaggedOnly: boolean;
  onShowFlaggedOnlyChange: (v: boolean) => void;
  onEpisodeSelect?: (ep: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  datasetInfo,
  paginatedEpisodes,
  episodeId,
  totalPages,
  currentPage,
  prevPage,
  nextPage,
  showFlaggedOnly,
  onShowFlaggedOnlyChange,
  onEpisodeSelect,
}) => {
  const [mobileVisible, setMobileVisible] = useState(false);
  const { flagged, count, toggle } = useFlaggedEpisodes();

  const displayEpisodes = useMemo(() => {
    if (!showFlaggedOnly || count === 0) return paginatedEpisodes;
    return [...flagged].sort((a, b) => a - b);
  }, [paginatedEpisodes, showFlaggedOnly, flagged, count]);

  return (
    <div className="flex z-10 shrink-0">
      <nav
        className={`shrink-0 overflow-y-auto bg-[var(--surface-0)] border-r border-white/5 p-4 break-words w-60 ${
          mobileVisible ? "block" : "hidden"
        } md:block`}
        aria-label="Sidebar navigation"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-400 tabular">
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            Frames
          </dt>
          <dd className="text-slate-200">
            {datasetInfo.total_frames.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            Episodes
          </dt>
          <dd className="text-slate-200">
            {datasetInfo.total_episodes.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-slate-500">
            FPS
          </dt>
          <dd className="text-slate-200">{datasetInfo.fps}</dd>
        </dl>

        <div className="mt-5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Episodes
          </p>
          {count > 0 && (
            <button
              onClick={() => onShowFlaggedOnlyChange(!showFlaggedOnly)}
              className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md transition-colors ${
                showFlaggedOnly
                  ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                  : "text-slate-500 hover:text-slate-300 border border-white/10"
              }`}
            >
              Flagged · {count}
            </button>
          )}
        </div>

        <ul className="mt-2 space-y-px">
          {displayEpisodes.map((episode) => {
            const active = episode === episodeId;
            const itemClass = `group flex items-center justify-between gap-2 px-2 py-1 rounded-md text-xs tabular transition-colors ${
              active
                ? "bg-cyan-400/10 text-cyan-300"
                : "text-slate-300 hover:bg-white/5"
            }`;
            return (
              <li key={episode}>
                {onEpisodeSelect ? (
                  <div className={itemClass}>
                    <button
                      onClick={() => onEpisodeSelect(episode)}
                      className="flex-1 text-left"
                    >
                      Episode {episode}
                    </button>
                    <button
                      onClick={() => toggle(episode)}
                      className={`text-xs leading-none transition-colors ${
                        flagged.has(episode)
                          ? "text-orange-400 hover:text-orange-300"
                          : "text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100"
                      }`}
                      title={flagged.has(episode) ? "Unflag" : "Flag"}
                    >
                      ⚑
                    </button>
                  </div>
                ) : (
                  <div className={itemClass}>
                    <Link
                      href={`./episode_${episode}`}
                      className="flex-1 text-left"
                    >
                      Episode {episode}
                    </Link>
                    <button
                      onClick={() => toggle(episode)}
                      className={`text-xs leading-none transition-colors ${
                        flagged.has(episode)
                          ? "text-orange-400 hover:text-orange-300"
                          : "text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100"
                      }`}
                      title={flagged.has(episode) ? "Unflag" : "Flag"}
                    >
                      ⚑
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {!showFlaggedOnly && totalPages > 1 && (
          <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
            <button
              onClick={prevPage}
              className={`px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === 1 ? "cursor-not-allowed opacity-40" : ""
              }`}
              disabled={currentPage === 1}
            >
              ‹ Prev
            </button>
            <span className="tabular text-slate-500">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={nextPage}
              className={`ml-auto px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === totalPages
                  ? "cursor-not-allowed opacity-40"
                  : ""
              }`}
              disabled={currentPage === totalPages}
            >
              Next ›
            </button>
          </div>
        )}
      </nav>

      <button
        className="mx-1 flex items-center opacity-50 hover:opacity-100 focus:outline-none focus:ring-0 md:hidden"
        onClick={() => setMobileVisible((prev) => !prev)}
        title="Toggle sidebar"
      >
        <div className="h-10 w-1 rounded-full bg-white/20" />
      </button>
    </div>
  );
};

export default Sidebar;

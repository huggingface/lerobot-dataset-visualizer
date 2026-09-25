"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
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

  /// A page holds 100 episodes; without this, opening episode 80 left its highlighted row off screen.
  /// Only scrolls when the row is out of view, so clicking a visible row doesn't make the list jump.
  const navRef = useRef<HTMLElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const item = activeItemRef.current?.getBoundingClientRect();
    const nav = navRef.current?.getBoundingClientRect();
    if (!item || !nav) return;
    if (item.top < nav.top || item.bottom > nav.bottom) {
      activeItemRef.current?.scrollIntoView({ block: "center" });
    }
  }, [episodeId, displayEpisodes]);

  return (
    <div className="flex z-10 shrink-0">
      <nav
        ref={navRef}
        className={`shrink-0 overflow-y-auto bg-[var(--surface-0)] border-r border-line-subtle p-4 break-words w-60 ${
          mobileVisible ? "block" : "hidden"
        } md:block`}
        aria-label="Sidebar navigation"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-fg-muted tabular">
          <dt className="uppercase tracking-wide text-[10px] text-fg-faint">
            Frames
          </dt>
          <dd className="text-fg">
            {datasetInfo.total_frames.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-fg-faint">
            Episodes
          </dt>
          <dd className="text-fg">
            {datasetInfo.total_episodes.toLocaleString()}
          </dd>
          <dt className="uppercase tracking-wide text-[10px] text-fg-faint">
            FPS
          </dt>
          <dd className="text-fg">{datasetInfo.fps}</dd>
        </dl>

        <div className="mt-5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-fg-faint">
            Episodes
          </p>
          {count > 0 && (
            <button
              onClick={() => onShowFlaggedOnlyChange(!showFlaggedOnly)}
              className={`btn px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                showFlaggedOnly ? "btn-flagged" : ""
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
                ? "bg-cyan-400/10 text-accent-fg"
                : "text-fg-soft hover:bg-fill"
            }`;
            return (
              <li key={episode} ref={active ? activeItemRef : undefined}>
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
                          ? "text-orange-400 hover:text-flag-fg"
                          : "text-fg-faint hover:text-fg-muted opacity-0 group-hover:opacity-100"
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
                          ? "text-orange-400 hover:text-flag-fg"
                          : "text-fg-faint hover:text-fg-muted opacity-0 group-hover:opacity-100"
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
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={prevPage}
              className="btn"
              disabled={currentPage === 1}
            >
              ‹ Prev
            </button>
            <span className="tabular text-xs text-fg-faint">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={nextPage}
              className="btn ml-auto"
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
        <div className="h-10 w-1 rounded-full bg-fill-strong" />
      </button>
    </div>
  );
};

export default Sidebar;

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

const COLLAPSED_KEY = "lerobot-viz-sidebar-collapsed";
const SMALL_SCREEN = "(max-width: 767px)";

function useIsSmallScreen(): boolean {
  const [small, setSmall] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(SMALL_SCREEN).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(SMALL_SCREEN);
    const onChange = () => setSmall(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return small;
}

function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d={open ? "m16 15-3-3 3-3" : "m14 9 3 3-3 3"} />
    </svg>
  );
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
  const isSmall = useIsSmallScreen();
  // Desktop remembers whether the list was collapsed; on a small screen the
  // list is a drawer over the content, so it starts closed.
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    if (window.matchMedia(SMALL_SCREEN).matches) return false;
    try {
      return localStorage.getItem(COLLAPSED_KEY) !== "true";
    } catch {
      return true;
    }
  });
  const setOpenAndRemember = (next: boolean) => {
    setOpen(next);
    if (isSmall) return;
    try {
      localStorage.setItem(COLLAPSED_KEY, String(!next));
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  };
  const closeDrawer = () => {
    if (isSmall) setOpen(false);
  };
  useEffect(() => {
    if (!isSmall || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSmall, open]);
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

  // Collapsed (and always on a small screen) a slim rail stays in place, so the
  // list can't vanish without a way back.
  const rail = (
    <div className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-line-subtle bg-[var(--surface-0)] py-3">
      <button
        onClick={() => setOpenAndRemember(true)}
        title="Show episode list"
        aria-label="Show episode list"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg"
      >
        <PanelIcon open={false} />
      </button>
      <span className="rotate-180 text-[10px] uppercase tracking-wide text-fg-faint tabular [writing-mode:vertical-rl]">
        Episode · {episodeId}
      </span>
    </div>
  );

  return (
    <div className="relative z-20 flex shrink-0">
      {(isSmall || !open) && rail}
      {open && isSmall && (
        <div
          className="fixed inset-0 z-20 bg-black/30"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      {open && (
        <nav
          ref={navRef}
          className={`shrink-0 overflow-y-auto bg-[var(--surface-0)] border-r border-line-subtle p-4 break-words w-60 ${
            isSmall ? "absolute inset-y-0 left-0 z-30 shadow-xl" : ""
          }`}
          aria-label="Sidebar navigation"
        >
          <div className="flex items-start justify-between gap-2">
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
            <button
              onClick={() => setOpenAndRemember(false)}
              title="Hide episode list"
              aria-label="Hide episode list"
              className="-mr-2 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg"
            >
              <PanelIcon open />
            </button>
          </div>

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
                        onClick={() => {
                          onEpisodeSelect(episode);
                          closeDrawer();
                        }}
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
                        onClick={closeDrawer}
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
      )}
    </div>
  );
};

export default Sidebar;

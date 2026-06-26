"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ExploreDataset } from "@/types/dataset.types";
import { fetchPreview } from "@/utils/exploreData";
import { formatBytes } from "@/utils/explore-facets";
import { ROBOT_DISPLAY_NAMES } from "@/utils/constants";

/** Best display label for the card's robot chip: prefer the exact robot_type from
 *  info.json (once loaded), else the first curated robot tag. */
function robotLabel(
  ds: ExploreDataset,
  robotType: string | null,
): string | null {
  if (robotType)
    return ROBOT_DISPLAY_NAMES[robotType.toLowerCase()] ?? robotType;
  if (ds.robotTags.length) {
    return ROBOT_DISPLAY_NAMES[ds.robotTags[0]] ?? ds.robotTags[0];
  }
  return null;
}

export default function DatasetCard({ ds }: { ds: ExploreDataset }) {
  const rootRef = useRef<HTMLAnchorElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [robotType, setRobotType] = useState<string | null>(null);

  // Mark the card visible once it scrolls near the viewport (fire-once).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Lazily fetch the preview video + exact robot_type once visible.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchPreview(ds.id).then((preview) => {
      if (cancelled) return;
      setVideoUrl(preview.videoUrl);
      setRobotType(preview.robotType);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, ds.id]);

  const robot = robotLabel(ds, robotType);

  return (
    <Link
      ref={rootRef}
      href={`/${ds.id}`}
      className="relative rounded-md overflow-hidden h-48 flex items-end group panel hover:border-cyan-400/40 transition-colors"
      onMouseEnter={() => {
        videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const vid = videoRef.current;
        if (vid) {
          vid.pause();
          vid.currentTime = 0;
        }
      }}
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className="absolute top-0 left-0 w-full h-full object-cover object-center z-0"
          loop
          muted
          playsInline
          preload="metadata"
          onTimeUpdate={(e) => {
            const vid = e.currentTarget;
            if (vid.currentTime >= 15) {
              vid.pause();
              vid.currentTime = 0;
            }
          }}
        />
      ) : (
        <div className="absolute inset-0 z-0 bg-[var(--surface-2)]/40" />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent z-10 pointer-events-none" />

      {/* Size + robot chips */}
      <div className="absolute top-2 left-2 z-20 flex flex-wrap gap-1">
        {ds.sizeBytes != null && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium tabular bg-black/50 text-slate-200 backdrop-blur-sm">
            {formatBytes(ds.sizeBytes)}
          </span>
        )}
        {robot && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-400/20 text-cyan-200 backdrop-blur-sm">
            {robot}
          </span>
        )}
      </div>

      <div className="relative z-20 w-full px-3 py-2 text-xs text-slate-200 truncate">
        {ds.id}
      </div>
    </Link>
  );
}

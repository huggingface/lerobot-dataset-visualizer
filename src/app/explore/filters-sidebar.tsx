"use client";

import React, { useState } from "react";
import { FaChevronDown, FaChevronRight } from "react-icons/fa";
import type {
  FacetGroup,
  FacetGroupId,
  FacetSelection,
} from "@/utils/explore-facets";

interface Props {
  facets: FacetGroup[];
  selection: FacetSelection;
  onToggle: (group: FacetGroupId, value: string) => void;
  onClearAll: () => void;
  activeCount: number;
}

const MAX_VISIBLE = 8;

function FacetSection({
  group,
  selected,
  onToggle,
}: {
  group: FacetGroup;
  selected: Set<string>;
  onToggle: (group: FacetGroupId, value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // Show options that have results, plus any currently-selected value (even at 0).
  const visible = group.options.filter(
    (o) => o.count > 0 || selected.has(o.value),
  );
  const shown = expanded ? visible : visible.slice(0, MAX_VISIBLE);
  if (visible.length === 0) return null;

  return (
    <div className="border-b border-white/5 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">
          {group.label}
        </span>
        {open ? (
          <FaChevronDown className="w-2.5 h-2.5 text-slate-500" />
        ) : (
          <FaChevronRight className="w-2.5 h-2.5 text-slate-500" />
        )}
      </button>

      {open && (
        <ul className="mt-2 space-y-px">
          {shown.map((o) => {
            const checked = selected.has(o.value);
            return (
              <li key={o.value}>
                <button
                  onClick={() => onToggle(group.id, o.value)}
                  className={`group flex items-center gap-2 w-full px-1.5 py-1 rounded-md text-xs transition-colors ${
                    checked
                      ? "bg-cyan-400/10 text-cyan-200"
                      : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded border transition-colors ${
                      checked
                        ? "bg-cyan-400 border-cyan-400 text-[var(--surface-0)]"
                        : "border-white/20 group-hover:border-white/40"
                    }`}
                  >
                    {checked && (
                      <svg
                        viewBox="0 0 12 12"
                        className="w-2.5 h-2.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path
                          d="M2.5 6.5 5 9l4.5-5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 text-left truncate" title={o.label}>
                    {o.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {o.count.toLocaleString()}
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length > MAX_VISIBLE && (
            <li>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="px-1.5 py-1 text-[11px] text-cyan-300/80 hover:text-cyan-200 transition-colors"
              >
                {expanded
                  ? "Show less"
                  : `Show ${visible.length - MAX_VISIBLE} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function FiltersSidebar({
  facets,
  selection,
  onToggle,
  onClearAll,
  activeCount,
}: Props) {
  const [mobileVisible, setMobileVisible] = useState(false);

  return (
    <div className="flex z-10 shrink-0">
      <aside
        className={`shrink-0 overflow-y-auto bg-[var(--surface-0)] border-r border-white/5 p-4 w-64 md:sticky md:top-0 md:h-screen ${
          mobileVisible ? "block" : "hidden"
        } md:block`}
        aria-label="Dataset filters"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-slate-200">Filters</h2>
          {activeCount > 0 && (
            <button
              onClick={onClearAll}
              className="text-[11px] bg-cyan-400/15 text-cyan-300 border border-cyan-400/40 rounded px-2 py-0.5 hover:bg-cyan-400/20 transition-colors"
            >
              Clear · {activeCount}
            </button>
          )}
        </div>

        {facets.map((group) => (
          <FacetSection
            key={group.id}
            group={group}
            selected={selection[group.id]}
            onToggle={onToggle}
          />
        ))}
      </aside>

      <button
        className="mx-1 flex items-center opacity-50 hover:opacity-100 focus:outline-none md:hidden"
        onClick={() => setMobileVisible((v) => !v)}
        title="Toggle filters"
      >
        <div className="h-10 w-1 rounded-full bg-white/20" />
      </button>
    </div>
  );
}

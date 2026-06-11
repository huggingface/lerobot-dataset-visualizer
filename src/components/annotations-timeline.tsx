"use client";

/**
 * Multi-track timeline for v3.1 language atoms — like a video-editing
 * scrubber, but stacked vertically by style and split into two banded
 * sections that mirror the two language columns:
 *
 *   PERSISTENT (language_persistent — broadcast across every frame):
 *   - task_aug: task phrasings shown as point-in-time ticks at episode start.
 *   - subtask: filled spans from each emit time until the next subtask emit
 *     (or episode end). Numbered. Resizable edges; the empty subtask track
 *     also accepts drag-to-create.
 *   - plan: filled (read-only) spans from each plan emit until the next plan
 *     refresh (or episode end) — a plan is the active state until superseded,
 *     so it reads as a span, not an instantaneous event.
 *   - memory: tick marks (state snapshots captured at subtask boundaries).
 *
 *   EVENTS (language_events — fire on a single frame):
 *   - interjections + speech: combined event track.
 *   - vqa: event track.
 *
 * Interactions:
 *   - Click a marker → seek + select (handled by the panel's listening to
 *     `selectAtom` via context).
 *   - Drag a subtask span's left edge → retime that subtask's start.
 *   - Drag a subtask span's right edge → retime the *next* subtask's start
 *     (since the right edge of subtask[i] *is* the start of subtask[i+1]).
 *   - Drag from empty area on the subtask track → create a new subtask span;
 *     a label popup appears at the draw end so you can name it.
 *   - Drag the playhead handle (or click anywhere on the track band) → scrub
 *     the video time. Pauses the player while dragging.
 *   - Hover over any marker → custom tooltip shows the atom's content.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTime } from "../context/time-context";
import { useAnnotations } from "../context/annotations-context";
import {
  classifyVqa,
  isSpeechAtom,
  parseVqaAnswer,
  type LanguageAtom,
} from "../types/language.types";

const LABEL_WIDTH = 84;
const DRAG_THRESHOLD_PX = 4;

// `render` controls how a lane draws: "span-edit" = resizable + drag-to-create
// (subtask), "span-ro" = read-only spans (task_aug / plan), "tick" = point
// markers.
const TRACK_GROUPS = [
  {
    column: "persistent",
    title: "Persistent",
    sub: "language_persistent · broadcast across every frame",
    tracks: [
      // task_aug applies to the whole episode (it's a rephrasing of the task,
      // stored at t0 but persistent across every frame), so it reads as a
      // full-episode span — matching how the annotation pipeline treats it.
      // We collapse all rephrasings into a single full-width bar with a ×N badge;
      // clicking opens a popover listing every phrasing.
      {
        key: "task_aug",
        label: "task aug",
        color: "#38bdf8",
        render: "task-aug",
      },
      {
        key: "subtask",
        label: "subtask",
        color: "#ffd21e",
        render: "span-edit",
      },
      { key: "plan", label: "plan", color: "#5b8cff", render: "span-ro" },
      { key: "memory", label: "memory", color: "#b78bff", render: "tick" },
    ],
  },
  {
    column: "events",
    title: "Events",
    sub: "language_events · fire on a single frame",
    tracks: [
      {
        key: "interjection",
        label: "speech",
        color: "#ef5350",
        render: "tick",
      },
      { key: "vqa", label: "vqa", color: "#34d399", render: "tick" },
    ],
  },
] as const;

interface Props {
  /** Episode duration in seconds. */
  duration: number;
}

interface Tooltip {
  x: number;
  y: number;
  meta: string;
  text: string;
}

interface DragState {
  kind: "edge" | "playhead" | "create";
  /** Atom index whose timestamp is being moved (edge / create). */
  atomIdx?: number;
  /** Episode-second timestamps captured at drag start (for cancel/clamp). */
  origTs?: number;
  prevTs?: number; // previous subtask's timestamp (lower bound)
  nextTs?: number; // next subtask's timestamp (upper bound, exclusive)
  /** For drag-to-create only. */
  startTs?: number;
  endTs?: number;
}

interface PendingCreate {
  start: number;
  end: number;
  /** Anchor for the label popup (canvas-relative px). */
  anchorX: number;
  anchorY: number;
}

export const AnnotationsTimeline: React.FC<Props> = ({ duration }) => {
  const { atoms, addAtom, updateAtom, snap, selectAtom } = useAnnotations();
  const { currentTime, seek, setIsPlaying } = useTime();
  const trackBandRef = useRef<HTMLDivElement | null>(null);

  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [createLabel, setCreateLabel] = useState("");

  // Pause + select helper
  const jumpAndSelect = React.useCallback(
    (ts: number, idx: number | null) => {
      seek(ts, "external");
      setIsPlaying(false);
      if (idx != null) selectAtom(idx);
    },
    [seek, setIsPlaying, selectAtom],
  );

  // ============ Lane derivation ============
  const lanes = useMemo(() => {
    type SpanMarker = {
      kind: "span";
      start: number;
      end: number;
      label: string;
      atom: LanguageAtom;
      atomIdx: number; // index of the *start* atom in atoms[]
    };
    type TickMarker = {
      kind: "tick";
      t: number;
      label: string;
      atom: LanguageAtom;
      atomIdx: number;
      subtype?: string;
    };

    const subtask: SpanMarker[] = [];
    const task_aug: SpanMarker[] = [];
    const plan: SpanMarker[] = [];
    const memory: TickMarker[] = [];
    const interjection: TickMarker[] = [];
    const vqa: TickMarker[] = [];

    // Subtasks → spans, sorted by ts. Track the original atom index so drag
    // operations can update via updateAtom(idx, ...).
    const subWithIdx = atoms
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.style === "subtask")
      .sort((x, y) => x.a.timestamp - y.a.timestamp);
    subWithIdx.forEach(({ a, i }, k) => {
      const start = a.timestamp;
      const end =
        k + 1 < subWithIdx.length ? subWithIdx[k + 1].a.timestamp : duration;
      subtask.push({
        kind: "span",
        start,
        end,
        label: a.content || "",
        atom: a,
        atomIdx: i,
      });
    });

    // Plans → read-only spans: a plan is the active state from its emit time
    // until the next plan refresh (or episode end), exactly like a subtask
    // span. Rendering it as a span (not a tick) makes its persistent nature
    // visible — it isn't a point-in-time event.
    const planWithIdx = atoms
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.style === "plan")
      .sort((x, y) => x.a.timestamp - y.a.timestamp);
    planWithIdx.forEach(({ a, i }, k) => {
      const start = a.timestamp;
      const end =
        k + 1 < planWithIdx.length ? planWithIdx[k + 1].a.timestamp : duration;
      plan.push({
        kind: "span",
        start,
        end,
        label: a.content || "plan",
        atom: a,
        atomIdx: i,
      });
    });

    // Task augmentations → full-episode spans: each is a rephrasing of the
    // task and applies to the whole episode (persistent, stored at t0), so it
    // spans [t0, t_last] rather than sitting as a tick at the start.
    atoms.forEach((a, i) => {
      if (a.style === "task_aug") {
        task_aug.push({
          kind: "span",
          start: 0,
          end: duration,
          label: a.content || "task augmentation",
          atom: a,
          atomIdx: i,
        });
      }
    });

    atoms.forEach((a, i) => {
      if (a.style === "memory") {
        memory.push({
          kind: "tick",
          t: a.timestamp,
          label: a.content || "memory",
          atom: a,
          atomIdx: i,
        });
      } else if (a.style === "interjection" || isSpeechAtom(a)) {
        interjection.push({
          kind: "tick",
          t: a.timestamp,
          label: a.style === "interjection" ? a.content || "" : "say(…)",
          atom: a,
          atomIdx: i,
          subtype: a.style === "interjection" ? "user" : "speech",
        });
      } else if (a.style === "vqa" && a.role === "assistant") {
        const parsed = parseVqaAnswer(a.content);
        const kind = parsed ? classifyVqa(parsed) : null;
        vqa.push({
          kind: "tick",
          t: a.timestamp,
          label: kind || "vqa",
          atom: a,
          atomIdx: i,
          subtype: kind || undefined,
        });
      }
    });

    return { task_aug, subtask, plan, memory, interjection, vqa, subWithIdx };
  }, [atoms, duration]);

  // ============ Pixel <-> time mapping ============
  // The full-width track band (no label margin) is `trackBandRef`. Convert
  // mouse client.x to a 0..duration timestamp.
  const trackXToTs = (clientX: number): number => {
    const r = trackBandRef.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return frac * duration;
  };

  // ============ Event-track click → seek + select ============
  const onTickClick = (e: React.MouseEvent, atomIdx: number, t: number) => {
    e.stopPropagation();
    jumpAndSelect(t, atomIdx);
  };

  // ============ task_aug collapsed-bar click ============
  // All phrasings share t0, so there is no spatial way to disambiguate them
  // on the track — clicking just selects the first one (the full list is
  // shown on hover). The inspector + rail still expose every rewording.
  const onTaskAugClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const augs = lanes.task_aug;
    if (augs.length === 0) return;
    jumpAndSelect(0, augs[0].atomIdx);
  };

  // ============ Subtask span drag ============
  const onSpanBodyClick = (
    e: React.MouseEvent,
    atomIdx: number,
    start: number,
  ) => {
    if (drag || pendingCreate) return;
    e.stopPropagation();
    jumpAndSelect(start, atomIdx);
  };

  const onEdgeDown = (
    e: React.PointerEvent,
    side: "l" | "r",
    spanK: number,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const sub = lanes.subWithIdx;
    // Left edge of span k → moves sub[k] timestamp.
    // Right edge of span k → moves sub[k+1] timestamp (if exists).
    const idxToMove = side === "l" ? spanK : spanK + 1;
    if (idxToMove < 0 || idxToMove >= sub.length) return;
    const target = sub[idxToMove];
    const lower = idxToMove > 0 ? sub[idxToMove - 1].a.timestamp : 0;
    const upper =
      idxToMove + 1 < sub.length ? sub[idxToMove + 1].a.timestamp : duration;
    setDrag({
      kind: "edge",
      atomIdx: target.i,
      origTs: target.a.timestamp,
      prevTs: lower,
      nextTs: upper,
    });
  };

  // ============ Drag-to-create new subtask span ============
  const onSubtaskTrackDown = (e: React.PointerEvent) => {
    // Only fire when the mousedown lands on the track itself, not on a
    // child span/edge (those stop propagation in their own handlers).
    if (drag || pendingCreate) return;
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const ts = snap(trackXToTs(e.clientX));
    setDrag({ kind: "create", startTs: ts, endTs: ts });
  };

  // ============ Playhead drag ============
  const onPlayheadDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setIsPlaying(false);
    setDrag({ kind: "playhead" });
  };

  const onTrackBandClick = (e: React.MouseEvent) => {
    // Clicks anywhere on the track band that bubbled up: seek to that point.
    if (drag || pendingCreate) return;
    if ((e.target as HTMLElement).dataset.role === "ruler") {
      // Already handled by the dedicated ruler bar
    }
    const ts = trackXToTs(e.clientX);
    seek(ts, "external");
    setIsPlaying(false);
  };

  // ============ Global pointermove / pointerup for drag commits ============
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const ts = trackXToTs(e.clientX);
      if (drag.kind === "playhead") {
        seek(Math.max(0, Math.min(duration, ts)), "external");
        return;
      }
      if (drag.kind === "edge" && drag.atomIdx != null) {
        const lower = drag.prevTs ?? 0;
        const upper = drag.nextTs ?? duration;
        const clamped = Math.max(lower + 0.001, Math.min(upper - 0.001, ts));
        const snapped = snap(clamped);
        updateAtom(drag.atomIdx, { timestamp: snapped });
        return;
      }
      if (drag.kind === "create") {
        const snapped = snap(Math.max(0, Math.min(duration, ts)));
        setDrag((d) => (d ? { ...d, endTs: snapped } : d));
      }
    };
    const up = (e: PointerEvent) => {
      if (drag.kind === "create") {
        const a = Math.min(drag.startTs ?? 0, drag.endTs ?? 0);
        const b = Math.max(drag.startTs ?? 0, drag.endTs ?? 0);
        const distFrac = Math.abs(b - a) / Math.max(0.001, duration);
        // Need at least a few px of drag to count, otherwise treat as click.
        const trackWidth =
          trackBandRef.current?.getBoundingClientRect().width ?? 1;
        if (distFrac * trackWidth >= DRAG_THRESHOLD_PX) {
          // Anchor the label popup at the upper-right of the new span.
          const r = trackBandRef.current?.getBoundingClientRect();
          if (r) {
            const xFrac = b / Math.max(0.001, duration);
            setPendingCreate({
              start: a,
              end: b,
              anchorX: r.left + xFrac * r.width + 4,
              anchorY: r.top - 8,
            });
          }
        } else {
          // Tap, not drag — treat as a seek to that point.
          seek(a, "external");
          setIsPlaying(false);
        }
      } else if (drag.kind === "edge" && drag.atomIdx != null) {
        // Already updated in `move`; nothing more to do beyond final snap.
      }
      setDrag(null);
      // We don't release pointerCapture here because the original target is
      // already cleaned up by the browser when we release the pointer.
      void e;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, duration, seek, setIsPlaying, snap, updateAtom]);

  // ============ Tooltip helpers ============
  const showTip = (e: React.MouseEvent, meta: string, text: string) => {
    setTooltip({
      x: e.clientX + 12,
      y: e.clientY + 12,
      meta,
      text,
    });
  };
  const moveTip = (e: React.MouseEvent) => {
    setTooltip((t) => (t ? { ...t, x: e.clientX + 12, y: e.clientY + 12 } : t));
  };
  const hideTip = () => setTooltip(null);

  // ============ Pending-create label popup commit ============
  const commitPendingCreate = () => {
    if (!pendingCreate) return;
    const text = createLabel.trim();
    if (!text) {
      setPendingCreate(null);
      setCreateLabel("");
      return;
    }
    addAtom({
      role: "assistant",
      content: text,
      style: "subtask",
      timestamp: snap(pendingCreate.start),
      camera: null,
      tool_calls: null,
    });
    // The next subtask boundary is implicit (next sibling's timestamp); if
    // the user wants a different end they can drag the right edge afterwards.
    setPendingCreate(null);
    setCreateLabel("");
  };
  const cancelPendingCreate = () => {
    setPendingCreate(null);
    setCreateLabel("");
  };

  // ============ Render ============
  if (!duration) return null;

  return (
    <div className="tl">
      <div className="tl-head">
        <span>Annotations timeline</span>
        <span className="ts-display">
          {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
      </div>

      {/* Time-axis ruler — clicking it scrubs */}
      <div
        className="tl-ruler"
        data-role="ruler"
        onClick={(e) => {
          const ts = trackXToTs(e.clientX);
          seek(ts, "external");
          setIsPlaying(false);
        }}
      >
        {Array.from({ length: Math.floor(duration / 5) + 1 }).map((_, i) => {
          const t = i * 5;
          const left = (t / duration) * 100;
          return (
            <div key={i} className="tick-mark" style={{ left: `${left}%` }}>
              {t}s
            </div>
          );
        })}
      </div>

      {/* Tracks, grouped into Persistent / Events sections that mirror the
           two language columns. The whole region is position:relative so the
           playhead can span its full height via top/bottom (no brittle
           per-track pixel math that section headers would throw off). The
           playhead's x uses calc() to start at the track band's left edge
           (after the LABEL_WIDTH label column + 10px gap). */}
      {(() => {
        const bandLeft = `${LABEL_WIDTH + 10}px`;
        const playheadLeft = `calc(${bandLeft} + ${
          duration ? currentTime / duration : 0
        } * (100% - ${bandLeft}))`;
        return (
          <div className="tl-tracks" style={{ position: "relative" }}>
            {TRACK_GROUPS.map((group) => (
              <div className="tl-section" key={group.column}>
                <div className={`tl-section-head ${group.column}`}>
                  <span className="tl-section-title">{group.title}</span>
                  <span className="tl-section-sub">{group.sub}</span>
                </div>
                {group.tracks.map((tk) => (
                  <div className="tl-row" key={tk.key}>
                    <div className="label">
                      <span className={`style-dot dot-${tk.key}`} />
                      {tk.label}
                    </div>
                    <div
                      className={`track ${
                        tk.key === "subtask" && drag?.kind === "create"
                          ? "creating"
                          : ""
                      }`}
                      ref={tk.key === "subtask" ? trackBandRef : undefined}
                      onClick={
                        tk.render === "span-edit" ? undefined : onTrackBandClick
                      }
                      onPointerDown={
                        tk.key === "subtask" ? onSubtaskTrackDown : undefined
                      }
                    >
                      {/* Editable subtask spans (resize + drag-to-create) */}
                      {tk.render === "span-edit" &&
                        lanes.subtask.map((s, k) => {
                          const left = (s.start / duration) * 100;
                          const width = Math.max(
                            0.3,
                            ((s.end - s.start) / duration) * 100,
                          );
                          return (
                            <div
                              key={k}
                              className={`tl-seg subtask ${drag?.kind === "edge" && drag.atomIdx === s.atomIdx ? "dragging" : ""}`}
                              style={{ left: `${left}%`, width: `${width}%` }}
                              onClick={(e) =>
                                onSpanBodyClick(e, s.atomIdx, s.start)
                              }
                              onMouseEnter={(e) =>
                                showTip(
                                  e,
                                  `subtask · ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s`,
                                  s.label,
                                )
                              }
                              onMouseMove={moveTip}
                              onMouseLeave={hideTip}
                            >
                              <span style={{ opacity: 0.7, fontSize: 10 }}>
                                {k}
                              </span>
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {s.label}
                              </span>
                              <div
                                className="resize l"
                                onPointerDown={(e) => onEdgeDown(e, "l", k)}
                              />
                              {k + 1 < lanes.subtask.length && (
                                <div
                                  className="resize r"
                                  onPointerDown={(e) => onEdgeDown(e, "r", k)}
                                />
                              )}
                            </div>
                          );
                        })}

                      {/* Drag-to-create preview rectangle (subtask only) */}
                      {tk.render === "span-edit" && drag?.kind === "create" && (
                        <div
                          className="tl-create-preview"
                          style={{
                            left: `${(Math.min(drag.startTs ?? 0, drag.endTs ?? 0) / duration) * 100}%`,
                            width: `${(Math.abs((drag.endTs ?? 0) - (drag.startTs ?? 0)) / duration) * 100}%`,
                          }}
                        />
                      )}

                      {/* Collapsed task-augmentation bar: one full-width bar
                          (rephrasings carry no temporal info), with a ×N badge
                          when there is more than one. Click selects the single
                          phrasing, or opens the rewordings popover. */}
                      {tk.render === "task-aug" &&
                        lanes.task_aug.length > 0 &&
                        (() => {
                          const augs = lanes.task_aug;
                          const primary = augs[0];
                          const count = augs.length;
                          return (
                            <div
                              className="tl-seg task_aug"
                              style={{ left: "0%", width: "100%" }}
                              onClick={onTaskAugClick}
                              onMouseEnter={(e) =>
                                showTip(
                                  e,
                                  `task aug · ${count} phrasing${count > 1 ? "s" : ""}`,
                                  count > 1
                                    ? augs.map((s) => `• ${s.label}`).join("\n")
                                    : primary.label,
                                )
                              }
                              onMouseMove={moveTip}
                              onMouseLeave={hideTip}
                            >
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {primary.label}
                              </span>
                              {count > 1 && (
                                <span className="aug-count">×{count}</span>
                              )}
                            </div>
                          );
                        })()}

                      {/* Read-only persistent spans (plan is active until its
                          next refresh). Click seeks + selects; no resize. */}
                      {tk.render === "span-ro" &&
                        (
                          lanes[tk.key as "plan"] as Array<{
                            kind: "span";
                            start: number;
                            end: number;
                            label: string;
                            atom: LanguageAtom;
                            atomIdx: number;
                          }>
                        ).map((s, k) => {
                          const left = (s.start / duration) * 100;
                          const width = Math.max(
                            0.3,
                            ((s.end - s.start) / duration) * 100,
                          );
                          return (
                            <div
                              key={k}
                              className={`tl-seg ${tk.key}`}
                              style={{ left: `${left}%`, width: `${width}%` }}
                              onClick={(e) =>
                                onSpanBodyClick(e, s.atomIdx, s.start)
                              }
                              onMouseEnter={(e) =>
                                showTip(
                                  e,
                                  `${tk.label} · ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s`,
                                  s.label,
                                )
                              }
                              onMouseMove={moveTip}
                              onMouseLeave={hideTip}
                            >
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {s.label}
                              </span>
                            </div>
                          );
                        })}

                      {/* Point-in-time tick markers (task_aug / memory /
                          interjection / vqa) */}
                      {tk.render === "tick" &&
                        (
                          lanes[
                            tk.key as "memory" | "interjection" | "vqa"
                          ] as Array<{
                            kind: "tick";
                            t: number;
                            label: string;
                            atom: LanguageAtom;
                            atomIdx: number;
                            subtype?: string;
                          }>
                        ).map((m, i) => {
                          const left = (m.t / duration) * 100;
                          return (
                            <div
                              key={i}
                              className={`tl-tick ${tk.key}`}
                              style={{ left: `${left}%` }}
                              onClick={(e) => onTickClick(e, m.atomIdx, m.t)}
                              onMouseEnter={(e) =>
                                showTip(
                                  e,
                                  `${tk.label}${m.subtype ? ` · ${m.subtype}` : ""} · ${m.t.toFixed(3)}s`,
                                  m.label,
                                )
                              }
                              onMouseMove={moveTip}
                              onMouseLeave={hideTip}
                            />
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {/* Playhead — spans the full tracks region via top/bottom. */}
            <div className="tl-playhead" style={{ left: playheadLeft }} />
            <div
              className="tl-playhead-handle"
              style={{ left: playheadLeft, top: -6 }}
              onPointerDown={onPlayheadDown}
              title="Drag to scrub"
            />
          </div>
        );
      })()}

      {/* Tooltip */}
      {tooltip && (
        <div className="tl-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="meta">{tooltip.meta}</div>
          {tooltip.text}
        </div>
      )}

      {/* Drag-to-create label popup */}
      {pendingCreate && (
        <div
          className="quick-popup"
          style={{
            left: pendingCreate.anchorX,
            top: pendingCreate.anchorY,
            position: "fixed",
          }}
        >
          <div className="quick-popup-head">
            <span className="style-pill subtask">subtask</span>
            <span style={{ marginLeft: "auto", fontFamily: "monospace" }}>
              {pendingCreate.start.toFixed(2)}s → {pendingCreate.end.toFixed(2)}
              s
            </span>
          </div>
          <input
            type="text"
            placeholder="label (e.g. grasp the sponge)"
            autoFocus
            value={createLabel}
            onChange={(e) => setCreateLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPendingCreate();
              if (e.key === "Escape") cancelPendingCreate();
            }}
          />
          <div className="quick-popup-actions">
            <button
              onClick={cancelPendingCreate}
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "var(--fg-2, #cbd5e1)",
                cursor: "pointer",
              }}
            >
              cancel
            </button>
            <button
              onClick={commitPendingCreate}
              disabled={!createLabel.trim()}
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid #5b8cff",
                background: "rgba(91,140,255,0.15)",
                color: "#c7d6ff",
                cursor: "pointer",
                opacity: createLabel.trim() ? 1 : 0.4,
              }}
            >
              add ↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

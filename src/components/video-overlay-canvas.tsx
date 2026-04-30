"use client";

/**
 * Canvas overlay rendered on top of a single `<video>` element. Two roles:
 *
 * 1. Display VQA bbox/keypoint atoms whose `timestamp` matches the current
 *    video time (within ~one frame) and whose optional `camera` field matches
 *    this video's camera key (or has no camera, which we treat as
 *    "render on every camera").
 *
 * 2. When the user is in "draw mode" — bbox or keypoint — capture mouse input
 *    and stage a `pendingDraw` in the AnnotationsContext so the AnnotationsPanel
 *    can pick it up and persist it as a VQA atom.
 *
 * Coordinates are stored in 0..1 image-relative space. Drawing is computed
 * against the actually-rendered video rect (i.e. taking `object-contain`
 * letterboxing into account).
 */

import React, { useEffect, useRef, useState } from "react";
import { useAnnotations } from "../context/annotations-context";
import { useTime } from "../context/time-context";
import {
  classifyVqa,
  parseVqaAnswer,
  type LanguageAtom,
  type VqaAnswer,
} from "../types/language.types";

interface Props {
  videoEl: HTMLVideoElement | null;
  cameraKey: string;
}

interface RenderedRect {
  // Position of the video's actual rendered image area inside the canvas
  // (which is positioned to fill the video's bounding box). The video uses
  // `object-contain` so for a video aspect mismatched with its container,
  // there's letterboxing — we need to compute the inner rect to map 0..1
  // image-relative coordinates correctly.
  left: number;
  top: number;
  width: number;
  height: number;
  // Source image dimensions in pixels — needed so we can also map
  // pixel-space VQA answers (the annotation pipeline emits bboxes in
  // ``[x_min, y_min, x_max, y_max]`` source pixels per Module 3's prompt).
  sourceWidth: number;
  sourceHeight: number;
}

function computeRenderedRect(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): RenderedRect {
  // Use CSS dimensions, not bitmap dimensions — the canvas is HiDPI-scaled
  // (canvas.width = cssWidth * dpr) and the 2D context already has a
  // transform applied, so all drawing happens in CSS-pixel space.
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    // Metadata not yet loaded — fall back to the full canvas. The
    // `loadedmetadata` listener forces a redraw the moment vw/vh are known
    // so this fallback is short-lived.
    return {
      left: 0,
      top: 0,
      width: cssW,
      height: cssH,
      sourceWidth: 0,
      sourceHeight: 0,
    };
  }
  const videoAspect = vw / vh;
  const containerAspect = cssW / cssH;
  if (containerAspect > videoAspect) {
    // Container is wider than the video → vertical fill, horizontal letterbox.
    const renderedW = cssH * videoAspect;
    return {
      left: (cssW - renderedW) / 2,
      top: 0,
      width: renderedW,
      height: cssH,
      sourceWidth: vw,
      sourceHeight: vh,
    };
  } else {
    const renderedH = cssW / videoAspect;
    return {
      left: 0,
      top: (cssH - renderedH) / 2,
      width: cssW,
      height: renderedH,
      sourceWidth: vw,
      sourceHeight: vh,
    };
  }
}

function drawBbox(
  ctx: CanvasRenderingContext2D,
  rect: RenderedRect,
  bbox: [number, number, number, number],
  bboxFormat: string,
  label: string,
  color: string,
) {
  const [bx1, by1, bx2, by2] = bbox;
  const x1 = bx1;
  const y1 = by1;
  let x2 = bx2;
  let y2 = by2;
  if (bboxFormat === "xywh") {
    x2 = x1 + bx2;
    y2 = y1 + by2;
  }
  // If any coord > 1.5 we treat them as pixel coords in the source image
  // resolution; otherwise as 0..1 image-relative. The annotation pipeline
  // (Module 3) emits pixel coords by default per the prompt template, so
  // most real-world atoms will hit the pixel branch.
  const isPixelSpace =
    Math.max(Math.abs(x1), Math.abs(x2)) > 1.5 ||
    Math.max(Math.abs(y1), Math.abs(y2)) > 1.5;
  let px1: number, py1: number, px2: number, py2: number;
  if (isPixelSpace) {
    // Map source-pixel coords → canvas-px by dividing by the source image
    // dimensions and scaling onto the rendered (letterbox-adjusted) rect.
    // ``rect.sourceWidth/sourceHeight`` are populated from
    // ``videoEl.videoWidth/videoHeight`` in ``computeRenderedRect``.
    const sw = rect.sourceWidth || rect.width;
    const sh = rect.sourceHeight || rect.height;
    px1 = rect.left + (x1 / sw) * rect.width;
    py1 = rect.top + (y1 / sh) * rect.height;
    px2 = rect.left + (x2 / sw) * rect.width;
    py2 = rect.top + (y2 / sh) * rect.height;
  } else {
    px1 = rect.left + x1 * rect.width;
    py1 = rect.top + y1 * rect.height;
    px2 = rect.left + x2 * rect.width;
    py2 = rect.top + y2 * rect.height;
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color + "26"; // ~15% alpha
  ctx.fillRect(px1, py1, px2 - px1, py2 - py1);
  ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);
  if (label) {
    ctx.font = "12px ui-sans-serif, system-ui";
    const m = ctx.measureText(label);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(px1, py1 - 16, m.width + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, px1 + 4, py1 - 4);
  }
}

function drawPoint(
  ctx: CanvasRenderingContext2D,
  rect: RenderedRect,
  point: [number, number],
  label: string,
  color: string,
) {
  const [x, y] = point;
  const isPixelSpace = Math.abs(x) > 1.5 || Math.abs(y) > 1.5;
  let px: number, py: number;
  if (isPixelSpace) {
    // Same source-pixel → canvas-px mapping as drawBbox above.
    const sw = rect.sourceWidth || rect.width;
    const sh = rect.sourceHeight || rect.height;
    px = rect.left + (x / sw) * rect.width;
    py = rect.top + (y / sh) * rect.height;
  } else {
    px = rect.left + x * rect.width;
    py = rect.top + y * rect.height;
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py, 11, 0, Math.PI * 2);
  ctx.stroke();
  if (label) {
    ctx.font = "12px ui-sans-serif, system-ui";
    const m = ctx.measureText(label);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(px + 8, py - 18, m.width + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, px + 12, py - 6);
  }
}

function vqaMatchesCamera(answer: VqaAnswer, cameraKey: string): boolean {
  // If the answer doesn't carry a camera field, render it on every camera.
  // If it does, only render where it matches.
  const kind = classifyVqa(answer);
  if (kind === "bbox") {
    const dets = (answer as { detections: Array<{ camera?: string }> })
      .detections;
    if (!dets.length) return false;
    return dets.some((d) => !d.camera || d.camera === cameraKey);
  }
  if (kind === "keypoint") {
    const c = (answer as { camera?: string }).camera;
    return !c || c === cameraKey;
  }
  return false; // other VQA kinds aren't drawn
}

/** Pixel distance below which a pointer up counts as a click, not a drag. */
const CLICK_THRESHOLD_PX = 4;

interface FinalizingState {
  /** Where the popup anchors itself, in canvas-relative pixels (top-right of bbox / right of point). */
  anchor: { x: number; y: number };
  /** What the user just drew. */
  draw: PointDrawShape | BboxDrawShape;
}

type PointDrawShape = { kind: "keypoint"; point: [number, number] };
type BboxDrawShape = {
  kind: "bbox";
  bbox: [number, number, number, number];
};

export const VideoOverlayCanvas: React.FC<Props> = ({ videoEl, cameraKey }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const {
    atoms,
    setPendingDraw,
    pendingDraw,
    drawMode: ctxDrawMode,
    drawLabel,
    activeCamera,
    setActiveVideoEl,
    snap,
    addAtoms,
    clearPendingDraw,
  } = useAnnotations();
  // Register this camera's <video> as the "active" one so the panel can read
  // its authoritative `currentTime` instead of the throttled context value
  // when adding annotations.
  useEffect(() => {
    if (activeCamera === cameraKey) {
      setActiveVideoEl(videoEl);
      return () => setActiveVideoEl(null);
    }
  }, [activeCamera, cameraKey, videoEl, setActiveVideoEl]);
  // Drawing only enabled on the active camera. Other cameras stay in display mode.
  const drawMode =
    ctxDrawMode !== "off" &&
    (activeCamera === null || activeCamera === cameraKey)
      ? ctxDrawMode
      : "off";
  const { currentTime } = useTime();
  // Pointer-down origin in canvas pixels and 0..1 image-relative coords.
  const dragOriginRef = useRef<{
    px: [number, number];
    norm: [number, number];
  } | null>(null);
  const [dragMoved, setDragMoved] = useState(false);
  const [finalizing, setFinalizing] = useState<FinalizingState | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [questionKind, setQuestionKind] = useState<"detect" | "point">(
    "detect",
  );

  // Keep the canvas exactly aligned with the video. Two listeners:
  //   - ResizeObserver picks up CSS resize.
  //   - `loadedmetadata` picks up the moment `video.videoWidth` becomes
  //     non-zero so `computeRenderedRect` stops returning the full-canvas
  //     fallback (which is what causes drawn bboxes to land in the wrong
  //     spot when the user starts annotating before metadata arrives).
  useEffect(() => {
    if (!videoEl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const sync = () => {
      const r = videoEl.getBoundingClientRect();
      // Use the device-pixel ratio for crisp drawing on HiDPI displays.
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    const ro = new ResizeObserver(sync);
    ro.observe(videoEl);
    videoEl.addEventListener("loadedmetadata", sync);
    videoEl.addEventListener("loadeddata", sync);
    sync();
    return () => {
      ro.disconnect();
      videoEl.removeEventListener("loadedmetadata", sync);
      videoEl.removeEventListener("loadeddata", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl]);

  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoEl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // clearRect is in CSS-px after the dpr transform is applied; using the
    // bitmap dims here would clear a region too large but still works.
    ctx.clearRect(
      0,
      0,
      canvas.clientWidth || canvas.width,
      canvas.clientHeight || canvas.height,
    );
    const rect = computeRenderedRect(canvas, videoEl);

    // Saved VQA atoms within ~one frame of currentTime. We compare against
    // the episode-local `currentTime` from useTime(), not the <video>'s
    // `currentTime`, because the latter is in *global* video-file time for
    // segmented (concatenated) videos.
    const matches: LanguageAtom[] = atoms.filter((a) => {
      if (a.style !== "vqa" || a.role !== "assistant") return false;
      const dt = Math.abs(a.timestamp - (currentTime || 0));
      if (dt >= 0.05) return false; // ~30fps tolerance, writer enforces exact
      // Row-level camera is authoritative (lerobot PR 3467). Camera-agnostic
      // atoms (a.camera == null) draw on every camera.
      return a.camera == null || a.camera === cameraKey;
    });
    for (const atom of matches) {
      const ans = parseVqaAnswer(atom.content);
      if (!ans) continue;
      // For atoms that already carry a row-level camera tag, the filter above
      // is sufficient. The legacy in-payload camera field still matters for
      // pre-PR-3467 annotations the user may have on disk — keep the fallback
      // check so old datasets don't suddenly render on every camera.
      if (atom.camera == null && !vqaMatchesCamera(ans, cameraKey)) continue;
      const kind = classifyVqa(ans);
      if (kind === "bbox") {
        const dets = (ans as { detections: Array<unknown> })
          .detections as Array<{
          label?: string;
          bbox: [number, number, number, number];
          bbox_format?: string;
          camera?: string;
        }>;
        for (const d of dets) {
          if (d.camera && d.camera !== cameraKey) continue;
          drawBbox(
            ctx,
            rect,
            d.bbox,
            d.bbox_format || "xyxy",
            d.label || "",
            "#22d3ee",
          );
        }
      } else if (kind === "keypoint") {
        const k = ans as { point: [number, number]; label?: string };
        drawPoint(ctx, rect, k.point, k.label || "", "#facc15");
      }
    }

    // Pending (in-progress) draw for this camera.
    if (
      pendingDraw &&
      (!pendingDraw.camera || pendingDraw.camera === cameraKey)
    ) {
      if (pendingDraw.kind === "bbox") {
        drawBbox(
          ctx,
          rect,
          pendingDraw.bbox,
          "xyxy",
          pendingDraw.label || "",
          "#f97316",
        );
      } else {
        drawPoint(
          ctx,
          rect,
          pendingDraw.point,
          pendingDraw.label || "",
          "#f97316",
        );
      }
    }
  }, [atoms, pendingDraw, cameraKey, videoEl]);

  // Redraw on time tick / atoms / pendingDraw / videoEl changes.
  useEffect(() => {
    redraw();
  }, [redraw, currentTime]);

  // Also redraw the moment the video reports a seek completing — the
  // throttled `currentTime` from TimeContext can lag a paused frame by enough
  // that the overlay first paints empty. Listening directly to `seeked`
  // closes that gap so bbox/keypoint atoms appear instantly after jumping.
  useEffect(() => {
    if (!videoEl) return;
    const onSeeked = () => redraw();
    videoEl.addEventListener("seeked", onSeeked);
    return () => videoEl.removeEventListener("seeked", onSeeked);
  }, [videoEl, redraw]);

  // Pointer handlers. The disambiguation:
  //   - drawMode "auto":     drag (>4px) → bbox; release without dragging → keypoint
  //   - drawMode "bbox":     drag → bbox (no implicit keypoint)
  //   - drawMode "keypoint": down-then-up at same spot → keypoint
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawMode === "off") return;
    const canvas = canvasRef.current;
    if (!canvas || !videoEl) return;
    if (finalizing) return; // wait for the user to confirm/cancel current draw
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const rect = computeRenderedRect(canvas, videoEl);
    const cr = canvas.getBoundingClientRect();
    const px: [number, number] = [e.clientX - cr.left, e.clientY - cr.top];
    const norm: [number, number] = [
      Math.max(0, Math.min(1, (px[0] - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (px[1] - rect.top) / rect.height)),
    ];
    dragOriginRef.current = { px, norm };
    setDragMoved(false);
    // Start a tentative bbox-shaped pendingDraw; if the user releases without
    // moving (auto/keypoint mode) we'll flip it to a keypoint on pointerup.
    setPendingDraw({
      kind: "bbox",
      bbox: [norm[0], norm[1], norm[0], norm[1]],
      label: drawLabel || "",
      camera: cameraKey,
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawMode === "off" || !dragOriginRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || !videoEl) return;
    const rect = computeRenderedRect(canvas, videoEl);
    const cr = canvas.getBoundingClientRect();
    const cx = e.clientX - cr.left;
    const cy = e.clientY - cr.top;
    const dx = cx - dragOriginRef.current.px[0];
    const dy = cy - dragOriginRef.current.px[1];
    if (
      !dragMoved &&
      Math.hypot(dx, dy) > CLICK_THRESHOLD_PX &&
      drawMode !== "keypoint"
    ) {
      setDragMoved(true);
    }
    if (drawMode === "keypoint") return;
    const x = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
    const start = dragOriginRef.current.norm;
    setPendingDraw({
      kind: "bbox",
      bbox: [
        Math.min(start[0], x),
        Math.min(start[1], y),
        Math.max(start[0], x),
        Math.max(start[1], y),
      ],
      label: drawLabel || "",
      camera: cameraKey,
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawMode === "off" || !dragOriginRef.current) {
      dragOriginRef.current = null;
      setDragMoved(false);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !videoEl) {
      dragOriginRef.current = null;
      setDragMoved(false);
      return;
    }
    const rect = computeRenderedRect(canvas, videoEl);
    const cr = canvas.getBoundingClientRect();
    const cx = e.clientX - cr.left;
    const cy = e.clientY - cr.top;

    // Decide the gesture's kind.
    const treatAsBbox =
      drawMode === "bbox" || (drawMode === "auto" && dragMoved);

    if (treatAsBbox) {
      const x = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
      const start = dragOriginRef.current.norm;
      const bbox: [number, number, number, number] = [
        Math.min(start[0], x),
        Math.min(start[1], y),
        Math.max(start[0], x),
        Math.max(start[1], y),
      ];
      // Anchor popup at the bbox top-right in canvas-px space.
      setPendingDraw({
        kind: "bbox",
        bbox,
        label: drawLabel || "",
        camera: cameraKey,
      });
      setFinalizing({
        anchor: {
          x: rect.left + bbox[2] * rect.width,
          y: rect.top + bbox[1] * rect.height,
        },
        draw: { kind: "bbox", bbox },
      });
      setQuestionKind("detect");
    } else {
      // Click → keypoint at the up position.
      const x = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
      const point: [number, number] = [x, y];
      setPendingDraw({
        kind: "keypoint",
        point,
        label: drawLabel || "",
        camera: cameraKey,
      });
      setFinalizing({
        anchor: {
          x: rect.left + point[0] * rect.width + 14,
          y: rect.top + point[1] * rect.height,
        },
        draw: { kind: "keypoint", point },
      });
      setQuestionKind("point");
    }
    dragOriginRef.current = null;
    setDragMoved(false);
  };

  const onPointerCancel = () => {
    dragOriginRef.current = null;
    setDragMoved(false);
  };

  const closeFinalize = React.useCallback(() => {
    setFinalizing(null);
    setLabelInput("");
    clearPendingDraw();
  }, [clearPendingDraw]);

  const submitFinalize = () => {
    if (!finalizing) return;
    const label = labelInput.trim();
    if (!label) return;
    // Episode-local time only — `videoEl.currentTime` is the *global* time
    // inside a shared/concatenated video file, which would push every
    // annotation past the parquet's [0..duration] frame range and collapse
    // them to the boundary on snap. `currentTime` from useTime() is already
    // normalized to episode-local space by SimpleVideosPlayer.
    const ts = snap(currentTime);
    const question =
      questionKind === "point"
        ? `Point to the ${label}.`
        : `Where is the ${label} in the image?`;
    let answer:
      | {
          detections: Array<{
            label: string;
            bbox_format: "xyxy";
            bbox: [number, number, number, number];
            camera?: string;
          }>;
        }
      | {
          label: string;
          point_format: "xy";
          point: [number, number];
          camera?: string;
        };
    if (finalizing.draw.kind === "bbox") {
      answer = {
        detections: [
          {
            label,
            bbox_format: "xyxy",
            bbox: finalizing.draw.bbox.map((v) => Number(v.toFixed(4))) as [
              number,
              number,
              number,
              number,
            ],
            camera: cameraKey,
          },
        ],
      };
    } else {
      answer = {
        label,
        point_format: "xy",
        point: finalizing.draw.point.map((v) => Number(v.toFixed(4))) as [
          number,
          number,
        ],
        camera: cameraKey,
      };
    }
    addAtoms([
      {
        role: "user",
        content: question,
        style: "vqa",
        timestamp: ts,
        camera: cameraKey,
        tool_calls: null,
      },
      {
        role: "assistant",
        content: JSON.stringify(answer),
        style: "vqa",
        timestamp: ts,
        camera: cameraKey,
        tool_calls: null,
      },
    ]);
    closeFinalize();
  };

  // ESC / click-outside to cancel the popup.
  useEffect(() => {
    if (!finalizing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFinalize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finalizing, closeFinalize]);

  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: drawMode === "off" ? "none" : "auto",
          cursor:
            drawMode === "off"
              ? "default"
              : drawMode === "keypoint"
                ? "pointer"
                : "crosshair",
        }}
      />
      {finalizing && (
        <QuickLabelPopup
          anchor={finalizing.anchor}
          kind={finalizing.draw.kind}
          questionKind={questionKind}
          onQuestionKindChange={setQuestionKind}
          label={labelInput}
          onLabelChange={setLabelInput}
          onSubmit={submitFinalize}
          onCancel={closeFinalize}
        />
      )}
    </>
  );
};

/**
 * Floating "what is this?" popup that appears next to a freshly drawn bbox or
 * keypoint. The label gets templated into a question — bbox → "Where is the X
 * in the image?", keypoint → "Point to the X." — and the assistant message
 * carries the JSON answer the steerable validator expects.
 */
const QuickLabelPopup: React.FC<{
  anchor: { x: number; y: number };
  kind: "bbox" | "keypoint";
  questionKind: "detect" | "point";
  onQuestionKindChange: (k: "detect" | "point") => void;
  label: string;
  onLabelChange: (s: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}> = ({
  anchor,
  kind,
  questionKind,
  onQuestionKindChange,
  label,
  onLabelChange,
  onSubmit,
  onCancel,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Position the popup just to the right of the bbox/point anchor, but flip
  // to the left when it would overflow the parent's right edge so it stays
  // visible for bboxes drawn near the right side of the video. Uses
  // useLayoutEffect so the measurement + reposition happens before the
  // browser paints — no flicker.
  React.useLayoutEffect(() => {
    const popup = popupRef.current;
    const parent = popup?.parentElement;
    if (!popup || !parent) return;
    const popW = popup.offsetWidth;
    const popH = popup.offsetHeight;
    const parW = parent.clientWidth;
    const parH = parent.clientHeight;
    const desiredLeft = anchor.x + 6;
    const overflowsRight = desiredLeft + popW > parW - 4;
    const finalLeft = overflowsRight
      ? Math.max(4, anchor.x - popW - 6)
      : Math.max(4, desiredLeft);
    const finalTop = Math.max(4, Math.min(parH - popH - 4, anchor.y - 4));
    popup.style.left = `${finalLeft}px`;
    popup.style.top = `${finalTop}px`;
  }, [anchor.x, anchor.y]);
  return (
    <div
      ref={popupRef}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        zIndex: 30,
        pointerEvents: "auto",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="bg-[var(--surface-1)] border border-white/15 rounded-md shadow-xl p-2 flex flex-col gap-1.5 min-w-[200px]"
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        <span
          className={`px-1.5 py-0.5 rounded border ${
            kind === "bbox"
              ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
              : "bg-yellow-500/20 text-yellow-300 border-yellow-500/30"
          }`}
        >
          {kind}
        </span>
        <select
          value={questionKind}
          onChange={(e) =>
            onQuestionKindChange(e.target.value as "detect" | "point")
          }
          className="ml-auto bg-transparent border border-white/10 rounded px-1 py-0.5 text-[10px] text-slate-300"
        >
          <option value="detect">where is …?</option>
          <option value="point">point to …</option>
        </select>
      </div>
      <input
        ref={inputRef}
        type="text"
        placeholder={
          kind === "bbox" ? "label (e.g. carrot)" : "label (e.g. handle)"
        }
        value={label}
        onChange={(e) => onLabelChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="px-2 py-1 rounded bg-[var(--surface-2,rgba(255,255,255,0.04))] border border-white/10 text-sm text-slate-200 outline-none focus:border-cyan-400/60"
      />
      <div className="flex justify-end gap-1">
        <button
          onClick={onCancel}
          className="text-[10px] h-6 px-2 rounded border border-white/10 text-slate-300 hover:bg-white/5"
        >
          cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!label.trim()}
          className="text-[10px] h-6 px-2 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
        >
          add ↵
        </button>
      </div>
    </div>
  );
};

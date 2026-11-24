"use client";

/**
 * The progress-video overlay of lerobot's `create_progress_videos.py`, drawn live over a camera in
 * SVG and HTML instead of baked into pixels: a dark scrim, the episode's curves across the frame
 * (faint ahead of the playhead, solid behind it) with a ringed marker and a dashed playhead, and a
 * strip per subtask track. The videos' panels (task, legend, current subtask) and footer are left
 * out so the plot can take the frame: pointing at the plot reads every signal at that frame, and
 * pointing at a strip names its subtask. The pointer is read without being taken, so drawing
 * annotations on the video (the Annotations tab's "auto" draw mode) works through the overlay.
 *
 * Its layout is the script's, in its 768-pixel units scaled to the video on screen, and it sits on
 * the video's picture (letterboxing left out), so it lines up at any size. Each camera draws only
 * the models that scored it.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTime } from "@/context/time-context";
import {
  useScores,
  type AnnotatedSubtask,
  type CurveTrack,
  type ScoreTrack,
} from "@/context/scores-context";
import {
  axisKey,
  axisRange,
  categoricalRuns,
  formatScore,
  seriesPath,
} from "@/utils/scores";
import { BRAND, axisTick } from "@/utils/scoreStyle";
import { frameAt } from "@/utils/playback";

// The script's layout, in pixels of a 768-pixel frame. Without the videos' panels and footer, the
// plot runs from margin to margin.
const MARGIN = 24;
const PADDING = 10;
const RADIUS = 8;
const CURVE_WIDTH = 3;
const STRIP = 6;
const TRACK_ROW = 23;
/** Axes the plot can label: the first unit on the left, a second on the right. */
const MAX_AXES = 2;

type Rect = { left: number; top: number; width: number; height: number };
type Scale = (length: number) => number;

/**
 * The script lays out a 768-pixel frame for 1080p video. A video on a page is a few hundred pixels,
 * where that layout's text would be unreadable: the layout is scaled to the frame, but never below
 * what keeps its smallest text (the 11-pixel labels) at about 8 pixels.
 */
function layoutScale(width: number, height: number): number {
  return Math.min(1.6, Math.max(0.72, Math.min(width, height) / 440));
}

/** Where the picture sits inside the `<video>` box (`object-contain` letterboxes it). */
function usePictureRect(video: HTMLVideoElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!video) return;
    const sync = () => {
      const boxW = video.clientWidth;
      const boxH = video.clientHeight;
      if (!boxW || !boxH) return setRect(null);
      const aspect =
        video.videoWidth && video.videoHeight
          ? video.videoWidth / video.videoHeight
          : boxW / boxH;
      const width = Math.min(boxW, boxH * aspect);
      const height = width / aspect;
      setRect({
        left: video.offsetLeft + (boxW - width) / 2,
        top: video.offsetTop + (boxH - height) / 2,
        width,
        height,
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(video);
    video.addEventListener("loadedmetadata", sync);
    sync();
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", sync);
    };
  }, [video]);
  return rect;
}

/** An element's size, followed as it changes (a hover card's content changes with the frame). */
function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return setSize({ width: 0, height: 0 });
    const measure = () =>
      setSize((prev) =>
        prev.width === el.offsetWidth && prev.height === el.offsetHeight
          ? prev
          : { width: el.offsetWidth, height: el.offsetHeight },
      );
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
  return [ref, size] as const;
}

/** A span of a subtask track, in frames [start, end), with its number among the track's subtasks. */
type Run = {
  start: number;
  end: number;
  name: string;
  index: number;
  count: number;
};
type Track = { key: string; label: string; runs: Run[] };

function runAt(track: Track, frame: number): Run | null {
  return track.runs.find((r) => frame >= r.start && frame < r.end) ?? null;
}

/**
 * The subtask tracks under the plot, as the script orders them: the dataset's annotated subtasks,
 * then each predicted one. A model with several categorical signals names each.
 */
function subtaskTracks(
  annotated: AnnotatedSubtask[],
  stages: ScoreTrack[],
  fps: number,
  numFrames: number,
): Track[] {
  const tracks: Track[] = [];
  if (annotated.length > 0 && fps > 0) {
    tracks.push({
      key: "annotated",
      label: "SUBTASK",
      runs: annotated
        .map((sub, index) => ({
          start: Math.round(sub.start * fps),
          end: Math.min(numFrames, Math.round(sub.end * fps)),
          name: sub.name,
          index,
          count: annotated.length,
        }))
        .filter((run) => run.end > run.start),
    });
  }
  for (const stage of stages) {
    const labels = stage.signal.descriptor.labels ?? [];
    const sameModel = stages.filter((s) => s.model === stage.model).length;
    const label =
      stages.length === 1
        ? "PREDICTED"
        : `PREDICTED ${stage.model}${sameModel > 1 ? ` ${stage.label}` : ""}`;
    tracks.push({
      key: stage.key,
      label: label.toUpperCase(),
      runs: categoricalRuns(stage.values, labels.length).map((run) => ({
        start: run.start,
        end: run.end,
        name: labels[run.label],
        index: run.label,
        count: labels.length,
      })),
    });
  }
  return tracks;
}

/** Curves that share an axis: the same bounds, or the same unit. */
type AxisGroup = {
  key: string;
  curves: CurveTrack[];
  range: [number, number];
  unit: string | null;
};

function axisGroups(curves: CurveTrack[]): AxisGroup[] {
  const groups = new Map<string, CurveTrack[]>();
  for (const curve of curves) {
    const key = axisKey(curve.signal.descriptor);
    groups.set(key, [...(groups.get(key) ?? []), curve]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    curves: members,
    range: axisRange(
      members.map((c) => ({
        descriptor: c.signal.descriptor,
        values: c.values,
      })),
    ),
    unit: members[0].signal.descriptor.unit,
  }));
}

/** Draws the scores of the models that read `cameraKey`, over its video. */
export function ScoreOverlay({
  video,
  cameraKey,
}: {
  video: HTMLVideoElement | null;
  cameraKey: string;
}) {
  const scores = useScores();
  const curves = useMemo(
    () => scores?.curves.filter((c) => c.camera === cameraKey) ?? [],
    [scores?.curves, cameraKey],
  );
  const stages = useMemo(
    () => scores?.stages.filter((s) => s.camera === cameraKey) ?? [],
    [scores?.stages, cameraKey],
  );
  if (!scores?.showOverlay || (curves.length === 0 && stages.length === 0)) {
    return null;
  }
  return <PlacedOverlay video={video} curves={curves} stages={stages} />;
}

/** Measures the picture only for a camera that draws: the others need no observer. */
function PlacedOverlay({
  video,
  curves,
  stages,
}: {
  video: HTMLVideoElement | null;
  curves: CurveTrack[];
  stages: ScoreTrack[];
}) {
  const rect = usePictureRect(video);
  return rect ? <Overlay rect={rect} curves={curves} stages={stages} /> : null;
}

type Hover = {
  x: number;
  y: number;
  frame: number;
  /** -1 for the plot, else the subtask track's row. */
  row: number;
};

function Overlay({
  rect,
  curves,
  stages,
}: {
  rect: Rect;
  curves: CurveTrack[];
  stages: ScoreTrack[];
}) {
  const {
    fps,
    annotatedSubtasks,
    subtaskColor,
    numFrames: episodeFrames,
  } = useScores()!;
  const { currentTime } = useTime();
  const [hover, setHover] = useState<Hover | null>(null);

  const W = rect.width;
  const H = rect.height;
  const s = layoutScale(W, H);
  const px: Scale = (length) => length * s;

  const numFrames = Math.max(
    episodeFrames,
    curves[0]?.values.length ?? 0,
    stages[0]?.values.length ?? 0,
  );
  const frame = Math.max(0, Math.min(numFrames - 1, frameAt(currentTime, fps)));

  const tracks = useMemo(
    () => subtaskTracks(annotatedSubtasks, stages, fps, numFrames),
    [annotatedSubtasks, stages, fps, numFrames],
  );

  // Signals in different units cannot share an axis: the first unit reads on the left, a second on
  // the right (e.g. progress and RynnValue's seconds). A third has nowhere to be read, so it is not
  // drawn; the hover card still lists it.
  const groups = useMemo(() => axisGroups(curves).slice(0, MAX_AXES), [curves]);
  const ranges = useMemo(
    () =>
      new Map(
        groups.flatMap((g) => g.curves.map((c) => [c.key, g.range] as const)),
      ),
    [groups],
  );
  const drawn = curves.filter((c) => ranges.has(c.key));
  const hasPlot = drawn.length > 0;

  // The plot: margin to margin, above the subtask strips. Strips alone take only the bottom.
  const left = px(MARGIN);
  const right = W - px(MARGIN);
  const stripsTop = H - px(MARGIN + TRACK_ROW * tracks.length);
  const top = hasPlot ? px(MARGIN) : stripsTop;
  const bottom = hasPlot ? Math.max(top + px(40), stripsTop) : stripsTop;
  const trackTop = (row: number) => bottom + px(6 + TRACK_ROW * row);

  const xAt = (f: number) =>
    left + (f / Math.max(numFrames - 1, 1)) * (right - left);
  const yOf = (curve: CurveTrack, value: number) => {
    const [low, high] = ranges.get(curve.key) ?? [0, 1];
    return bottom - ((value - low) / (high - low)) * (bottom - top);
  };
  const runX = (run: Run): [number, number] => [
    Math.max(xAt(run.start - 0.5), left),
    Math.min(xAt(run.end - 0.5), right),
  ];
  const dashOf = (curve: CurveTrack) => curve.dash?.map(px).join(" ");
  const x = xAt(frame);

  const paths = useMemo(
    () => drawn.map((c) => seriesPath(c.values, xAt, (v) => yOf(c, v))),
    // xAt and yOf are pure functions of these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curves, ranges, left, right, top, bottom, numFrames],
  );
  const clipId = React.useId().replace(/:/g, "");

  const scored = drawn
    .map((curve) => ({ curve, value: curve.values[frame] }))
    .filter(({ value }) => Number.isFinite(value));
  const highest = Math.min(
    bottom,
    ...scored.map(({ curve, value }) => yOf(curve, value)),
  );
  const single = drawn.length === 1 ? drawn[0] : null;

  const label = { fontSize: px(11), fontWeight: 600 };
  const hoveredTrack = hover && hover.row >= 0 ? tracks[hover.row] : null;
  const hoveredRun =
    hover && hoveredTrack ? runAt(hoveredTrack, hover.frame) : null;
  const hoveredRunX = hoveredRun ? runX(hoveredRun) : null;

  // The pointer is read from the video's container, where its events bubble whatever is on top
  // (the annotation canvas while drawing), so the overlay never takes them. The latest layout is
  // read through a ref: the listeners are attached once.
  const readPointer = useRef<(root: HTMLElement, e: PointerEvent) => void>(
    () => {},
  );
  readPointer.current = (root, e) => {
    const box = root.getBoundingClientRect();
    const hx = e.clientX - box.left;
    const hy = e.clientY - box.top;
    const regionBottom = bottom + px(4 + TRACK_ROW * tracks.length);
    // A pressed button is a drag (drawing a box): the card would sit over it.
    if (
      e.buttons !== 0 ||
      hx < left ||
      hx > right ||
      hy < top ||
      hy > regionBottom
    ) {
      setHover(null);
      return;
    }
    const onPlot = hasPlot && hy <= bottom + px(4);
    setHover({
      x: hx,
      y: hy,
      frame: Math.round(
        Math.max(0, Math.min(1, (hx - left) / (right - left))) *
          Math.max(numFrames - 1, 0),
      ),
      row: onPlot
        ? -1
        : Math.min(
            tracks.length - 1,
            Math.max(0, Math.floor((hy - bottom - px(4)) / px(TRACK_ROW))),
          ),
    });
  };
  const detachPointer = useRef<(() => void) | null>(null);
  const rootRef = useCallback((root: HTMLDivElement | null) => {
    detachPointer.current?.();
    detachPointer.current = null;
    const container = root?.parentElement;
    if (!root || !container) return;
    const move = (e: PointerEvent) => readPointer.current(root, e);
    const leave = () => setHover(null);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerleave", leave);
    detachPointer.current = () => {
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
    };
  }, []);

  if (numFrames < 1) return null;

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute overflow-hidden font-sans"
      style={{
        left: rect.left,
        top: rect.top,
        width: W,
        height: H,
        color: BRAND.cream,
      }}
      aria-label="Scores over the video"
    >
      <svg width={W} height={H} className="absolute inset-0" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect
              x="0"
              y="0"
              width={Math.max(0, x + px(CURVE_WIDTH) / 2)}
              height={H}
            />
          </clipPath>
        </defs>
        {/* The scrim: the whole frame under a plot, the bottom band under strips alone. */}
        <rect
          y={hasPlot ? 0 : top - px(4)}
          width={W}
          height={hasPlot ? H : H - top + px(4)}
          fill={BRAND.background}
          opacity={0.4}
        />

        {hasPlot && (
          <>
            {/* Grid: 4 rows, 6 columns. */}
            <g
              stroke={BRAND.cream}
              strokeOpacity={30 / 255}
              shapeRendering="crispEdges"
            >
              {[0, 1, 2, 3, 4].map((i) => {
                const y = top + ((bottom - top) * i) / 4;
                return (
                  <line key={`h${i}`} x1={left} x2={right} y1={y} y2={y} />
                );
              })}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                const gx = left + ((right - left) * i) / 6;
                return (
                  <line key={`v${i}`} x1={gx} x2={gx} y1={top} y2={bottom} />
                );
              })}
            </g>

            {/* Where each annotated subtask starts. */}
            {tracks
              .find((t) => t.key === "annotated")
              ?.runs.filter((r) => r.start > 0)
              .map((r) => (
                <line
                  key={r.start}
                  x1={xAt(r.start)}
                  x2={xAt(r.start)}
                  y1={bottom}
                  y2={top}
                  stroke={BRAND.cream}
                  strokeOpacity={110 / 255}
                  strokeDasharray={`${px(4)} ${px(3)}`}
                />
              ))}

            {/* The whole episode, faint; behind the playhead, solid. */}
            {drawn.map((curve, i) => (
              <path
                key={`faint-${curve.key}`}
                d={paths[i]}
                fill="none"
                stroke={curve.color}
                strokeOpacity={80 / 255}
                strokeWidth={px(1.5)}
                strokeDasharray={dashOf(curve)}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            <g clipPath={`url(#${clipId})`}>
              {drawn.map((curve, i) => (
                <path
                  key={`solid-${curve.key}`}
                  d={paths[i]}
                  fill="none"
                  stroke={curve.color}
                  strokeWidth={px(CURVE_WIDTH)}
                  strokeDasharray={dashOf(curve)}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            </g>

            {/* Playhead, from the bottom up to the highest marker. */}
            {scored.length > 0 && (
              <line
                x1={x}
                x2={x}
                y1={bottom}
                y2={highest}
                stroke={BRAND.cream}
                strokeOpacity={190 / 255}
                strokeDasharray={`${px(4)} ${px(3)}`}
              />
            )}
            {scored.map(({ curve, value }) => (
              <circle
                key={curve.key}
                cx={x}
                cy={yOf(curve, value)}
                r={px(6)}
                fill={curve.color}
                stroke={BRAND.cream}
                strokeWidth={px(2)}
              />
            ))}

            {/* The frame under the pointer: a guide and a dot on each curve. */}
            {hover && hover.row < 0 && (
              <g>
                <line
                  x1={xAt(hover.frame)}
                  x2={xAt(hover.frame)}
                  y1={top}
                  y2={bottom}
                  stroke={BRAND.cream}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                />
                {drawn.map((curve) => {
                  const v = curve.values[hover.frame];
                  if (!Number.isFinite(v)) return null;
                  return (
                    <circle
                      key={curve.key}
                      cx={xAt(hover.frame)}
                      cy={yOf(curve, v)}
                      r={px(4)}
                      fill={curve.color}
                      stroke={BRAND.cream}
                      strokeWidth={px(1.5)}
                    />
                  );
                })}
              </g>
            )}

            {/* Axis ticks: under the top line, over the others. */}
            <g fill={BRAND.cream} className="font-mono" style={label}>
              {groups.map((group, side) => {
                const [low, high] = group.range;
                return [
                  [high, top],
                  [(low + high) / 2, (top + bottom) / 2],
                  [low, bottom],
                ].map(([value, y], i) => (
                  <text
                    key={`${group.key}-${i}`}
                    x={side === 0 ? left + px(6) : right - px(6)}
                    y={i === 0 ? y + px(13) : y - px(5)}
                    textAnchor={side === 0 ? "start" : "end"}
                  >
                    {axisTick(value, group.unit)}
                  </text>
                ));
              })}
            </g>
          </>
        )}

        {/* Subtask strips: faint ahead, solid behind; the one under the pointer outlined. */}
        {tracks.map((track, row) => {
          const y0 = trackTop(row) + px(12);
          return (
            <g key={track.key}>
              <text
                x={left}
                y={trackTop(row) + px(9)}
                fill={BRAND.muted}
                className="font-mono"
                style={label}
              >
                {track.label}
              </text>
              {track.runs.map((run) => {
                const [x0, x1] = runX(run);
                const past = Math.min(x1, Math.max(x0, x));
                const fill = subtaskColor(run.name);
                return (
                  <g key={run.start}>
                    <rect
                      x={x0}
                      y={y0}
                      width={Math.max(0, x1 - x0)}
                      height={px(STRIP)}
                      fill={fill}
                      opacity={70 / 255}
                    />
                    <rect
                      x={x0}
                      y={y0}
                      width={Math.max(0, past - x0)}
                      height={px(STRIP)}
                      fill={fill}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
        {hover && hoveredRunX && (
          <rect
            x={hoveredRunX[0] - px(1)}
            y={trackTop(hover.row) + px(11)}
            width={hoveredRunX[1] - hoveredRunX[0] + px(2)}
            height={px(STRIP + 2)}
            fill="none"
            stroke={BRAND.cream}
            strokeWidth={px(1.5)}
          />
        )}
      </svg>

      {/* A single signal's value rides above its marker, except while a hover card is up. */}
      {single && !hover && Number.isFinite(single.values[frame]) && (
        <ValueTag
          curve={single}
          value={single.values[frame]}
          x={x}
          y={yOf(single, single.values[frame])}
          left={left}
          right={right}
          top={top}
          px={px}
        />
      )}

      {hover && (
        <HoverCard hover={hover} width={W} height={H} px={px}>
          {hover.row < 0 ? (
            <PlotReadout
              frame={hover.frame}
              fps={fps}
              curves={curves}
              onAxis={ranges}
              tracks={tracks}
              subtaskColor={subtaskColor}
              px={px}
            />
          ) : (
            hoveredTrack && (
              <StripReadout
                track={hoveredTrack}
                run={hoveredRun}
                fps={fps}
                subtaskColor={subtaskColor}
                px={px}
              />
            )
          )}
        </HoverCard>
      )}
    </div>
  );
}

/** The mono labels' size and colour; their elements carry `font-mono`. */
function labelStyle(px: Scale): React.CSSProperties {
  return {
    fontSize: px(11),
    fontWeight: 600,
    color: BRAND.muted,
  };
}

function Swatch({
  color,
  round,
  px,
}: {
  color: string;
  round?: boolean;
  px: Scale;
}) {
  return (
    <span
      className={`shrink-0 ${round ? "rounded-full" : ""}`}
      style={{ width: px(9), height: px(9), background: color }}
    />
  );
}

/** "2/4  Place the rack in the drawer", with its colour. */
function SubtaskLine({
  run,
  subtaskColor,
  px,
  bold,
}: {
  run: Run;
  subtaskColor: (name: string) => string;
  px: Scale;
  bold?: boolean;
}) {
  return (
    <>
      <Swatch color={subtaskColor(run.name)} px={px} />
      <span className={bold ? "font-bold" : undefined}>
        {run.index + 1}/{run.count}&nbsp;&nbsp;{run.name}
      </span>
    </>
  );
}

/** Every signal and subtask at the frame under the pointer. */
function PlotReadout({
  frame,
  fps,
  curves,
  onAxis,
  tracks,
  subtaskColor,
  px,
}: {
  frame: number;
  fps: number;
  curves: CurveTrack[];
  /** The curves on an axis, by key; the others are listed as not drawn. */
  onAxis: ReadonlyMap<string, unknown>;
  tracks: Track[];
  subtaskColor: (name: string) => string;
  px: Scale;
}) {
  const row = { gap: px(6), marginTop: px(3) };
  return (
    <>
      <div className="font-mono" style={labelStyle(px)}>
        frame {frame}
        {fps > 0 && ` · ${(frame / fps).toFixed(2)} s`}
      </div>
      {curves.map((curve) => (
        <div
          key={curve.key}
          className="flex items-center whitespace-nowrap"
          style={row}
        >
          <Swatch color={curve.color} round px={px} />
          <span className="font-bold">{curve.model}</span>
          <span style={{ color: BRAND.muted }}>
            {curve.label}
            {curve.signal.descriptor.greaterIsBetter === false &&
              " (lower is better)"}
            {!onAxis.has(curve.key) && " (not drawn: no axis for its unit)"}
          </span>
          <span className="ml-auto font-mono" style={{ paddingLeft: px(10) }}>
            {formatScore(curve.values[frame] ?? NaN, curve.signal.descriptor)}
          </span>
        </div>
      ))}
      {tracks.map((track) => {
        const run = runAt(track, frame);
        return (
          <div
            key={track.key}
            className="flex items-center whitespace-nowrap"
            style={row}
          >
            <span className="font-mono" style={labelStyle(px)}>
              {track.label}
            </span>
            {run ? (
              <SubtaskLine run={run} subtaskColor={subtaskColor} px={px} />
            ) : (
              <span>–</span>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The subtask under the pointer on a strip, and when it runs. */
function StripReadout({
  track,
  run,
  fps,
  subtaskColor,
  px,
}: {
  track: Track;
  run: Run | null;
  fps: number;
  subtaskColor: (name: string) => string;
  px: Scale;
}) {
  return (
    <>
      <div className="font-mono" style={labelStyle(px)}>
        {track.label}
      </div>
      {run ? (
        <>
          <div
            className="flex items-center whitespace-nowrap"
            style={{ gap: px(6), marginTop: px(3) }}
          >
            <SubtaskLine run={run} subtaskColor={subtaskColor} px={px} bold />
          </div>
          {fps > 0 && (
            <div
              className="font-mono"
              style={{ ...labelStyle(px), marginTop: px(3) }}
            >
              {(run.start / fps).toFixed(2)} s → {(run.end / fps).toFixed(2)} s
            </div>
          )}
        </>
      ) : (
        <div style={{ marginTop: px(3) }}>No subtask here</div>
      )}
    </>
  );
}

/** A readout beside the pointer, on the side with room, kept inside the frame. */
function HoverCard({
  hover,
  width,
  height,
  px,
  children,
}: {
  hover: { x: number; y: number };
  width: number;
  height: number;
  px: Scale;
  children: React.ReactNode;
}) {
  const [ref, { width: w, height: h }] = useSize<HTMLDivElement>();
  const gap = px(14);
  const flip = hover.x + gap + w > width - px(6);
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-10 tabular"
      style={{
        left: Math.max(px(6), flip ? hover.x - gap - w : hover.x + gap),
        top: Math.max(px(6), Math.min(height - h - px(6), hover.y - h / 2)),
        maxWidth: width - px(12),
        padding: `${px(7)}px ${px(PADDING)}px`,
        borderRadius: px(RADIUS),
        background: `${BRAND.background}e6`,
        fontSize: px(13),
        lineHeight: 1.3,
      }}
    >
      {children}
    </div>
  );
}

/** The value of a lone signal in a tag of its colour, above its marker (below it near the top). */
function ValueTag({
  curve,
  value,
  x,
  y,
  left,
  right,
  top,
  px,
}: {
  curve: CurveTrack;
  value: number;
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  px: Scale;
}) {
  const [ref, { width: w, height: h }] = useSize<HTMLDivElement>();
  const gap = px(14);
  const above = y - gap - h >= top;
  return (
    <div
      ref={ref}
      className="absolute tabular font-mono"
      style={{
        left: Math.min(Math.max(x - w / 2, left), right - w),
        top: above ? y - gap - h : y + gap,
        height: px(26),
        lineHeight: `${px(26)}px`,
        padding: `0 ${px(8)}px`,
        borderRadius: px(RADIUS),
        background: curve.color,
        color: BRAND.ink,
        fontSize: px(14),
        fontWeight: 600,
      }}
    >
      {formatScore(value, curve.signal.descriptor)}
    </div>
  );
}

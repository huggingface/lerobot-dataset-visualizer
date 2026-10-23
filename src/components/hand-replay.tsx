"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Bounds, Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { Vector3 } from "three";
import { useTime } from "@/context/time-context";
import { useTheme } from "@/utils/theme";
import {
  HAND_COLORS,
  HAND_EDGES,
  cameraPathRuns,
  fluToScene,
  handFrameIndex,
  wristTrail,
  type HandTracking,
  type HandFrame,
  type Point3,
} from "@/lib/hand-tracking";
import { SimpleVideosPlayer } from "./simple-videos-player";
import PlaybackBar from "./playback-bar";
import type { VideoInfo } from "@/types";

/** A fixed episode-wide fit keeps the orbit camera still while the hands move. */
function RecordingBounds({ tracking }: { tracking: HandTracking }) {
  const bounds = useMemo(() => {
    const lo: Point3 = [Infinity, Infinity, Infinity],
      hi: Point3 = [-Infinity, -Infinity, -Infinity];
    for (const frame of tracking.frames) {
      const positions = frame[tracking.coordinateFrame].flatMap(
        (hand) => hand ?? [],
      );
      if (frame.cameraPose) positions.push(frame.cameraPose.position);
      for (const p of positions) {
        const point = fluToScene(p);
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], point[a]);
          hi[a] = Math.max(hi[a], point[a]);
        }
      }
    }
    if (!Number.isFinite(lo[0]))
      return { center: [0, 0, 0] as Point3, size: [1, 1, 1] as Point3 };
    return {
      center: lo.map((v, a) => (v + hi[a]) / 2) as Point3,
      size: lo.map((v, a) => Math.max(hi[a] - v, 0.4)) as Point3,
    };
  }, [tracking]);
  return (
    <mesh position={bounds.center} visible={false}>
      <boxGeometry args={bounds.size} />
      <meshBasicMaterial />
    </mesh>
  );
}

function Hands({
  tracking,
  index,
  trails,
}: {
  tracking: HandTracking;
  index: number;
  trails: boolean;
}) {
  const frame = tracking.frames[index];
  return (
    <>
      {frame?.[tracking.coordinateFrame].map((joints, hand) => {
        if (!joints) return null;
        const points = joints.map(fluToScene),
          color = HAND_COLORS[hand];
        const trail = trails
          ? wristTrail(
              tracking.frames,
              index,
              hand,
              2,
              tracking.coordinateFrame,
            )
          : [];
        return (
          <group key={hand}>
            {HAND_EDGES.map(([a, b]) => (
              <Line
                key={`${a}-${b}`}
                points={[points[a], points[b]]}
                color={color}
                lineWidth={3}
              />
            ))}
            {points.map((p, joint) => (
              <mesh key={joint} position={p}>
                <sphereGeometry args={[joint === 0 ? 0.012 : 0.004, 12, 8]} />
                <meshBasicMaterial color={color} />
              </mesh>
            ))}
            {trail.length > 1 && (
              <Line
                points={trail}
                color={color}
                lineWidth={1.5}
                transparent
                opacity={0.5}
              />
            )}
          </group>
        );
      })}
    </>
  );
}

function RecordedCamera({
  tracking,
  index,
}: {
  tracking: HandTracking;
  index: number;
}) {
  const paths = useMemo(
    () => cameraPathRuns(tracking.frames, index),
    [tracking.frames, index],
  );
  const pose = tracking.frames[index]?.cameraPose;
  const origin = pose ? fluToScene(pose.position) : null;
  const at = (x: number, y: number, z: number): Point3 =>
    fluToScene(
      pose!.position.map(
        (p, axis) =>
          p +
          pose!.axes[0][axis] * x +
          pose!.axes[1][axis] * y +
          pose!.axes[2][axis] * z,
      ) as Point3,
    );
  const corners = pose
    ? [
        at(-0.055, -0.035, 0.08),
        at(0.055, -0.035, 0.08),
        at(0.055, 0.035, 0.08),
        at(-0.055, 0.035, 0.08),
      ]
    : [];
  return (
    <>
      {paths
        .filter((path) => path.length > 1)
        .map((path, i) => (
          <Line key={i} points={path} color="#8391a4" lineWidth={1.5} />
        ))}
      {origin && (
        <>
          <mesh position={origin}>
            <sphereGeometry args={[0.012, 12, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          {(["#ed6464", "#54ba7c", "#579cff"] as const).map((color, axis) => (
            <Line
              key={axis}
              points={[
                origin,
                at(
                  ...([0, 1, 2].map((a) => (a === axis ? 0.12 : 0)) as Point3),
                ),
              ]}
              color={color}
              lineWidth={2}
            />
          ))}
          {corners.map((corner, i) => (
            <Line
              key={i}
              points={[origin, corner, corners[(i + 1) % 4]]}
              color="#8391a4"
              lineWidth={1}
            />
          ))}
          <Html position={origin} style={{ pointerEvents: "none" }}>
            <span className="ml-3 text-xs text-fg-muted">Camera</span>
          </Html>
        </>
      )}
    </>
  );
}

/** Follow translation while preserving the user's orbit angle and zoom. */
function FollowCamera({
  frame,
  enabled,
}: {
  frame: HandFrame | undefined;
  enabled: boolean;
}) {
  const { camera, controls, invalidate } = useThree();
  const following = useRef(false);
  useEffect(() => {
    if (!enabled) {
      following.current = false;
      return;
    }
    if (!frame?.cameraPose) return;
    const orbit = controls as unknown as {
      target?: Vector3;
      update?: () => void;
    };
    if (!orbit?.target) return;
    const { position, axes } = frame.cameraPose;
    const focus = new Vector3(
      ...fluToScene(position.map((v, a) => v + axes[2][a] * 0.4) as Point3),
    );
    if (!following.current) {
      camera.position
        .sub(orbit.target)
        .normalize()
        .multiplyScalar(1.1)
        .add(focus);
      following.current = true;
    } else camera.position.add(focus.clone().sub(orbit.target));
    orbit.target.copy(focus);
    orbit.update?.();
    invalidate();
  }, [camera, controls, enabled, frame, invalidate]);
  return null;
}

export default function HandReplay({
  tracking,
  videosInfo,
}: {
  tracking: HandTracking;
  videosInfo: VideoInfo[];
}) {
  const { currentTime, seek } = useTime();
  // This lazy panel can mount after the page's initial ?t= seek. Reapply it when
  // media is ready so the source camera doesn't replace it with its first frame.
  const initialTime = useRef(currentTime);
  const onVideosReady = useCallback(() => seek(initialTime.current), [seek]);
  const theme = useTheme();
  const [trails, setTrails] = useState(true);
  const [follow, setFollow] = useState(false);
  const index = handFrameIndex(tracking.frames, currentTime),
    frame = tracking.frames[index];
  const videos = useMemo(
    () =>
      [...videosInfo].sort(
        (a, b) =>
          Number(b.filename === tracking.cameraKey) -
          Number(a.filename === tracking.cameraKey),
      ),
    [videosInfo, tracking.cameraKey],
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-4">
          {HAND_COLORS.map((color, hand) => (
            <span key={hand} className="flex items-center gap-1.5">
              <i
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {hand === 0 ? "Left" : "Right"} hand
            </span>
          ))}
          <span className="font-mono text-xs text-fg-muted">
            Frame {index >= 0 ? index : "—"}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {tracking.coordinateFrame === "recording" && (
            <button
              type="button"
              className={`btn text-xs ${follow ? "btn-active" : ""}`}
              aria-pressed={follow}
              onClick={() => setFollow((value) => !value)}
            >
              Follow camera
            </button>
          )}
          <label className="flex items-center gap-2 text-fg-soft">
            <input
              type="checkbox"
              checked={trails}
              onChange={(e) => setTrails(e.target.checked)}
            />
            Wrist trails
          </label>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 items-start">
        <div className="panel overflow-hidden">
          <div
            className="relative h-[min(45vh,420px)] min-h-72"
            aria-label="3D recorded hand and wrist positions"
          >
            <Canvas
              frameloop="demand"
              camera={{ position: [0.8, 0.6, 1.1], near: 0.001, far: 1000 }}
            >
              <color
                attach="background"
                args={[theme === "dark" ? "#151b24" : "#f3f5f7"]}
              />
              <OrbitControls makeDefault />
              <Bounds fit clip margin={1.5}>
                <RecordingBounds tracking={tracking} />
              </Bounds>
              <Grid
                infiniteGrid
                cellSize={0.1}
                sectionSize={0.5}
                fadeDistance={12}
                cellColor={theme === "dark" ? "#354052" : "#cbd2dc"}
                sectionColor={theme === "dark" ? "#536278" : "#9aa6b5"}
              />
              <axesHelper args={[0.15]} />
              <Hands tracking={tracking} index={index} trails={trails} />
              <RecordedCamera tracking={tracking} index={index} />
              <FollowCamera frame={frame} enabled={follow} />
            </Canvas>
            {!frame?.[tracking.coordinateFrame].some(Boolean) && (
              <div className="absolute inset-x-0 top-4 text-center pointer-events-none">
                <span className="rounded bg-[var(--surface-0)] px-3 py-2 text-sm text-fg-muted">
                  No observed hand pose at this frame
                </span>
              </div>
            )}
          </div>
          <div className="border-t border-line-subtle p-3 text-xs text-fg-muted space-y-1">
            <p>Drag to orbit · scroll to zoom · grid cells 10 cm</p>
            <p>
              {tracking.coordinateFrame === "recording"
                ? "Recording frame anchored to the first saved camera pose, in meters. Camera paths and wrist trails break where poses are missing."
                : "Segment-start frame, in meters. Coordinates and trails reset at each valid span. Camera transforms are unavailable."}
            </p>
            {(["Left", "Right"] as const).map((side, hand) => (
              <p key={side} className="font-mono">
                {side} wrist:{" "}
                {frame?.[tracking.coordinateFrame][hand]?.[0]
                  .map((n) => n.toFixed(3))
                  .join(", ") ?? "unobserved"}{" "}
                {frame?.[tracking.coordinateFrame][hand]
                  ? "(forward, left, up)"
                  : ""}
              </p>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <SimpleVideosPlayer
            videosInfo={videos}
            handTracking={tracking}
            onVideosReady={onVideosReady}
          />
          {tracking.overlayIssue && (
            <p className="text-sm text-fg-muted">{tracking.overlayIssue}</p>
          )}
          {tracking.calibration?.estimated && (
            <p className="text-xs text-fg-muted">
              Camera intrinsics were estimated with MoGe. Metric accuracy is
              unvalidated.
            </p>
          )}
        </div>
      </div>
      <PlaybackBar />
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import {
  HAND_COLORS,
  HAND_EDGES,
  HAND_INDICES,
  handFrameIndex,
  projectHandPoint,
  type HandTracking,
} from "@/lib/hand-tracking";

/** Follow this camera's displayed frames, including paused seeks and shared-file offsets. */
export function HandOverlayCanvas({
  video,
  tracking,
  cameraKey,
  segmentStart = 0,
  enabled,
}: {
  video: HTMLVideoElement | null;
  tracking: HandTracking;
  cameraKey: string;
  segmentStart?: number;
  enabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const calibration = tracking.calibration;
    if (
      !canvas ||
      !video ||
      !calibration ||
      cameraKey !== tracking.cameraKey ||
      !enabled
    )
      return;
    let callback = 0;
    let mediaTime = video.currentTime;
    const draw = (time = mediaTime) => {
      mediaTime = time;
      const width = video.clientWidth,
        height = video.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (
        canvas.width !== Math.round(width * dpr) ||
        canvas.height !== Math.round(height * dpr)
      ) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // A changed crop/resolution needs a corresponding calibration, not an implicit guess.
      if (
        video.videoWidth !== calibration.width ||
        video.videoHeight !== calibration.height
      )
        return;
      const scale = Math.min(
        width / calibration.width,
        height / calibration.height,
      );
      const left = (width - calibration.width * scale) / 2;
      const top = (height - calibration.height * scale) / 2;
      const frame =
        tracking.frames[handFrameIndex(tracking.frames, time - segmentStart)];
      if (!frame) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        left,
        top,
        calibration.width * scale,
        calibration.height * scale,
      );
      ctx.clip();
      HAND_INDICES.forEach((hand) => {
        const joints = frame.camera[hand];
        if (!joints) return;
        const points = joints.map((p): [number, number] | null => {
          const pixel = projectHandPoint(p, calibration);
          return pixel
            ? [left + pixel[0] * scale, top + pixel[1] * scale]
            : null;
        });
        const path = () => {
          ctx.beginPath();
          for (const [a, b] of HAND_EDGES) {
            const p = points[a],
              q = points[b];
            if (p && q) {
              ctx.moveTo(p[0], p[1]);
              ctx.lineTo(q[0], q[1]);
            }
          }
          ctx.stroke();
        };
        ctx.strokeStyle = "#111827";
        ctx.lineWidth = 5;
        path();
        ctx.strokeStyle = HAND_COLORS[hand];
        ctx.lineWidth = 2.5;
        path();
        points.forEach((p, joint) => {
          if (!p) return;
          ctx.beginPath();
          ctx.arc(p[0], p[1], joint === 0 ? 5 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle = HAND_COLORS[hand];
          ctx.fill();
        });
        const wrist = points[0];
        if (wrist) {
          ctx.font = "bold 13px sans-serif";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#111827";
          ctx.strokeText(hand === 0 ? "L" : "R", wrist[0] + 8, wrist[1] - 8);
          ctx.fillText(hand === 0 ? "L" : "R", wrist[0] + 8, wrist[1] - 8);
        }
      });
      ctx.restore();
    };
    const update = () => draw(video.currentTime);
    const observer = new ResizeObserver(() => draw());
    observer.observe(video);
    const events = ["loadeddata", "seeked", "resize"];
    events.forEach((event) => video.addEventListener(event, update));
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        draw(metadata.mediaTime);
        callback = video.requestVideoFrameCallback(frame);
      };
      callback = video.requestVideoFrameCallback(frame);
    } else video.addEventListener("timeupdate", update);
    update();
    return () => {
      observer.disconnect();
      events.forEach((event) => video.removeEventListener(event, update));
      video.removeEventListener("timeupdate", update);
      if (callback) video.cancelVideoFrameCallback(callback);
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [video, tracking, cameraKey, segmentStart, enabled]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full pointer-events-none"
    />
  );
}

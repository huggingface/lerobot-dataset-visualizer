"use client";

/**
 * Recolors a single-channel (grayscale) camera feed with the viridis colormap.
 *
 * The grayscale data is stored as an ordinary MP4 (R==G==B per pixel). The
 * `<video>` element keeps doing all decode / timing / seek / loop work in
 * `simple-videos-player.tsx`; we just hide it visually and draw each presented
 * frame onto a stacked canvas, mapping luminance through a 256-entry viridis
 * LUT.
 *
 * The canvas bitmap is sized to the video's intrinsic resolution and displayed
 * with `object-contain`, so it letterboxes exactly like the `<video>` would in
 * both the inline and enlarged layouts — no manual rect math needed.
 *
 * Primary path is a WebGL fragment shader (runs on the viewer's GPU, smooth
 * with several feeds at once). If WebGL is unavailable we fall back to a 2D
 * canvas LUT walk on the CPU. All work is client-side; the server never sees
 * pixels.
 */

import React, { useEffect, useRef } from "react";
import { VIRIDIS_LUT, viridisColor } from "@/utils/colormaps";

interface Props {
  videoEl: HTMLVideoElement | null;
  active?: boolean;
  // [low, high] normalized luminance band mapped onto the full colormap
  // (q10/q90 from stats.json). Defaults to the full 0..1 range.
  range?: [number, number];
}

const VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform sampler2D uLut;
uniform float uLow;
uniform float uHigh;
void main() {
  vec3 c = texture2D(uFrame, vUv).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float t = clamp((lum - uLow) / (uHigh - uLow), 0.0, 1.0);
  gl_FragColor = vec4(texture2D(uLut, vec2(t, 0.5)).rgb, 1.0);
}`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// Sets up the WebGL program, geometry and LUT texture. Returns a per-frame
// draw callback, or null if WebGL/shader setup fails (caller then falls back
// to 2D).
function setupWebGL(
  gl: WebGLRenderingContext,
): ((video: HTMLVideoElement, low: number, high: number) => void) | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const lutTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGB,
    256,
    1,
    0,
    gl.RGB,
    gl.UNSIGNED_BYTE,
    VIRIDIS_LUT,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const frameTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLut"), 1);
  const lowLoc = gl.getUniformLocation(program, "uLow");
  const highLoc = gl.getUniformLocation(program, "uHigh");

  return (video: HTMLVideoElement, low: number, high: number) => {
    gl.uniform1f(lowLoc, low);
    gl.uniform1f(highLoc, high);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

export const ColormappedVideo: React.FC<Props> = ({
  videoEl,
  active,
  range,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const low = range?.[0] ?? 0;
  const high = range && range[1] > range[0] ? range[1] : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas || !videoEl) return;

    let frameHandle: number | null = null;
    let cancelled = false;

    const gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    const drawWebGL = gl ? setupWebGL(gl) : null;

    // 2D fallback resources (only used when WebGL is unavailable).
    const ctx2d = !drawWebGL ? canvas.getContext("2d") : null;
    let scratch: HTMLCanvasElement | null = null;
    let scratchCtx: CanvasRenderingContext2D | null = null;

    const ensureSize = () => {
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;
      if (!w || !h) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (gl) gl.viewport(0, 0, w, h);
      }
      return true;
    };

    const span = high - low;
    const drawFrame = () => {
      if (!ensureSize()) return;
      if (drawWebGL) {
        drawWebGL(videoEl, low, high);
        return;
      }
      if (!ctx2d) return;
      const w = canvas.width;
      const h = canvas.height;
      if (!scratch) {
        scratch = document.createElement("canvas");
        scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
      }
      if (!scratchCtx) return;
      scratch.width = w;
      scratch.height = h;
      scratchCtx.drawImage(videoEl, 0, 0, w, h);
      const img = scratchCtx.getImageData(0, 0, w, h);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum =
          (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        const [r, g, b] = viridisColor((lum - low) / span);
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
      ctx2d.putImageData(img, 0, 0);
    };

    // Prefer requestVideoFrameCallback so we only repaint on actual presented
    // frames (covers play, seek-while-paused, and loop resets). Fall back to
    // requestAnimationFrame where the API is missing.
    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const rvfcEl = videoEl as RVFCVideo;
    const hasRVFC = typeof rvfcEl.requestVideoFrameCallback === "function";

    const loop = () => {
      if (cancelled) return;
      drawFrame();
      if (hasRVFC) {
        frameHandle = rvfcEl.requestVideoFrameCallback!(loop);
      } else {
        frameHandle = requestAnimationFrame(loop);
      }
    };
    loop();

    return () => {
      cancelled = true;
      if (frameHandle != null) {
        if (hasRVFC) rvfcEl.cancelVideoFrameCallback?.(frameHandle);
        else cancelAnimationFrame(frameHandle);
      }
    };
  }, [videoEl, active, low, high]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
    />
  );
};

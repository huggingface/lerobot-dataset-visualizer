import type { DatasetMetadata } from "@/utils/parquetUtils";

export type Point3 = [number, number, number];
export type HandIndex = 0 | 1;
export type HandPair = [Point3[] | null, Point3[] | null];
export type CameraPose = { position: Point3; axes: [Point3, Point3, Point3] };
export type HandFrame = {
  time: number;
  referenceFrame: number;
  camera: HandPair;
  segment: HandPair;
  recording: HandPair;
  cameraPose: CameraPose | null;
};
export type HandCalibration = {
  model: "pinhole" | "opencv_fisheye";
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion: number[];
  estimated: boolean;
};
export type HandTracking = {
  frames: HandFrame[];
  fps: number;
  cameraKey: string | null;
  calibration: HandCalibration | null;
  overlayIssue: string | null;
  coordinateFrame: "recording" | "segment";
};
type NumericFrames = {
  length: number;
  timestamps: number[];
  series: Record<string, number[][]>;
};

export const HAND_COLORS = ["#59b5ff", "#ffb454"] as const;
export const HAND_INDICES = [0, 1] as const;
export const HAND_EDGES = [1, 5, 9, 13, 17].flatMap(
  (base): [number, number][] => [
    [0, base],
    [base, base + 1],
    [base + 1, base + 2],
    [base + 2, base + 3],
  ],
);
const HAND_WIDTHS: Record<string, number> = {
  "annotation.hand_joints_camera": 126,
  "annotation.hand_joints_world": 126,
  "annotation.hand_action_valid": 1,
  "annotation.hand_observed": 2,
  "annotation.hand_reference_frame": 1,
};

/** The SOMA156 contract, rather than a robot name or an arbitrary 156D action. */
export function hasHandTracking(info: DatasetMetadata): boolean {
  return (
    info.features.action?.shape.join() === "156" &&
    Object.entries(HAND_WIDTHS).every(
      ([key, width]) => info.features[key]?.shape.join() === String(width),
    )
  );
}

/** Native auxiliary arrays have their own viewer, rather than hundreds of chart series. */
export function isHandGeometryColumn(key: string): boolean {
  return (
    key.startsWith("annotation.hand_") ||
    key.startsWith("annotation.soma_") ||
    key === "annotation.wrist_rotation_camera" ||
    key === "annotation.camera_world_from_optical"
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseHandCalibration(value: unknown): HandCalibration | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const c = record(value);
  const { width, height, fx, fy, cx, cy } = c;
  if (
    !isFiniteNumber(width) ||
    !Number.isInteger(width) ||
    width <= 0 ||
    !isFiniteNumber(height) ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !isFiniteNumber(fx) ||
    fx <= 0 ||
    !isFiniteNumber(fy) ||
    fy <= 0 ||
    !isFiniteNumber(cx) ||
    !isFiniteNumber(cy)
  )
    return null;
  if (c.model !== "pinhole" && c.model !== "opencv_fisheye") return null;
  const d = c.distortion ?? [];
  if (
    !Array.isArray(d) ||
    !d.every(isFiniteNumber) ||
    !(c.model === "pinhole" ? [0, 4, 5, 8, 12, 14] : [4]).includes(d.length)
  )
    return null;
  return {
    model: c.model,
    width,
    height,
    fx,
    fy,
    cx,
    cy,
    distortion: d,
    estimated: c.measured === false || c.source === "moge-estimated",
  };
}

/** Run episodes are source IDs and can finish out of order; exports can be reindexed. */
export function handProjectionMetadata(
  info: DatasetMetadata,
  episodeId: number,
  reportValue: unknown,
): Pick<HandTracking, "cameraKey" | "calibration" | "overlayIssue"> {
  const report = record(reportValue);
  const manifest = record(report.manifest);
  const cameras = Object.keys(info.features).filter(
    (key) => info.features[key].dtype === "video",
  );
  const cameraKey =
    typeof manifest.camera === "string"
      ? cameras.includes(manifest.camera)
        ? manifest.camera
        : null
      : cameras.length === 1
        ? cameras[0]
        : null;
  const mapping = Array.isArray(report.source_episode_map)
    ? report.source_episode_map.map(record)
    : null;
  const mapped = mapping?.find((entry) => entry.episode_index === episodeId);
  const sourceId = mapping ? mapped?.source_episode_index : episodeId;
  const episodes = Array.isArray(report.episodes)
    ? report.episodes.map(record)
    : [];
  const sourceEpisode =
    isFiniteNumber(sourceId) && Number.isSafeInteger(sourceId) && sourceId >= 0
      ? episodes.find((entry) => entry.episode_index === sourceId)
      : undefined;
  const handResult = record(sourceEpisode?.hand_actions);
  const calibration =
    parseHandCalibration(handResult.camera_intrinsics) ??
    parseHandCalibration(
      cameraKey ? info.features[cameraKey].info?.["camera.intrinsics"] : null,
    );
  return {
    cameraKey,
    calibration,
    overlayIssue: !cameraKey
      ? "The annotation camera is unknown; camera overlays are unavailable."
      : !calibration
        ? "No camera calibration is saved for this episode; 3D hands remain available."
        : null,
  };
}

/** Keep the full source frame grid. Never turn masked zero placeholders into hands. */
export function readHandTracking(
  info: DatasetMetadata,
  frames: NumericFrames | undefined,
  metadata: ReturnType<typeof handProjectionMetadata>,
): HandTracking | undefined {
  if (!hasHandTracking(info)) return undefined;
  const rows: HandFrame[] = [];
  const cameraMatrices: (number[] | null)[] = [];
  const timeOrigin = frames?.timestamps[0] ?? 0;
  const points = (
    key: string,
    frame: number,
    hand: HandIndex,
  ): Point3[] | null => {
    const components = frames?.series[key];
    if (components?.length !== 126) return null;
    const joints = Array.from({ length: 21 }, (_, joint): Point3 => {
      const offset = hand * 63 + joint * 3;
      return [
        components[offset]?.[frame],
        components[offset + 1]?.[frame],
        components[offset + 2]?.[frame],
      ];
    });
    return joints.every((p) => p.every(Number.isFinite)) ? joints : null;
  };
  if (
    frames &&
    frames.timestamps.length === frames.length &&
    Number.isFinite(timeOrigin)
  ) {
    for (let i = 0; i < frames.length; i++) {
      const time = frames.timestamps[i] - timeOrigin;
      if (!Number.isFinite(time) || (i > 0 && time <= rows[i - 1].time))
        return undefined;
      const reference =
        frames.series["annotation.hand_reference_frame"]?.[0]?.[i];
      const valid =
        frames.series["annotation.hand_action_valid"]?.[0]?.[i] === 1 &&
        Number.isInteger(reference) &&
        reference >= 0 &&
        reference <= i;
      const observed = (hand: HandIndex) =>
        valid && frames.series["annotation.hand_observed"]?.[hand]?.[i] === 1;
      const camera: HandPair = [null, null],
        segment: HandPair = [null, null];
      for (const hand of HAND_INDICES) {
        if (!observed(hand)) continue;
        const cameraPoints = points("annotation.hand_joints_camera", i, hand);
        const segmentPoints = points("annotation.hand_joints_world", i, hand);
        if (cameraPoints && segmentPoints) {
          camera[hand] = cameraPoints;
          segment[hand] = segmentPoints;
        }
      }
      rows.push({
        time,
        referenceFrame: valid ? reference : -1,
        camera,
        segment,
        recording: [null, null],
        cameraPose: null,
      });
      const matrix = frames.series["annotation.camera_world_from_optical"];
      const pose =
        matrix?.length === 16 ? matrix.map((component) => component[i]) : null;
      cameraMatrices.push(pose && isCameraTransform(pose) ? pose : null);
    }
  }
  const origin = cameraMatrices.find((matrix) => matrix !== null);
  if (origin)
    rows.forEach((frame, i) => {
      const pose = cameraMatrices[i];
      if (!pose) return;
      // Only saved rigid transforms are used. Masked zero matrices are not camera poses.
      const relative = (p: Point3): Point3 => {
        const world = [0, 1, 2].map(
          (a) =>
            pose[a * 4] * p[0] +
            pose[a * 4 + 1] * p[1] +
            pose[a * 4 + 2] * p[2] +
            pose[a * 4 + 3] -
            origin[a * 4 + 3],
        );
        const optical = [0, 1, 2].map(
          (a) =>
            origin[a] * world[0] +
            origin[a + 4] * world[1] +
            origin[a + 8] * world[2],
        );
        return [optical[2], -optical[0], -optical[1]];
      };
      const position = relative([0, 0, 0]);
      const axis = (p: Point3): Point3 => {
        const end = relative(p);
        return [
          end[0] - position[0],
          end[1] - position[1],
          end[2] - position[2],
        ];
      };
      frame.cameraPose = {
        position,
        axes: [axis([1, 0, 0]), axis([0, 1, 0]), axis([0, 0, 1])],
      };
      frame.recording = [
        frame.camera[0]?.map(relative) ?? null,
        frame.camera[1]?.map(relative) ?? null,
      ];
    });
  return {
    frames: rows,
    fps: info.fps,
    coordinateFrame: origin ? "recording" : "segment",
    ...metadata,
  };
}

function isCameraTransform(m: number[]): boolean {
  if (
    !m.every(Number.isFinite) ||
    [m[12], m[13], m[14], m[15] - 1].some((n) => Math.abs(n) > 1e-4)
  )
    return false;
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      const dot = [0, 1, 2].reduce(
        (sum, k) => sum + m[k * 4 + a] * m[k * 4 + b],
        0,
      );
      if (Math.abs(dot - Number(a === b)) > 2e-3) return false;
    }
  const determinant =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  return Math.abs(determinant - 1) < 2e-3;
}

/** The frame currently on screen, without interpolation or looking ahead to the next pose. */
export function handFrameIndex(frames: HandFrame[], time: number): number {
  let lo = 0,
    hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].time <= time + 1e-7) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The stored "world" joints are segment-start FLU, not a continuous global trajectory. */
export function fluToScene([forward, left, up]: Point3): Point3 {
  return [-left, up, -forward];
}

/** Break trails both at validity gaps and at each segment-reference reset. */
export function wristTrail(
  frames: HandFrame[],
  index: number,
  hand: HandIndex,
  seconds = 2,
  space: "segment" | "recording" = "segment",
): Point3[] {
  const trail: Point3[] = [];
  const current = frames[index];
  if (!current?.[space][hand]) return trail;
  for (let i = index; i >= 0; i--) {
    const f = frames[i];
    const joints = f[space][hand];
    if (
      !joints ||
      (space === "segment" && f.referenceFrame !== current.referenceFrame) ||
      current.time - f.time > seconds
    )
      break;
    trail.push(fluToScene(joints[0]));
  }
  return trail.reverse();
}

/** Separate camera-path runs wherever no transform was saved; never draw through zero placeholders. */
export function cameraPathRuns(frames: HandFrame[], index: number): Point3[][] {
  const runs: Point3[][] = [];
  let run: Point3[] = [];
  for (let i = 0; i <= index; i++) {
    const pose = frames[i]?.cameraPose;
    if (pose) run.push(fluToScene(pose.position));
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Project optical-camera XYZ onto the original, possibly distorted source image. */
export function projectHandPoint(
  point: Point3,
  c: HandCalibration,
): [number, number] | null {
  if (!point.every(Number.isFinite) || point[2] <= 1e-6) return null;
  let x = point[0] / point[2],
    y = point[1] / point[2];
  const d = c.distortion;
  const r2 = x * x + y * y;
  if (c.model === "opencv_fisheye") {
    const r = Math.sqrt(r2),
      theta = Math.atan(r),
      t2 = theta * theta;
    const scale =
      r < 1e-10
        ? 1
        : (theta * (1 + t2 * (d[0] + t2 * (d[1] + t2 * (d[2] + t2 * d[3]))))) /
          r;
    x *= scale;
    y *= scale;
  } else if (d.length) {
    const [
      k1 = 0,
      k2 = 0,
      p1 = 0,
      p2 = 0,
      k3 = 0,
      k4 = 0,
      k5 = 0,
      k6 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0,
      s4 = 0,
      tx = 0,
      ty = 0,
    ] = d;
    const denominator = 1 + r2 * (k4 + r2 * (k5 + r2 * k6));
    if (Math.abs(denominator) < 1e-12) return null;
    const radial = (1 + r2 * (k1 + r2 * (k2 + r2 * k3))) / denominator;
    const dx =
      x * radial +
      2 * p1 * x * y +
      p2 * (r2 + 2 * x * x) +
      s1 * r2 +
      s2 * r2 * r2;
    const dy =
      y * radial +
      p1 * (r2 + 2 * y * y) +
      2 * p2 * x * y +
      s3 * r2 +
      s4 * r2 * r2;
    // OpenCV's tilted-sensor projection (tau_x, tau_y), after radial/tangential distortion.
    const sx = Math.sin(tx),
      cx = Math.cos(tx),
      sy = Math.sin(ty),
      cy = Math.cos(ty);
    const vx = cy * dx + sy * sx * dy - sy * cx;
    const vy = cx * dy + sx;
    const vz = sy * dx - cy * sx * dy + cy * cx;
    if (Math.abs(vz) < 1e-12) return null;
    x = (cy * cx * vx + sy * cx * vz) / vz;
    y = (cy * cx * vy - sx * vz) / vz;
  }
  const pixel: [number, number] = [c.fx * x + c.cx, c.fy * y + c.cy];
  return pixel.every(Number.isFinite) ? pixel : null;
}

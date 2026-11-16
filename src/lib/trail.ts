/**
 * The 3D Replay trail's geometry: the path a tool point (a gripper, a hand) takes through an
 * episode, smoothed, and the triangle strip the trail shader draws it with. Pure, so it is tested
 * without a GPU; `replay-trail.ts` draws it.
 */

/** Below this distance two samples are the same place: the robot held still. */
const SAME_PLACE = 1e-6;

export interface TrailPath {
  /** xyz per point. */
  points: Float32Array;
  /**
   * The episode frame each point belongs to, fractional between frames and never decreasing. The
   * shader compares it with the current frame to tell the past, the recent tail and the future.
   */
  along: Float32Array;
  count: number;
}

/**
 * Centripetal Catmull–Rom through `p0..p3`, at `t` in [0, 1] between p1 and p2 (Barry–Goldman).
 * Centripetal, unlike the uniform kind, never overshoots into loops between close samples.
 */
function catmullRom(
  p0: ArrayLike<number>,
  p1: ArrayLike<number>,
  p2: ArrayLike<number>,
  p3: ArrayLike<number>,
  t: number,
  out: Float32Array,
  at: number,
): void {
  const knot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    Math.max(
      Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])),
      1e-4,
    );
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  for (let c = 0; c < 3; c++) {
    const a1 = ((t1 - u) * p0[c] + u * p1[c]) / t1;
    const a2 = ((t2 - u) * p1[c] + (u - t1) * p2[c]) / (t2 - t1);
    const a3 = ((t3 - u) * p2[c] + (u - t2) * p3[c]) / (t3 - t2);
    const b1 = ((t2 - u) * a1 + u * a2) / t2;
    const b2 = ((t3 - u) * a2 + (u - t1) * a3) / (t3 - t1);
    out[at + c] = ((t2 - u) * b1 + (u - t1) * b2) / (t2 - t1);
  }
}

/**
 * The curve through one sample per frame (`samples`, xyz each), with `subdivisions` points per step
 * between frames.
 *
 * A run of frames where the robot holds still collapses to two points, at its first and last frame:
 * the trail then knows the robot was there all that time, and draws no zero-length steps (which have
 * no direction to draw a line across).
 */
export function smoothPath(
  samples: Float32Array,
  subdivisions: number,
): TrailPath {
  const frames = Math.floor(samples.length / 3);
  const steps = Math.max(1, Math.floor(subdivisions));

  // Distinct places, in order, with the frames the robot spent at each.
  const places: number[] = [];
  const firstFrame: number[] = [];
  const lastFrame: number[] = [];
  for (let k = 0; k < frames; k++) {
    const x = samples[k * 3];
    const y = samples[k * 3 + 1];
    const z = samples[k * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      continue;
    const n = firstFrame.length;
    if (
      n > 0 &&
      Math.hypot(
        x - places[(n - 1) * 3],
        y - places[(n - 1) * 3 + 1],
        z - places[(n - 1) * 3 + 2],
      ) < SAME_PLACE
    ) {
      lastFrame[n - 1] = k;
      continue;
    }
    places.push(x, y, z);
    firstFrame.push(k);
    lastFrame.push(k);
  }

  const n = firstFrame.length;
  const held = firstFrame.filter((f, i) => lastFrame[i] > f).length;
  const count = n + held + Math.max(0, n - 1) * (steps - 1);
  const points = new Float32Array(count * 3);
  const along = new Float32Array(count);

  const place = (i: number) => {
    const c = Math.min(n - 1, Math.max(0, i));
    return places.slice(c * 3, c * 3 + 3);
  };
  /// Past the ends, a mirrored neighbour keeps the end segments straight rather than hooked.
  const before = (i: number) => {
    if (i >= 0) return place(i);
    const a = place(0);
    const b = place(1);
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  };
  const after = (i: number) => {
    if (i < n) return place(i);
    const a = place(n - 1);
    const b = place(n - 2);
    return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  };

  let w = 0;
  for (let i = 0; i < n; i++) {
    const p = place(i);
    points.set(p, w * 3);
    along[w++] = firstFrame[i];
    if (lastFrame[i] > firstFrame[i]) {
      points.set(p, w * 3);
      along[w++] = lastFrame[i];
    }
    if (i === n - 1) break;
    // The step to the next place is taken between the last frame here and the next one.
    const p0 = before(i - 1);
    const p2 = place(i + 1);
    const p3 = after(i + 2);
    for (let j = 1; j < steps; j++) {
      catmullRom(p0, p, p2, p3, j / steps, points, w * 3);
      along[w++] = lastFrame[i] + j / steps;
    }
  }
  return { points, along, count: w };
}

/** Points per step between frames: smooth, within `budget` points for the whole episode. */
export function subdivisionsFor(frames: number, budget = 24_000): number {
  return Math.max(1, Math.min(4, Math.floor(budget / Math.max(1, frames))));
}

export interface RibbonArrays {
  /** Two vertices per point, one each side of the line. */
  position: Float32Array;
  /** The neighbouring points, which give the line's direction at each vertex. */
  previous: Float32Array;
  next: Float32Array;
  /** -1 or 1: which side of the line the vertex is pushed to. */
  side: Float32Array;
  along: Float32Array;
  index: Uint32Array;
}

/**
 * A triangle strip along `path`, two vertices per point. The shader pushes each vertex sideways in
 * screen space, so the line keeps its width in pixels at any zoom; the strip joins its segments
 * itself, so a transparent line has no overlapping caps that would show as beads.
 */
export function ribbonArrays(path: TrailPath): RibbonArrays {
  const { points, along, count } = path;
  const position = new Float32Array(count * 6);
  const previous = new Float32Array(count * 6);
  const next = new Float32Array(count * 6);
  const side = new Float32Array(count * 2);
  const alongOut = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    const before = Math.max(0, i - 1) * 3;
    const ahead = Math.min(count - 1, i + 1) * 3;
    for (let s = 0; s < 2; s++) {
      const v = i * 2 + s;
      for (let c = 0; c < 3; c++) {
        position[v * 3 + c] = points[p + c];
        previous[v * 3 + c] = points[before + c];
        next[v * 3 + c] = points[ahead + c];
      }
      side[v] = s === 0 ? -1 : 1;
      alongOut[v] = along[i];
    }
  }
  const segments = Math.max(0, count - 1);
  const index = new Uint32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
  }
  return { position, previous, next, side, along: alongOut, index };
}

/** Which side of the robot a tool point is on, from its prim path; `null` when it doesn't say. */
export function tipSide(path: string): "left" | "right" | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|_)(left|l)(_|$)/i.test(name)) return "left";
  if (/(^|_)(right|r)(_|$)/i.test(name)) return "right";
  return null;
}

import * as THREE from "three";
import { ribbonArrays, smoothPath, subdivisionsFor } from "@/lib/trail";

/**
 * The 3D Replay trail of one tool point. The whole episode's path is one static mesh; what is
 * recent, past or ahead is worked out on the GPU from the current frame, so playing, pausing,
 * scrubbing and stepping only change a uniform.
 *
 * Three draws share the path's geometry: the line itself (a tapered, glowing tail over a faint
 * line for the rest of the episode), its shadow on the floor, and a marker at the tool point.
 */

export type TrailMode = "off" | "recent" | "episode";

export interface TrailStyle {
  color: THREE.Color;
  /** The rest of the episode's path, drawn faint. */
  pathColor: THREE.Color;
  /** Mixed into the line's core toward the head, so the newest part reads as the brightest. */
  headColor: THREE.Color;
  shadowColor: THREE.Color;
  shadowOpacity: number;
  /** The marker's centre; its ring takes `color`. */
  markerCenter: THREE.Color;
}

/** Pixel sizes, before the device pixel ratio. */
const HEAD_WIDTH = 5;
const PATH_WIDTH = 2;
const GLOW_WIDTH = 6;
const SHADOW_WIDTH = 4;
const MARKER_SIZE = 12;
/** How much of the rest of the episode shows in "episode" mode, behind and ahead of the tail. */
const PAST_ALPHA = 0.55;
const FUTURE_ALPHA = 0.22;
/**
 * On a long episode the path far from the current frame fades further, to this share of its
 * alpha, so the whole episode reads as context rather than as a scribble.
 */
const DISTANT_PATH = 0.3;
/** What shows of the trail where the robot is in front of it. */
const HIDDEN_OPACITY = 0.28;
/** Just above the shadow catcher (y = 0.001); a polygon offset keeps it from flickering there. */
const FLOOR_Y = 0.0015;

const ribbonVertex = /* glsl */ `
attribute vec3 previous;
attribute vec3 next;
attribute float side;
attribute float along;

uniform vec2 uResolution;
uniform float uFrame;
uniform float uTail;
uniform float uContext;
uniform float uHeadWidth;
uniform float uPathWidth;
uniform float uGlowWidth;
uniform float uPastAlpha;
uniform float uFutureAlpha;
uniform float uFlatten;
uniform float uFloorY;
uniform float uShadowFade;

varying float vSide;
varying float vAlpha;
varying float vCore;
varying float vHalf;
varying float vGlow;
varying float vAge;

vec4 clipOf(vec3 p) {
  if (uFlatten > 0.5) p.y = uFloorY;
  return projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}

void main() {
  // 0 at the head, 1 where the tail ends, below 0 for what is still ahead.
  float age = (uFrame - along) / uTail;
  float tail = (age >= 0.0 && age <= 1.0) ? 1.0 - age : 0.0;
  float shape = pow(tail, 0.6);
  float core = mix(uPathWidth, uHeadWidth, shape);
  float distant = smoothstep(0.5 * uContext, uContext, abs(uFrame - along));
  float pathAlpha = (age < 0.0 ? uFutureAlpha : uPastAlpha) * mix(1.0, ${DISTANT_PATH.toFixed(2)}, distant);
  float alpha = max(tail, pathAlpha);
  // A shadow fades as what casts it rises, like a contact shadow: under an arm held high it would
  // only be a smudge on the floor, far from the trail.
  if (uFlatten > 0.5) alpha *= 1.0 - smoothstep(0.1 * uShadowFade, uShadowFade, position.y - uFloorY);
  // A line thinner than a pixel is drawn a pixel wide and fainter, so it doesn't shimmer.
  alpha *= clamp(core, 0.0, 1.0);
  core = max(core, 1.0);
  // A pixel beyond the line on each side, for its antialiased edge.
  float halfWidth = 0.5 * core + uGlowWidth * shape + 1.0;

  vec4 c = clipOf(position);
  vec4 p = clipOf(previous);
  vec4 n = clipOf(next);
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 cs = c.xy / c.w * aspect;
  vec2 d1 = cs - p.xy / p.w * aspect;
  vec2 d2 = n.xy / n.w * aspect - cs;
  float l1 = length(d1);
  float l2 = length(d2);
  vec2 dir = vec2(1.0, 0.0);
  float miter = 1.0;
  if (l1 < 1e-6 && l2 < 1e-6) {
    // Seen end on, or a point on its own: nothing to draw across.
    alpha = 0.0;
  } else if (l1 < 1e-6) {
    dir = d2 / l2;
  } else if (l2 < 1e-6) {
    dir = d1 / l1;
  } else {
    vec2 t1 = d1 / l1;
    vec2 t2 = d2 / l2;
    vec2 tangent = t1 + t2;
    float tl = length(tangent);
    if (tl < 1e-3) {
      dir = t1;
    } else {
      dir = tangent / tl;
      // Wider at a bend so both segments keep their width; capped, so a hairpin doesn't spike.
      miter = 1.0 / max(dot(vec2(-dir.y, dir.x), vec2(-t1.y, t1.x)), 0.5);
    }
  }
  vec2 offset = vec2(-dir.y, dir.x) * side * halfWidth * miter * 2.0 / uResolution.y;
  offset.x /= aspect.x;
  c.xy += offset * c.w;
  gl_Position = c;

  vSide = side;
  vAlpha = alpha;
  vHalf = halfWidth;
  vCore = (0.5 * core) / halfWidth;
  vGlow = shape;
  vAge = age;
}
`;

const ribbonFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHeadColor;
uniform vec3 uPathColor;
uniform float uOpacity;
uniform float uGlow;
uniform float uClipAhead;

varying float vSide;
varying float vAlpha;
varying float vCore;
varying float vHalf;
varying float vGlow;
varying float vAge;

void main() {
  if (uClipAhead > 0.5 && vAge < 0.0) discard;
  float x = abs(vSide);
  float pixel = 1.0 / vHalf;
  float core = 1.0 - smoothstep(vCore - 0.5 * pixel, vCore + 0.5 * pixel, x);
  float glow = uGlow * vGlow * pow(max(1.0 - x, 0.0), 2.0);
  float alpha = max(core, glow) * vAlpha * uOpacity;
  if (alpha < 0.004) discard;
  // The rest of the path in its own tint, the tail in the trail's colour, hot toward the head.
  vec3 color = mix(uPathColor, uColor, smoothstep(0.0, 0.15, vGlow));
  gl_FragColor = vec4(mix(color, uHeadColor, 0.8 * core * pow(vGlow, 16.0)), alpha);
  #include <colorspace_fragment>
}
`;

const markerVertex = /* glsl */ `
uniform float uSize;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize;
}
`;

const markerFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCenter;
uniform float uSize;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  float pixel = 2.0 / uSize;
  float disc = 1.0 - smoothstep(1.0 - 1.5 * pixel, 1.0, r);
  if (disc <= 0.0) discard;
  float center = 1.0 - smoothstep(0.5 - pixel, 0.5, r);
  gl_FragColor = vec4(mix(uColor, uCenter, center), disc);
  #include <colorspace_fragment>
}
`;

function ribbonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ribbonVertex,
    fragmentShader: ribbonFragment,
    uniforms: {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 },
      uTail: { value: 60 },
      uContext: { value: 360 },
      uHeadWidth: { value: HEAD_WIDTH },
      uPathWidth: { value: PATH_WIDTH },
      uGlowWidth: { value: GLOW_WIDTH },
      uPastAlpha: { value: PAST_ALPHA },
      uFutureAlpha: { value: FUTURE_ALPHA },
      uFlatten: { value: 0 },
      uFloorY: { value: FLOOR_Y },
      uShadowFade: { value: 1 },
      uColor: { value: new THREE.Color() },
      uHeadColor: { value: new THREE.Color() },
      uPathColor: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uGlow: { value: 0.45 },
      uClipAhead: { value: 0 },
    },
    transparent: true,
    // The trail is seen through itself where it crosses, and never hides the grid or the shadow.
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

type LineMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

export class TipTrail {
  readonly group = new THREE.Group();
  private readonly ribbon: LineMesh;
  /** The trail where the robot hides it, drawn faint: the newest part is often inside the gripper. */
  private readonly hidden: LineMesh;
  private readonly shadow: LineMesh;
  private readonly marker: THREE.Points<
    THREE.BufferGeometry,
    THREE.ShaderMaterial
  >;
  /** One position per frame, in the floor's frame; null until the episode's path is known. */
  private samples: Float32Array | null = null;

  constructor(style: TrailStyle) {
    const geometry = new THREE.BufferGeometry();
    this.ribbon = new THREE.Mesh(geometry, ribbonMaterial());
    this.hidden = new THREE.Mesh(geometry, ribbonMaterial());
    // Only where something nearer is already drawn.
    this.hidden.material.depthFunc = THREE.GreaterDepth;
    this.hidden.material.uniforms.uOpacity.value = HIDDEN_OPACITY;
    this.shadow = new THREE.Mesh(geometry, ribbonMaterial());
    this.shadow.material.polygonOffset = true;
    this.shadow.material.polygonOffsetFactor = -1;
    this.shadow.material.polygonOffsetUnits = -4;
    const shadowUniforms = this.shadow.material.uniforms;
    shadowUniforms.uFlatten.value = 1;
    shadowUniforms.uPastAlpha.value = 0;
    shadowUniforms.uFutureAlpha.value = 0;
    shadowUniforms.uPathWidth.value = 0;
    shadowUniforms.uGlowWidth.value = 0;
    shadowUniforms.uGlow.value = 0;
    shadowUniforms.uClipAhead.value = 1;

    const markerGeometry = new THREE.BufferGeometry();
    markerGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(3), 3),
    );
    this.marker = new THREE.Points(
      markerGeometry,
      new THREE.ShaderMaterial({
        vertexShader: markerVertex,
        fragmentShader: markerFragment,
        uniforms: {
          uSize: { value: MARKER_SIZE },
          uColor: { value: new THREE.Color() },
          uCenter: { value: new THREE.Color() },
        },
        transparent: true,
        depthWrite: false,
        // The tool point sits inside the gripper: shown through it, like a gizmo.
        depthTest: false,
      }),
    );

    for (const object of [this.ribbon, this.hidden, this.shadow, this.marker]) {
      // The geometry spans the whole episode, wherever the camera looks.
      object.frustumCulled = false;
      object.visible = false;
      this.group.add(object);
    }
    // Over the floor's grid and shadows, which are transparent too.
    this.shadow.renderOrder = 1;
    this.hidden.renderOrder = 2;
    this.ribbon.renderOrder = 2;
    this.marker.renderOrder = 3;
    this.setStyle(style);
  }

  setStyle(style: TrailStyle): void {
    for (const line of [this.ribbon, this.hidden]) {
      const u = line.material.uniforms;
      u.uColor.value.copy(style.color);
      u.uHeadColor.value.copy(style.headColor);
      u.uPathColor.value.copy(style.pathColor);
    }
    const shadow = this.shadow.material.uniforms;
    shadow.uColor.value.copy(style.shadowColor);
    shadow.uHeadColor.value.copy(style.shadowColor);
    shadow.uPathColor.value.copy(style.shadowColor);
    shadow.uOpacity.value = style.shadowOpacity;
    const marker = this.marker.material.uniforms;
    marker.uColor.value.copy(style.color);
    marker.uCenter.value.copy(style.markerCenter);
  }

  /** The tool point's position at every frame of the episode (xyz each), in the floor's frame. */
  setSamples(samples: Float32Array | null): void {
    this.samples = samples;
    const geometry = this.ribbon.geometry;
    // Frees the GPU copies of the attributes about to be replaced; the geometry is uploaded
    // again, with the new ones, when next drawn.
    geometry.dispose();
    for (const name of Object.keys(geometry.attributes)) {
      geometry.deleteAttribute(name);
    }
    geometry.setIndex(null);
    if (!samples) return;
    const frames = Math.floor(samples.length / 3);
    const ribbon = ribbonArrays(smoothPath(samples, subdivisionsFor(frames)));
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(ribbon.position, 3),
    );
    geometry.setAttribute(
      "previous",
      new THREE.BufferAttribute(ribbon.previous, 3),
    );
    geometry.setAttribute("next", new THREE.BufferAttribute(ribbon.next, 3));
    geometry.setAttribute("side", new THREE.BufferAttribute(ribbon.side, 1));
    geometry.setAttribute("along", new THREE.BufferAttribute(ribbon.along, 1));
    geometry.setIndex(new THREE.BufferAttribute(ribbon.index, 1));
  }

  update({
    frame,
    tailFrames,
    contextFrames,
    shadowHeight,
    mode,
    width,
    height,
    pixelRatio,
  }: {
    frame: number;
    tailFrames: number;
    /** How far either side of the current frame the path shows in full, in frames. */
    contextFrames: number;
    /** Above this height the trail casts no shadow, in scene units. */
    shadowHeight: number;
    mode: TrailMode;
    /** The canvas, in CSS pixels. */
    width: number;
    height: number;
    pixelRatio: number;
  }): void {
    const samples = this.samples;
    const frames = samples ? Math.floor(samples.length / 3) : 0;
    const show = mode !== "off" && frames > 0;
    for (const object of [this.ribbon, this.hidden, this.shadow, this.marker])
      object.visible = show;
    if (!show || !samples) return;

    const current = Math.min(Math.max(0, frame), frames - 1);
    for (const mesh of [this.ribbon, this.hidden, this.shadow]) {
      const u = mesh.material.uniforms;
      u.uResolution.value.set(width * pixelRatio, height * pixelRatio);
      u.uFrame.value = current;
      u.uTail.value = Math.max(1, tailFrames);
      u.uContext.value = Math.max(1, contextFrames);
    }
    const whole = mode === "episode";
    for (const line of [this.ribbon, this.hidden]) {
      const u = line.material.uniforms;
      // Through the robot, only the recent tail: the rest of a long path would smear across it.
      const path = whole && line === this.ribbon;
      u.uPastAlpha.value = path ? PAST_ALPHA : 0;
      u.uFutureAlpha.value = path ? FUTURE_ALPHA : 0;
      u.uPathWidth.value = path ? PATH_WIDTH * pixelRatio : 0;
      u.uClipAhead.value = path ? 0 : 1;
      u.uHeadWidth.value = HEAD_WIDTH * pixelRatio;
      u.uGlowWidth.value = GLOW_WIDTH * pixelRatio;
    }
    const shadow = this.shadow.material.uniforms;
    shadow.uHeadWidth.value = SHADOW_WIDTH * pixelRatio;
    shadow.uShadowFade.value = Math.max(1e-3, shadowHeight);

    const x = samples[current * 3];
    const y = samples[current * 3 + 1];
    const z = samples[current * 3 + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      const position = this.marker.geometry.attributes
        .position as THREE.BufferAttribute;
      position.setXYZ(0, x, y, z);
      position.needsUpdate = true;
      this.marker.material.uniforms.uSize.value = MARKER_SIZE * pixelRatio;
    } else {
      this.marker.visible = false;
    }
  }

  /** Where the whole path is, in the floor's frame; empty until it is known. */
  bounds(target: THREE.Box3): THREE.Box3 {
    target.makeEmpty();
    const samples = this.samples;
    if (!samples) return target;
    const at = new THREE.Vector3();
    for (let i = 0; i + 2 < samples.length; i += 3) {
      if (!Number.isFinite(samples[i])) continue;
      target.expandByPoint(at.set(samples[i], samples[i + 1], samples[i + 2]));
    }
    return target;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ribbon.geometry.dispose();
    this.ribbon.material.dispose();
    this.hidden.material.dispose();
    this.shadow.material.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
  }
}

/**
 * Colours that read on the 3D Replay's background in each theme: LeRobot orange for a single arm
 * and the left one, blue for the right. Orange and blue stay apart under colour-vision deficiency.
 */
export function trailStyle(
  side: "left" | "right" | null,
  dark: boolean,
): TrailStyle {
  const color =
    side === "right"
      ? dark
        ? "#4ea4ff"
        : "#1f6fd1"
      : dark
        ? "#ff9d00"
        : "#e06c00";
  return {
    color: new THREE.Color(color),
    // Faint orange on a dark page reads as brown: lightened, it reads as a faint line of its colour.
    pathColor: dark
      ? new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.35)
      : new THREE.Color(color),
    // On a dark page the head runs hot, toward white with a hint of its own hue.
    headColor: new THREE.Color(
      dark ? (side === "right" ? "#e8f3ff" : "#fff3dc") : color,
    ),
    shadowColor: new THREE.Color(dark ? "#000000" : "#1f2937"),
    shadowOpacity: dark ? 0.45 : 0.16,
    markerCenter: new THREE.Color("#ffffff"),
  };
}

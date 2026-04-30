/**
 * v3.1 language schema (lerobot#3467 + lerobot#3471).
 *
 * Each row in `language_persistent` and `language_events` has the same shape:
 *
 *     { role, content, style, timestamp, tool_calls }
 *
 * Persistent styles (task_aug / subtask / plan / memory) live in
 * `language_persistent` and are broadcast across every frame in the episode. Event styles
 * (interjection / vqa) plus speech tool-call atoms (style=null) live in
 * `language_events` and only appear on the exact frames where they were
 * emitted.
 *
 * VQA assistant rows encode their answer as a JSON string in `content`, in one
 * of five shapes (bbox / keypoint / count / attribute / spatial), matching
 * `VQA_ANSWER_SHAPES` in lerobot's steerable-pipeline validator.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export type LanguageStyle =
  | "task_aug"
  | "subtask"
  | "plan"
  | "memory"
  | "interjection"
  | "vqa";

export interface ToolCallFn {
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolCall {
  type: "function";
  function: ToolCallFn;
}

export interface LanguageAtom {
  role: Role;
  content: string | null;
  // null is reserved for tool-call-only atoms (speech).
  style: LanguageStyle | null;
  timestamp: number;
  /**
   * `observation.images.*` feature key when this atom is grounded against a
   * specific camera view (`vqa`, `trace`). `null` for camera-agnostic atoms
   * (`task_aug`, `subtask`, `plan`, `memory`, `motion`, `interjection`, speech).
   * Mirrors lerobot's row-level `camera` field (PR 3467).
   */
  camera: string | null;
  tool_calls: ToolCall[] | null;
}

export const PERSISTENT_STYLES: ReadonlySet<LanguageStyle> = new Set([
  "task_aug",
  "subtask",
  "plan",
  "memory",
]);
export const EVENT_STYLES: ReadonlySet<LanguageStyle> = new Set([
  "interjection",
  "vqa",
]);

export function columnForStyle(
  style: LanguageStyle | null,
): "language_persistent" | "language_events" {
  if (style === null) return "language_events";
  if (PERSISTENT_STYLES.has(style)) return "language_persistent";
  if (EVENT_STYLES.has(style)) return "language_events";
  throw new Error(`Unknown style: ${String(style)}`);
}

export function isSpeechAtom(a: LanguageAtom): boolean {
  return (
    a.style === null &&
    a.role === "assistant" &&
    !!a.tool_calls &&
    a.tool_calls.length > 0 &&
    a.tool_calls[0]?.function?.name === "say"
  );
}

export function speechText(a: LanguageAtom): string | null {
  if (!isSpeechAtom(a)) return null;
  const args = a.tool_calls?.[0]?.function?.arguments as
    | { text?: unknown }
    | undefined;
  return typeof args?.text === "string" ? args.text : null;
}

export function buildSpeechAtom(timestamp: number, text: string): LanguageAtom {
  return {
    role: "assistant",
    content: null,
    style: null,
    timestamp,
    camera: null,
    tool_calls: [
      {
        type: "function",
        function: { name: "say", arguments: { text } },
      },
    ],
  };
}

/**
 * Whether ``atom`` should render on the camera identified by ``cameraKey``.
 *
 * - row-level ``atom.camera`` is the source of truth (lerobot PR 3467);
 *   ``null`` means camera-agnostic and renders everywhere;
 *   a non-null value matches only its own camera.
 * - For backwards compatibility with annotations that were created before the
 *   row-level field existed (visualizer-only payloads with an in-JSON
 *   ``camera`` key inside the VQA answer), the caller is responsible for the
 *   payload-level fallback — see ``video-overlay-canvas.tsx``.
 */
export function atomMatchesCamera(
  atom: LanguageAtom,
  cameraKey: string,
): boolean {
  return atom.camera == null || atom.camera === cameraKey;
}

// --- VQA answer shapes -------------------------------------------------------

export type VqaAnswer =
  | VqaBboxAnswer
  | VqaKeypointAnswer
  | VqaCountAnswer
  | VqaAttributeAnswer
  | VqaSpatialAnswer;

export interface VqaBboxAnswer {
  detections: Array<{
    label: string;
    bbox_format: "xyxy" | "xywh";
    bbox: [number, number, number, number];
    /**
     * Optional camera key for the visualizer (e.g. `observation.images.top`).
     * Not enforced by lerobot's writer but accepted as a passthrough JSON
     * field since the validator checks only required keys.
     */
    camera?: string;
  }>;
}

export interface VqaKeypointAnswer {
  label: string;
  point_format: "xy";
  point: [number, number];
  camera?: string;
}

export interface VqaCountAnswer {
  label: string;
  count: number;
  note?: string;
}

export interface VqaAttributeAnswer {
  label: string;
  attribute: string;
  value: string;
}

export interface VqaSpatialAnswer {
  subject: string;
  relation: string;
  object: string;
}

export type VqaKind = "bbox" | "keypoint" | "count" | "attribute" | "spatial";

export function classifyVqa(answer: unknown): VqaKind | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (Array.isArray(a.detections)) return "bbox";
  if (a.point_format && Array.isArray(a.point)) return "keypoint";
  if (typeof a.count === "number" && typeof a.label === "string")
    return "count";
  if (typeof a.attribute === "string" && a.value != null) return "attribute";
  if (typeof a.subject === "string" && typeof a.relation === "string")
    return "spatial";
  return null;
}

export function parseVqaAnswer(
  raw: string | null | undefined,
): VqaAnswer | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return classifyVqa(parsed) ? (parsed as VqaAnswer) : null;
  } catch {
    return null;
  }
}

// --- Atom helpers used by the editor UI --------------------------------------

export interface EpisodeAtoms {
  persistent: LanguageAtom[];
  events: LanguageAtom[];
}

/** Group all atoms for an episode by their target column. */
export function partitionAtoms(atoms: LanguageAtom[]): EpisodeAtoms {
  const persistent: LanguageAtom[] = [];
  const events: LanguageAtom[] = [];
  for (const a of atoms) {
    if (columnForStyle(a.style) === "language_persistent") persistent.push(a);
    else events.push(a);
  }
  persistent.sort((a, b) => a.timestamp - b.timestamp);
  events.sort((a, b) => a.timestamp - b.timestamp);
  return { persistent, events };
}

export function atomsByStyle(
  atoms: LanguageAtom[],
  style: LanguageStyle,
): LanguageAtom[] {
  return atoms.filter((a) => a.style === style);
}

export function activeAt(
  persistent: LanguageAtom[],
  style: LanguageStyle,
  t: number,
): LanguageAtom | null {
  let best: LanguageAtom | null = null;
  for (const a of persistent) {
    if (a.style !== style) continue;
    if (a.timestamp > t) break;
    best = a;
  }
  return best;
}

export function eventsAt(
  events: LanguageAtom[],
  t: number,
  windowSec = 1 / 60,
): LanguageAtom[] {
  return events.filter((a) => Math.abs(a.timestamp - t) <= windowSec);
}

/**
 * Snap a timestamp to the nearest source-frame timestamp. Linear scan; episodes
 * are typically a few thousand frames so this is fine without a tree.
 */
export function snapToFrame(frameTimestamps: number[], ts: number): number {
  if (!frameTimestamps.length) return ts;
  let best = frameTimestamps[0];
  let dist = Math.abs(ts - best);
  for (let i = 1; i < frameTimestamps.length; i++) {
    const d = Math.abs(ts - frameTimestamps[i]);
    if (d < dist) {
      dist = d;
      best = frameTimestamps[i];
    }
  }
  return best;
}

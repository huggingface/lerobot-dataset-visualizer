/**
 * Reward-model scores stored beside a dataset by `lerobot-score` (lerobot#4554): one Parquet file per
 * named set of scores, `scores/<name>.parquet` at the repo root, joined to the dataset on
 * (`episode_index`, `frame_index`). One row group per episode, episodes ascending; a frame without a
 * row was not scored, and NaN marks a frame the scorer could not score.
 *
 * Everything here is pure, or reads through a buffer it is given, so it is tested on real files.
 */

import type { AsyncBuffer, FileMetaData, SchemaElement } from "hyparquet";
import {
  readParquetColumnChunks,
  type ParquetColumnChunk,
} from "./parquetUtils";
import { bigIntToNumber, isNonEmptyString, isObject } from "./typeGuards";

const SCORES_DIR = "scores";
const SCORES_FORMAT = "lerobot.scores";
const SCORES_SCHEMA_VERSION = "1";
const RESERVED_COLUMNS = new Set(["index", "episode_index", "frame_index"]);

const FORMAT_KEY = "lerobot.scores.format";
const SCHEMA_VERSION_KEY = "lerobot.scores.schema_version";
const DATASET_KEY = "lerobot.scores.dataset";
const INFO_KEY = "lerobot.scores.info";

/** How a signal is read: its descriptor in the file's `info`. */
export type SignalDescriptor = {
  description: string | null;
  /** null: neither, e.g. a subtask index. */
  greaterIsBetter: boolean | null;
  bounds: [number, number] | null;
  unit: string | null;
  allowNan: boolean;
  /** Set for a categorical signal: each value is an index into these names. */
  labels: string[] | null;
};

export type ScoreSignal = { name: string; descriptor: SignalDescriptor };

export type ScoreProvenance = {
  modelType: string | null;
  modelId: string | null;
  modelRevision: string | null;
  scorerVersion: string | null;
  /** Files converted from an older format name what they came from instead of scorer options. */
  convertedFrom: string | null;
  /** The camera the model looked at (`scorer.options.image_key`), when the file says. */
  imageKey: string | null;
};

/** The dataset the scores were computed on. */
export type ScoreDatasetIdentity = {
  repoId: string | null;
  revision: string | null;
  totalEpisodes: number | null;
  totalFrames: number | null;
  lerobotVersion: string | null;
};

export type ScoreFile = {
  name: string;
  dataset: ScoreDatasetIdentity;
  provenance: ScoreProvenance;
  signals: ScoreSignal[];
};

export class ScoreFileError extends Error {}

type KeyValue = { key: string; value?: string };

function str(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function num(value: unknown): number | null {
  const n = bigIntToNumber(value, NaN);
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function parseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

export function parseSignalDescriptor(raw: unknown): SignalDescriptor {
  const d = record(raw);
  const bounds = Array.isArray(d.bounds) ? d.bounds.map(num) : null;
  const labels = Array.isArray(d.labels) ? d.labels.map(String) : null;
  return {
    description: str(d.description),
    greaterIsBetter:
      typeof d.greater_is_better === "boolean" ? d.greater_is_better : null,
    bounds:
      bounds &&
      bounds.length === 2 &&
      bounds[0] !== null &&
      bounds[1] !== null &&
      bounds[0] < bounds[1]
        ? [bounds[0], bounds[1]]
        : null,
    unit: str(d.unit),
    allowNan: d.allow_nan === true,
    labels: labels && labels.length > 0 ? labels : null,
  };
}

function parseProvenance(raw: unknown): ScoreProvenance {
  const provenance = record(raw);
  const model = record(provenance.model);
  const scorer = record(provenance.scorer);
  const converted = scorer.converted_from;
  const options = record(scorer.options);
  return {
    modelType: str(model.type),
    modelId: str(model.id),
    modelRevision: str(model.revision),
    scorerVersion:
      typeof scorer.version === "number" || typeof scorer.version === "string"
        ? String(scorer.version)
        : null,
    convertedFrom:
      converted === undefined || converted === null
        ? null
        : typeof converted === "string"
          ? converted
          : JSON.stringify(converted),
    imageKey: str(options.image_key),
  };
}

function parseDatasetIdentity(raw: Record<string, unknown>) {
  return {
    repoId: str(raw.repo_id),
    revision: str(raw.revision),
    totalEpisodes: num(raw.total_episodes),
    totalFrames: num(raw.total_frames),
    lerobotVersion: str(raw.lerobot_version),
  };
}

/** The top-level column names of a flat (or nested) schema, in order. */
function topLevelColumns(schema: SchemaElement[]): string[] {
  const names: string[] = [];
  const skip = (i: number): number => {
    const children = schema[i]?.num_children ?? 0;
    let next = i + 1;
    for (let c = 0; c < children; c++) next = skip(next);
    return next;
  };
  let i = 1;
  for (
    let c = 0;
    c < (schema[0]?.num_children ?? 0) && i < schema.length;
    c++
  ) {
    names.push(schema[i].name);
    i = skip(i);
  }
  return names;
}

/**
 * Reads what a score file says about itself from its footer. Throws `ScoreFileError` for a file that
 * is not a score file or has another schema version. The rest is read defensively: a file converted
 * from an older format, or written by a newer scorer, still opens.
 *
 * Signals are the file's columns other than the reserved three, in descriptor order; a column the
 * `info` does not describe is kept with an empty descriptor, and a descriptor without a column is
 * dropped.
 */
export function parseScoreFile(
  name: string,
  metadata: FileMetaData,
): ScoreFile {
  const kv = new Map(
    ((metadata.key_value_metadata ?? []) as KeyValue[]).map((entry) => [
      entry.key,
      entry.value,
    ]),
  );
  if (kv.get(FORMAT_KEY) !== SCORES_FORMAT) {
    throw new ScoreFileError(`${name} is not a LeRobot score file`);
  }
  const version = kv.get(SCHEMA_VERSION_KEY);
  if (version !== SCORES_SCHEMA_VERSION) {
    throw new ScoreFileError(
      `${name} has score schema version ${version ?? "(none)"}; this viewer reads version ${SCORES_SCHEMA_VERSION}`,
    );
  }
  const info = parseJson(kv.get(INFO_KEY));
  const described = record(info.signals);
  const columns = topLevelColumns(metadata.schema).filter(
    (column) => !RESERVED_COLUMNS.has(column),
  );
  const present = new Set(columns);
  const order = [
    ...Object.keys(described).filter((signal) => present.has(signal)),
    ...columns.filter((column) => !(column in described)),
  ];
  return {
    name,
    dataset: parseDatasetIdentity(parseJson(kv.get(DATASET_KEY))),
    provenance: parseProvenance(info.provenance),
    signals: order.map((signal) => ({
      name: signal,
      descriptor: parseSignalDescriptor(described[signal]),
    })),
  };
}

/** What the overlay calls the scores: the model's name without its org, else its type, else the file. */
export function scoreModelName(file: ScoreFile): string {
  const { modelId, modelType } = file.provenance;
  if (modelId) return modelId.split("/").pop() || modelId;
  return modelType ?? file.name;
}

/** `reward.rynnvalue.remaining_time_s` in seconds reads "remaining time". */
export function signalLabel(signal: ScoreSignal): string {
  let label = signal.name.split(".").pop() ?? signal.name;
  const { unit } = signal.descriptor;
  if (unit && label.endsWith(`_${unit}`)) {
    label = label.slice(0, -(unit.length + 1));
  }
  return label.replace(/_/g, " ");
}

export function isCategorical(signal: ScoreSignal): boolean {
  return signal.descriptor.labels !== null;
}

/**
 * Why the scores may not describe this dataset, or null when they match. A file scored on more
 * episodes or frames than the dataset has was scored on another version of it; lerobot refuses it.
 * Another repo id is only worth a note: a duplicated dataset keeps its scores.
 */
export function scoreFileMismatch(
  file: ScoreFile,
  dataset: { repoId: string; totalEpisodes: number; totalFrames: number },
): { severity: "error" | "warning"; message: string } | null {
  const { totalEpisodes, totalFrames, repoId } = file.dataset;
  if (
    (totalEpisodes !== null && totalEpisodes > dataset.totalEpisodes) ||
    (totalFrames !== null && totalFrames > dataset.totalFrames)
  ) {
    return {
      severity: "error",
      message: "Scored on another version of this dataset; score it again",
    };
  }
  if (repoId && repoId.toLowerCase() !== dataset.repoId.toLowerCase()) {
    return { severity: "warning", message: `Scored on ${repoId}` };
  }
  return null;
}

/**
 * The rows of `episodeIndex`, from the row groups' `episode_index` statistics: a score file holds one
 * row group per episode, so this reads nothing but the footer. null when no row group holds it;
 * undefined when a row group has no statistics, and the column has to be read to find out.
 */
export function episodeRowRange(
  metadata: FileMetaData,
  episodeIndex: number,
): { rowStart: number; rowEnd: number } | null | undefined {
  let rowStart = -1;
  let rowEnd = -1;
  let groupStart = 0;
  for (const group of metadata.row_groups) {
    const groupEnd = groupStart + Number(group.num_rows);
    const column = group.columns.find(
      (c) => c.meta_data?.path_in_schema[0] === "episode_index",
    );
    const stats = column?.meta_data?.statistics;
    const min = num(stats?.min_value ?? stats?.min);
    const max = num(stats?.max_value ?? stats?.max);
    if (min === null || max === null) return undefined;
    if (min <= episodeIndex && episodeIndex <= max) {
      if (rowStart < 0) rowStart = groupStart;
      rowEnd = groupEnd;
    }
    groupStart = groupEnd;
  }
  return rowStart < 0 ? null : { rowStart, rowEnd };
}

/** A cell as a number: integers come out of parquet as BigInt, and a signal may be boolean. */
function toNumber(value: unknown): number {
  return typeof value === "boolean"
    ? Number(value)
    : bigIntToNumber(value, NaN);
}

/**
 * Each signal over the episode's frames: a frame without a row (not scored) is NaN, like a frame
 * the scorer could not score. Rows of another episode, or past the episode's end, are ignored.
 * `numFrames` 0 sizes the series to the last scored frame.
 */
export function buildEpisodeSeries(
  episodeIndex: number,
  numFrames: number,
  columns: Record<string, ArrayLike<unknown>>,
  signals: string[],
): EpisodeScores {
  const episodes = columns.episode_index ?? [];
  const frames = columns.frame_index ?? [];
  const rows: number[] = [];
  let last = -1;
  for (let r = 0; r < frames.length; r++) {
    if (toNumber(episodes[r]) !== episodeIndex) continue;
    const frame = toNumber(frames[r]);
    if (!Number.isInteger(frame) || frame < 0) continue;
    if (numFrames > 0 && frame >= numFrames) continue;
    rows.push(r);
    last = Math.max(last, frame);
  }
  const length = numFrames > 0 ? numFrames : last + 1;
  const series: Record<string, Float32Array> = {};
  for (const signal of signals) {
    const values = new Float32Array(length).fill(NaN);
    const column = columns[signal] ?? [];
    for (const r of rows) values[toNumber(frames[r])] = toNumber(column[r]);
    series[signal] = values;
  }
  return { series, scoredRows: rows.length };
}

export type EpisodeScores = {
  /** One value per frame of the episode, NaN where it has no score. */
  series: Record<string, Float32Array>;
  /** Rows the file has for the episode: 0 when it was not scored. */
  scoredRows: number;
};

/**
 * Gathers column chunks into one array per column over rows [rowStart, rowEnd). A chunk is a page or
 * a row group, so it can reach outside the rows asked for: those values are dropped.
 */
export function collectColumns(
  rowStart: number,
  rowEnd: number,
): {
  add: (chunk: ParquetColumnChunk) => void;
  columns: Record<string, unknown[]>;
} {
  const columns: Record<string, unknown[]> = {};
  const add = (chunk: ParquetColumnChunk) => {
    const out = (columns[chunk.columnName] ??= new Array(rowEnd - rowStart));
    for (let i = 0; i < chunk.columnData.length; i++) {
      const row = chunk.rowStart + i;
      if (row >= rowStart && row < rowEnd)
        out[row - rowStart] = chunk.columnData[i];
    }
  };
  return { add, columns };
}

/**
 * The rows of a file's `episode_index` column that hold `episodeIndex`, or null when none do. A
 * score file stores an episode's rows together.
 */
export function episodeRowsIn(
  episodes: ArrayLike<unknown>,
  episodeIndex: number,
): { rowStart: number; rowEnd: number } | null {
  let rowStart = -1;
  let rowEnd = -1;
  for (let row = 0; row < episodes.length; row++) {
    if (toNumber(episodes[row]) !== episodeIndex) continue;
    if (rowStart < 0) rowStart = row;
    rowEnd = row + 1;
  }
  return rowStart < 0 ? null : { rowStart, rowEnd };
}

/**
 * Reads one episode's scores, and only its row group: the footer's statistics say which one, so a
 * file of thousands of episodes costs this episode. Without statistics, `episode_index` is read
 * first to find its rows.
 */
export async function readEpisodeScores(
  buffer: AsyncBuffer | ArrayBuffer,
  metadata: FileMetaData,
  file: ScoreFile,
  episodeIndex: number,
  numFrames: number,
): Promise<EpisodeScores> {
  let range = episodeRowRange(metadata, episodeIndex);
  if (range === undefined) {
    const all = collectColumns(0, Number(metadata.num_rows));
    await readParquetColumnChunks(buffer, ["episode_index"], all.add, {
      metadata,
    });
    range = episodeRowsIn(all.columns.episode_index ?? [], episodeIndex);
  }
  const signals = file.signals.map((s) => s.name);
  if (!range) return buildEpisodeSeries(episodeIndex, numFrames, {}, signals);
  const { rowStart, rowEnd } = range;
  const rows = collectColumns(rowStart, rowEnd);
  await readParquetColumnChunks(
    buffer,
    ["episode_index", "frame_index", ...signals],
    rows.add,
    { rowStart, rowEnd, metadata },
  );
  return buildEpisodeSeries(episodeIndex, numFrames, rows.columns, signals);
}

/** Which plot a curve goes on: signals share one when they share bounds, else when they share a unit. */
export function axisKey(descriptor: SignalDescriptor): string {
  return descriptor.bounds
    ? `bounds:${descriptor.bounds[0]}:${descriptor.bounds[1]}`
    : `unit:${descriptor.unit ?? ""}`;
}

/**
 * The y-axis of curves that share a plot: their bounds when they all have the same, otherwise zero
 * (or the lowest value, if below) to the episode's highest value rounded up to a readable number.
 * As `create_progress_videos.py` draws them.
 */
export function axisRange(
  curves: { descriptor: SignalDescriptor; values: ArrayLike<number> }[],
): [number, number] {
  const bounds = new Set(
    curves.map((c) =>
      c.descriptor.bounds ? c.descriptor.bounds.join(":") : null,
    ),
  );
  const first = curves[0]?.descriptor.bounds;
  if (bounds.size === 1 && first) return [first[0], first[1]];
  let min = Infinity;
  let max = -Infinity;
  for (const { values } of curves) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return [0, 1];
  const low = Math.min(0, min);
  const high = max;
  if (high <= low) return [low, low + 1];
  const magnitude = 10 ** Math.floor(Math.log10(high - low));
  const step =
    [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
      (m) => low + m * magnitude >= high - 1e-9 * magnitude,
    ) ?? 10;
  return [low, low + step * magnitude];
}

/** A value as the overlay shows it: with its unit, its label name, or a dash for no score. */
export function formatScore(
  value: number,
  descriptor: SignalDescriptor,
): string {
  if (!Number.isFinite(value)) return "–";
  if (descriptor.labels) {
    const label = descriptor.labels[Math.round(value)];
    return label ?? "–";
  }
  return descriptor.unit
    ? `${value.toFixed(1)} ${descriptor.unit}`
    : value.toFixed(2);
}

/** A categorical signal as spans of frames [start, end) with one label; frames with none are gaps. */
export function categoricalRuns(
  values: ArrayLike<number>,
  labelCount: number,
): { start: number; end: number; label: number }[] {
  const runs: { start: number; end: number; label: number }[] = [];
  for (let frame = 0; frame < values.length; frame++) {
    const v = values[frame];
    const label = Number.isFinite(v) ? Math.round(v) : -1;
    if (label < 0 || label >= labelCount) continue;
    const prev = runs[runs.length - 1];
    if (prev && prev.end === frame && prev.label === label)
      prev.end = frame + 1;
    else runs.push({ start: frame, end: frame + 1, label });
  }
  return runs;
}

/**
 * An SVG path through `values`, broken where a frame has no score. `x` and `y` map a frame and a
 * value to the drawing's coordinates.
 */
export function seriesPath(
  values: ArrayLike<number>,
  x: (frame: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let pen = false;
  for (let frame = 0; frame < values.length; frame++) {
    const v = values[frame];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    parts.push(`${pen ? "L" : "M"}${x(frame).toFixed(2)} ${y(v).toFixed(2)}`);
    pen = true;
  }
  return parts.join("");
}

/**
 * The score names in a Hub tree listing of `scores/`: its `.parquet` files. Staging entries (the
 * `.<name>.parquet.parts/` folder, `*.tmp` files) are not scores yet.
 */
export function scoreFileNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const names: string[] = [];
  for (const entry of entries) {
    const { type, path } = record(entry);
    if (type !== "file" || typeof path !== "string") continue;
    const match = /^scores\/([^/]+)\.parquet$/.exec(path);
    if (!match || match[1].startsWith(".")) continue;
    names.push(match[1]);
  }
  return names.sort();
}

/**
 * The names of the scores in the dataset repo at `revision`, from the Hub's tree API. A repo without
 * a `scores/` folder has none: the API answers 404.
 */
export async function listScoreFiles(
  hubEndpoint: string,
  repoId: string,
  revision: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = `${hubEndpoint}/api/datasets/${repoId}/tree/${encodeURIComponent(revision)}/${SCORES_DIR}`;
  const response = await fetchImpl(url, { headers, cache: "no-store" });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Listing ${SCORES_DIR}/ failed: ${response.status}`);
  }
  return scoreFileNames(await response.json());
}

export function scoreFileUrl(
  datasetsUrl: string,
  repoId: string,
  revision: string,
  name: string,
): string {
  return `${datasetsUrl}/${repoId}/resolve/${encodeURIComponent(revision)}/${SCORES_DIR}/${encodeURIComponent(name)}.parquet`;
}

/** How a chosen signal is remembered: its file and its column. */
export function signalKey(fileName: string, signal: string): string {
  return `${fileName}\n${signal}`;
}

/** Curves shown at once by default: the overlay's four colours, then the same four dashed. */
export const DEFAULT_MAX_CURVES = 8;

/**
 * What is shown before anything is chosen: every categorical signal, and the curves in file order up
 * to `DEFAULT_MAX_CURVES`.
 */
export function defaultScoreSelection(files: ScoreFile[]): Set<string> {
  const selected = new Set<string>();
  let curves = 0;
  for (const file of files) {
    for (const signal of file.signals) {
      if (isCategorical(signal)) {
        selected.add(signalKey(file.name, signal.name));
      } else if (curves < DEFAULT_MAX_CURVES) {
        selected.add(signalKey(file.name, signal.name));
        curves++;
      }
    }
  }
  return selected;
}

/** A stored selection, or null when there is none (or it is not one). */
export function parseScoreSelection(raw: string | null): Set<string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((k): k is string => typeof k === "string"))
      : null;
  } catch {
    return null;
  }
}

/**
 * The camera a file's scores are drawn on. A reward model reads one camera's frames
 * (`scorer.options.image_key`), and its scores describe that view only. A file that does not say,
 * or names a camera the dataset has no video for, goes on the first camera, with `note` saying so.
 */
export function scoreCamera(
  file: ScoreFile,
  cameras: readonly string[],
): { camera: string | null; known: boolean; note: string | null } {
  const { imageKey } = file.provenance;
  if (imageKey && cameras.includes(imageKey)) {
    return { camera: imageKey, known: true, note: null };
  }
  return {
    camera: cameras[0] ?? null,
    known: false,
    note: imageKey
      ? `Scored on ${imageKey}, which this dataset has no video for`
      : "The file does not say which camera was scored",
  };
}

"use client";

/**
 * Reward-model scores for the episode on screen, in the Annotations tab: which score files the
 * dataset has, which signals are chosen (remembered per dataset), each chosen signal's values over
 * the episode and the camera it belongs to, and whether the overlay is on. `ScoreControls`, the
 * cameras' "Scored" chips and `ScoreOverlay` all read this one context.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  datasetCacheKey,
  episodeScoresCache,
  episodeScoresKey,
  loadEpisodeScores,
  loadScoreFiles,
  scoreFilesCache,
  type ReadableScoreFile,
  type ScoreFileEntry,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useCachedResource } from "@/utils/useCachedResource";
import {
  defaultScoreSelection,
  isCategorical,
  parseScoreSelection,
  scoreCamera,
  scoreModelName,
  signalKey,
  signalLabel,
  type EpisodeScores,
  type ScoreSignal,
} from "@/utils/scores";
import { BRAND, scoreColor, subtaskColors } from "@/utils/scoreStyle";
import { useAnnotations } from "@/context/annotations-context";

/** A chosen signal with its values over the episode. */
export type ScoreTrack = {
  key: string;
  /** The model that scored it, as the overlay names it. */
  model: string;
  signal: ScoreSignal;
  /** The signal's short name, e.g. "progress". */
  label: string;
  /** One value per frame, NaN where there is no score. */
  values: Float32Array;
  /** The camera whose frames the model read, and so the one it is drawn on (see `scoreCamera`). */
  camera: string | null;
};

/** A chosen numeric signal, drawn as a curve in the progress videos' colours. */
export type CurveTrack = ScoreTrack & {
  color: string;
  /** In the overlay's layout units. */
  dash: number[] | undefined;
};

/** A model drawn on a camera; `note` says why when the file did not name that camera. */
export type ScoredCameraModel = { model: string; note: string | null };

/**
 * An annotated subtask (a `subtask` language atom), in seconds, from its start to the next one;
 * the last one's `end` is `Infinity`: it lasts to the episode's end.
 */
export type AnnotatedSubtask = { name: string; start: number; end: number };

type ScoresContextValue = {
  /** The dataset's score files; empty while listing, and for a dataset with none. */
  files: ScoreFileEntry[];
  /** The Hub could not list `scores/` (as opposed to there being none). */
  listingFailed: boolean;
  selected: ReadonlySet<string>;
  setSignalSelected: (key: string, on: boolean) => void;
  /** Whether the scored cameras carry the progress-video overlay. */
  showOverlay: boolean;
  setShowOverlay: (on: boolean) => void;
  /** The episode's cameras, in the order they are shown. */
  cameras: readonly string[];
  /** The cameras the chosen scores are drawn on, each with the models that scored it. */
  scoredCameras: ReadonlyMap<string, ScoredCameraModel[]>;
  /** Chosen numeric signals whose episode values have loaded, in file and signal order. */
  curves: CurveTrack[];
  /** Chosen categorical signals (e.g. SARM's predicted subtask). */
  stages: ScoreTrack[];
  /** Chosen files whose episode values are still loading. */
  episodeLoading: boolean;
  /** Files whose episode values failed to load, with the reason. */
  episodeErrors: { name: string; message: string }[];
  /** Models with chosen signals whose file has no rows for this episode. */
  episodeUnscored: string[];
  annotatedSubtasks: AnnotatedSubtask[];
  /** One colour per subtask name, annotated and predicted alike. */
  subtaskColor: (name: string) => string;
  fps: number;
  numFrames: number;
};

const ScoresContext = createContext<ScoresContextValue | null>(null);

/** The scores, or null outside a `ScoresProvider` (every tab but Annotations, tests). */
export function useScores(): ScoresContextValue | null {
  return useContext(ScoresContext);
}

const SELECTION_PREFIX = "lerobot-viz-scores:";
const OVERLAY_KEY = "lerobot-viz-score-overlay";

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

type EpisodeState = Record<string, EpisodeScores | { error: string }>;

/**
 * Mount inside the episode's `TimeProvider` and `AnnotationsProvider`. The viewer remounts on every
 * episode change; the listing and each episode's values come from caches that outlive it, and the
 * selection from localStorage, so a remount neither refetches nor flickers.
 */
export const ScoresProvider: React.FC<{
  repoId: string;
  episodeId: number;
  numFrames: number;
  fps: number;
  totalEpisodes: number;
  totalFrames: number;
  /** The episode's cameras, in the order they are shown. */
  cameras: string[];
  children: React.ReactNode;
}> = ({
  repoId,
  episodeId,
  numFrames,
  fps,
  totalEpisodes,
  totalFrames,
  cameras: cameraList,
  children,
}) => {
  // The viewer passes a fresh array each render; the names are what matter.
  const camerasKey = cameraList.join("\n");
  const cameras = useMemo(
    () => (camerasKey ? camerasKey.split("\n") : []),
    [camerasKey],
  );
  const listing = useCachedResource(
    scoreFilesCache,
    datasetCacheKey(repoId),
    true,
    () => loadScoreFiles(repoId, { totalEpisodes, totalFrames }),
  );
  const files = useMemo(() => listing.data ?? [], [listing.data]);
  const readable = useMemo(
    () =>
      files.filter((entry): entry is ReadableScoreFile => entry.file !== null),
    [files],
  );

  const selectionKey = `${SELECTION_PREFIX}${repoId}`;
  const [stored, setStored] = useState<Set<string> | null>(() =>
    parseScoreSelection(readStorage(selectionKey)),
  );
  const selected = useMemo(
    () => stored ?? defaultScoreSelection(readable.map((e) => e.file)),
    [stored, readable],
  );
  const setSignalSelected = useCallback(
    (key: string, on: boolean) => {
      const next = new Set(selected);
      if (on) next.add(key);
      else next.delete(key);
      setStored(next);
      writeStorage(selectionKey, JSON.stringify([...next]));
    },
    [selected, selectionKey],
  );

  const [showOverlay, setShowOverlayState] = useState(
    // On unless turned off: the overlay is how the scores are shown.
    () => readStorage(OVERLAY_KEY) !== "0",
  );
  const setShowOverlay = useCallback((on: boolean) => {
    setShowOverlayState(on);
    writeStorage(OVERLAY_KEY, on ? "1" : "0");
  }, []);

  // The files with a chosen signal: only those are read for this episode.
  const needed = useMemo(
    () =>
      readable.filter(({ file }) =>
        file.signals.some((s) => selected.has(signalKey(file.name, s.name))),
      ),
    [readable, selected],
  );
  // Seeded from the caches, so an episode seen before draws on the first render.
  const [episode, setEpisode] = useState<EpisodeState>(() => {
    const seeded: EpisodeState = {};
    for (const entry of scoreFilesCache.peek(datasetCacheKey(repoId))?.value ??
      []) {
      const hit = episodeScoresCache.peek(
        episodeScoresKey(repoId, entry.name, episodeId),
      );
      if (hit) seeded[entry.name] = hit.value;
    }
    return seeded;
  });
  useEffect(() => {
    let live = true;
    for (const entry of needed) {
      const key = episodeScoresKey(repoId, entry.name, episodeId);
      const hit = episodeScoresCache.peek(key);
      if (hit) {
        setEpisode((prev) =>
          prev[entry.name] === hit.value
            ? prev
            : { ...prev, [entry.name]: hit.value },
        );
        continue;
      }
      episodeScoresCache
        .get(key, () => loadEpisodeScores(repoId, entry, episodeId, numFrames))
        .then(
          (scores) => {
            if (live) setEpisode((prev) => ({ ...prev, [entry.name]: scores }));
          },
          (error: unknown) => {
            if (live)
              setEpisode((prev) => ({
                ...prev,
                [entry.name]: {
                  error: error instanceof Error ? error.message : String(error),
                },
              }));
          },
        );
    }
    return () => {
      live = false;
    };
  }, [needed, repoId, episodeId, numFrames]);

  // A curve keeps its colour while others are chosen or dropped: its place among all the curves.
  const colorIndex = useMemo(() => {
    const index = new Map<string, number>();
    for (const { file } of readable) {
      for (const signal of file.signals) {
        if (!isCategorical(signal)) {
          index.set(signalKey(file.name, signal.name), index.size);
        }
      }
    }
    return index;
  }, [readable]);

  const {
    curves,
    stages,
    scoredCameras,
    episodeLoading,
    episodeErrors,
    episodeUnscored,
  } = useMemo(() => {
    const curves: CurveTrack[] = [];
    const stages: ScoreTrack[] = [];
    const scoredCameras = new Map<string, ScoredCameraModel[]>();
    const episodeErrors: { name: string; message: string }[] = [];
    const episodeUnscored: string[] = [];
    let episodeLoading = false;
    for (const { file } of needed) {
      const scores = episode[file.name];
      if (!scores) {
        episodeLoading = true;
        continue;
      }
      if ("error" in scores) {
        episodeErrors.push({ name: file.name, message: scores.error });
        continue;
      }
      const model = scoreModelName(file);
      if (scores.scoredRows === 0) {
        episodeUnscored.push(model);
        continue;
      }
      const { camera, note } = scoreCamera(file, cameras);
      if (camera) {
        scoredCameras.set(camera, [
          ...(scoredCameras.get(camera) ?? []),
          { model, note },
        ]);
      }
      for (const signal of file.signals) {
        const key = signalKey(file.name, signal.name);
        const values = scores.series[signal.name];
        if (!selected.has(key) || !values) continue;
        const track = {
          key,
          model,
          signal,
          label: signalLabel(signal),
          values,
          camera,
        };
        if (isCategorical(signal)) stages.push(track);
        else
          curves.push({
            ...track,
            ...scoreColor(colorIndex.get(key) ?? curves.length),
          });
      }
    }
    return {
      curves,
      stages,
      scoredCameras,
      episodeLoading,
      episodeErrors,
      episodeUnscored,
    };
  }, [needed, episode, selected, colorIndex, cameras]);

  // Annotated subtasks: a subtask lasts from its atom to the next one, or the episode's end.
  const { atoms } = useAnnotations();
  const annotatedSubtasks = useMemo(() => {
    const starts = atoms
      .filter((atom) => atom.style === "subtask")
      .sort((a, b) => a.timestamp - b.timestamp);
    return starts.map((atom, i) => ({
      name: atom.content || "subtask",
      start: atom.timestamp,
      end: i + 1 < starts.length ? starts[i + 1].timestamp : Infinity,
    }));
  }, [atoms]);
  const subtaskColor = useMemo(() => {
    const colors = subtaskColors([
      ...annotatedSubtasks.map((s) => s.name),
      ...stages.flatMap((s) => s.signal.descriptor.labels ?? []),
    ]);
    return (name: string) => colors.get(name) ?? BRAND.muted;
  }, [annotatedSubtasks, stages]);

  const value = useMemo(
    () => ({
      files,
      listingFailed: listing.failed,
      selected,
      setSignalSelected,
      showOverlay,
      setShowOverlay,
      cameras,
      scoredCameras,
      curves,
      stages,
      episodeLoading,
      episodeErrors,
      episodeUnscored,
      annotatedSubtasks,
      subtaskColor,
      fps,
      numFrames,
    }),
    [
      files,
      listing.failed,
      selected,
      setSignalSelected,
      showOverlay,
      setShowOverlay,
      cameras,
      scoredCameras,
      curves,
      stages,
      episodeLoading,
      episodeErrors,
      episodeUnscored,
      annotatedSubtasks,
      subtaskColor,
      fps,
      numFrames,
    ],
  );

  return (
    <ScoresContext.Provider value={value}>{children}</ScoresContext.Provider>
  );
};

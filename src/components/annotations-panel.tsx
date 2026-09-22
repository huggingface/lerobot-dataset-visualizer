"use client";

import "./annotations-skin.css";

/**
 * Editor UI for v3.1 language atoms.
 *
 * Three vertical sections:
 *   1. Inline quick-add bar above the timeline (style picker + label + Add).
 *   2. Annotations timeline (in `annotations-timeline.tsx`).
 *   3. Workspace below the timeline:
 *        - Left rail: full atom list grouped by style; click to select.
 *        - Right pane: editor for the selected atom (or empty state).
 *
 * Bbox / keypoint VQA atoms are still added through the canvas overlay's
 * quick-label popup; the inline quick-add covers subtask / plan / memory /
 * interjection / speech / count / attribute / spatial.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useTime } from "../context/time-context";
import { useAnnotations } from "../context/annotations-context";
import {
  buildSpeechAtom,
  classifyVqa,
  isSpeechAtom,
  parseVqaAnswer,
  speechText,
  type LanguageAtom,
} from "../types/language.types";
import {
  exportDataset as apiExport,
  fetchHealth,
  isAnnotateBackendEnabled,
  pushToHub,
  type BackendHealth,
} from "../utils/annotationsClient";
import {
  DEFAULT_HUB_PUSH_SETTINGS,
  readPersistedHubSettings,
  sanitizeHfToken,
  writePersistedHubSettings,
} from "../utils/hubPushSettings";

interface Props {
  cameraKeys: string[];
}

function cleanToken(token: string): string {
  return sanitizeHfToken(token);
}

function fmtTime(s: number): string {
  return s.toFixed(3) + "s";
}

function StylePill({ style }: { style: string | null }) {
  const cls = style ?? "speech";
  return <span className={`style-pill ${cls}`}>{style ?? "speech"}</span>;
}

/**
 * Highlight a row when its timestamp is within ~half a frame of currentTime.
 */
function isActiveAt(ts: number, currentTime: number, fps = 30): boolean {
  return Math.abs(ts - currentTime) < 0.5 / fps;
}

type QuickAddKind =
  | "task_aug"
  | "subtask"
  | "plan"
  | "memory"
  | "interjection"
  | "speech"
  | "count"
  | "attribute"
  | "spatial";

interface QuickAddField {
  name: string;
  placeholder: string;
  type?: "text" | "number";
  width?: string;
  grow?: boolean;
}

interface QuickAddBuildCtx {
  ts: number;
  vqaCamera: string | null;
}

interface QuickAddDef {
  kind: QuickAddKind;
  label: string;
  /** When true, the displayed timestamp is 0 (atom is pinned to episode start). */
  atEpisodeStart?: boolean;
  fields: QuickAddField[];
  build: (
    values: Record<string, string>,
    ctx: QuickAddBuildCtx,
  ) => LanguageAtom[] | null;
}

// Each text-style atom kind (and the simpler VQA shapes) is one entry: how
// it appears in the dropdown, what fields the user fills, and how those
// values map to one or two language atoms.
const QUICK_ADD_DEFS: QuickAddDef[] = [
  {
    kind: "task_aug",
    label: "task augmentation",
    atEpisodeStart: true,
    fields: [
      {
        name: "label",
        placeholder: "pick up the blue cube and place it in the green box",
        grow: true,
      },
    ],
    build: ({ label }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "user",
          content: text,
          style: "task_aug",
          timestamp: 0,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "subtask",
    label: "subtask",
    fields: [
      {
        name: "label",
        placeholder: "grasp the handle of the sponge",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "subtask",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "plan",
    label: "plan",
    fields: [
      {
        name: "label",
        placeholder: "1. grab sponge / 2. wipe / 3. tidy",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "plan",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "memory",
    label: "memory",
    fields: [
      {
        name: "label",
        placeholder: "sponge picked up; counter still dirty",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "memory",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "interjection",
    label: "interjection (user)",
    fields: [
      {
        name: "label",
        placeholder: "user: actually skip the wipe…",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "user",
          content: text,
          style: "interjection",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "speech",
    label: "speech (robot say)",
    fields: [
      {
        name: "label",
        placeholder: "robot say: Got it, skipping the wipe.",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [buildSpeechAtom(ts, text)];
    },
  },
  {
    kind: "count",
    label: "vqa: count",
    fields: [
      { name: "label", placeholder: "object label (e.g. cup)", grow: true },
      { name: "count", placeholder: "count", type: "number", width: "80px" },
    ],
    build: ({ label, count }, { ts, vqaCamera }) => {
      const text = label.trim();
      if (!text || !count) return null;
      return [
        {
          role: "user",
          content: `How many ${text}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ label: text, count: Number(count) }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "attribute",
    label: "vqa: attribute",
    fields: [
      { name: "label", placeholder: "label", width: "120px" },
      { name: "attribute", placeholder: "attribute (color)", width: "120px" },
      { name: "value", placeholder: "value (red)", grow: true },
    ],
    build: ({ label, attribute, value }, { ts, vqaCamera }) => {
      const text = label.trim();
      if (!text || !attribute || !value) return null;
      return [
        {
          role: "user",
          content: `What ${attribute} is the ${text}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ label: text, attribute, value }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "spatial",
    label: "vqa: spatial relation",
    fields: [
      { name: "subject", placeholder: "subject", width: "100px" },
      { name: "relation", placeholder: "relation (right_of)", width: "130px" },
      { name: "object", placeholder: "object", grow: true },
    ],
    build: ({ subject, relation, object }, { ts, vqaCamera }) => {
      if (!subject || !relation || !object) return null;
      return [
        {
          role: "user",
          content: `Where is the ${subject} relative to the ${object}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ subject, relation, object }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
];

const QUICK_ADD_DEFS_BY_KIND: Record<QuickAddKind, QuickAddDef> =
  QUICK_ADD_DEFS.reduce(
    (acc, def) => {
      acc[def.kind] = def;
      return acc;
    },
    {} as Record<QuickAddKind, QuickAddDef>,
  );

interface RailGroupDef {
  key: string;
  title: string;
  dotClass: string;
  // Which v3.1 language column this style is written to. Used to group the
  // rail under "Persistent" vs "Events" headers so it's clear at a glance
  // that task_aug / subtask / plan / memory broadcast across the whole
  // episode (language_persistent) while interjection / speech / vqa fire on
  // a single frame (language_events). Mirrors columnForStyle() exactly.
  column: "persistent" | "events";
  match: (
    atom: LanguageAtom,
    otherCamera: (a: LanguageAtom) => boolean,
  ) => boolean;
  label: (
    atom: LanguageAtom,
    helpers: {
      activeCamera: string | null;
      firstLine: (s: string | null) => string;
    },
  ) => string;
}

const RAIL_GROUPS: RailGroupDef[] = [
  {
    key: "task_aug",
    title: "task aug",
    dotClass: "dot-task-aug",
    column: "persistent",
    match: (a) => a.style === "task_aug",
    label: (a) => a.content || "(empty)",
  },
  {
    key: "subtask",
    title: "subtask",
    dotClass: "dot-subtask",
    column: "persistent",
    match: (a) => a.style === "subtask",
    label: (a) => a.content || "(empty)",
  },
  {
    key: "plan",
    title: "plan",
    dotClass: "dot-plan",
    column: "persistent",
    match: (a) => a.style === "plan",
    label: (a, { firstLine }) => firstLine(a.content),
  },
  {
    key: "memory",
    title: "memory",
    dotClass: "dot-memory",
    column: "persistent",
    match: (a) => a.style === "memory",
    label: (a, { firstLine }) => firstLine(a.content),
  },
  {
    key: "interjection",
    title: "interjection",
    dotClass: "dot-interjection",
    column: "events",
    match: (a) => a.style === "interjection",
    label: (a) => a.content || "(empty)",
  },
  {
    key: "speech",
    title: "speech",
    dotClass: "dot-speech",
    column: "events",
    match: (a) => isSpeechAtom(a),
    label: (a) => speechText(a) || "(empty)",
  },
  {
    key: "vqa",
    title: "vqa",
    dotClass: "dot-vqa",
    column: "events",
    match: (a, otherCamera) => a.style === "vqa" && !otherCamera(a),
    label: (a, { activeCamera }) => {
      const role = a.role === "user" ? "Q" : "A";
      const t = a.content || "";
      const cameraSuffix =
        a.camera && a.camera !== activeCamera ? `  [${a.camera}]` : "";
      return `${role}: ${t.slice(0, 60)}${t.length > 60 ? "…" : ""}${cameraSuffix}`;
    },
  },
];

function useJump(): (ts: number) => void {
  const { seek, setIsPlaying } = useTime();
  return React.useCallback(
    (ts: number) => {
      seek(ts, "external");
      setIsPlaying(false);
    },
    [seek, setIsPlaying],
  );
}

export const AnnotationsPanel: React.FC<Props> = ({ cameraKeys }) => {
  const {
    atoms,
    addAtoms,
    updateAtom,
    deleteAtom,
    snap,
    save,
    saving,
    dirty,
    backendEnabled,
    activeCamera,
    setActiveCamera,
    setDrawMode,
    selectedIdx,
    selectAtom,
    ident,
  } = useAnnotations();
  const { currentTime } = useTime();

  // ============ Inline quick-add state ============
  const [qaKind, setQaKind] = useState<QuickAddKind>("subtask");
  const [qaValues, setQaValues] = useState<Record<string, string>>({});
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [pushSettings, setPushSettings] = useState(DEFAULT_HUB_PUSH_SETTINGS);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [pushError, setPushError] = useState<{
    title: string;
    message: string;
    rawDetails?: string;
    suggestion?: string;
  } | null>(null);
  const [pushSuccess, setPushSuccess] = useState<{
    repoId: string;
    url: string;
    commitUrl?: string | null;
    prUrl?: string | null;
    commitOid?: string | null;
  } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copiedError, setCopiedError] = useState(false);
  const [backendHealth, setBackendHealth] = useState<BackendHealth | null>(
    null,
  );
  const qaDef = QUICK_ADD_DEFS_BY_KIND[qaKind];

  useEffect(() => {
    if (isAnnotateBackendEnabled()) {
      fetchHealth().then((h) => {
        if (h) setBackendHealth(h);
      });
    }
  }, [pushModalOpen]);

  useEffect(() => {
    const saved = readPersistedHubSettings();
    setPushSettings({
      ...saved,
      targetRepoId: saved.targetRepoId || (ident.repoId ? ident.repoId : ""),
      pushInPlace:
        typeof saved.pushInPlace === "boolean"
          ? saved.pushInPlace
          : !!ident.repoId,
    });
  }, [ident.repoId]);

  useEffect(() => {
    writePersistedHubSettings(pushSettings);
  }, [pushSettings]);

  // Initialize active camera once cameras arrive.
  React.useEffect(() => {
    if (!activeCamera && cameraKeys.length > 0) setActiveCamera(cameraKeys[0]);
  }, [activeCamera, cameraKeys, setActiveCamera]);

  // The Annotations tab keeps the canvas overlay in "auto" mode the whole
  // time — drag = bbox, click = keypoint.
  React.useEffect(() => {
    setDrawMode("auto");
    return () => setDrawMode("off");
  }, [setDrawMode]);

  // ============ Atom grouping for the rail ============
  // The rail shows one section per atom-kind. Each kind is a single config
  // entry: how to detect atoms in this kind, and how to label them in the row.
  // VQA filters out other-camera answers when the dataset has multiple
  // cameras so the rail mirrors the active video.
  const groups = useMemo(() => {
    const firstLine = (s: string | null) =>
      (s || "").split("\n")[0] || "(empty)";
    const otherCamera = (a: LanguageAtom): boolean =>
      !!activeCamera &&
      cameraKeys.length > 1 &&
      a.camera != null &&
      a.camera !== activeCamera;
    return RAIL_GROUPS.map((def) => {
      const entries = atoms
        .map((atom, idx) => ({ atom, idx }))
        .filter(({ atom }) => def.match(atom, otherCamera))
        .map(({ atom, idx }) => ({
          atom,
          idx,
          label: def.label(atom, { activeCamera, firstLine }),
        }))
        .sort((a, b) => a.atom.timestamp - b.atom.timestamp);
      return { def, entries };
    });
  }, [atoms, activeCamera, cameraKeys.length]);

  // ============ Quick-add handler ============
  // VQA quick-adds inherit the active camera so per-camera filtering shows
  // them in the right rail / overlay. Non-VQA atoms stay camera-agnostic
  // (the def's `build` ignores `vqaCamera` for those).
  const handleQuickAdd = () => {
    const ts = snap(currentTime);
    const vqaCamera = activeCamera ?? cameraKeys[0] ?? null;
    const newAtoms = qaDef.build(qaValues, { ts, vqaCamera });
    if (!newAtoms || !newAtoms.length) return;
    addAtoms(newAtoms);
    // Select the freshly added atom (last one added) so the editor opens for it.
    selectAtom(atoms.length + newAtoms.length - 1);
    setQaValues({});
  };

  // ============ Save / export ============
  const handleSave = async () => {
    const r = await save();
    if (!r.ok) {
      setExportStatus(`Save failed: ${r.error || "unknown"}`);
    } else {
      setExportStatus(
        r.path
          ? `Saved episode to ${r.path}`
          : "Saved episode (backend did not report a path — update/restart backend/app.py).",
      );
    }
  };

  const handleSaveDataset = async () => {
    if (!isAnnotateBackendEnabled()) {
      setExportStatus(
        "Backend not configured. Set NEXT_PUBLIC_ANNOTATE_BACKEND_URL and run backend/app.py.",
      );
      return;
    }
    setExportStatus("Saving dataset…");
    try {
      const r = await apiExport(ident);
      setExportStatus(
        `Saved dataset to ${r.output_dir} (persistent: ${r.persistent_rows}, events: ${r.event_rows}).`,
      );
    } catch (e) {
      setExportStatus(
        `Save dataset failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const handlePushToHub = async () => {
    if (!isAnnotateBackendEnabled()) {
      setPushError({
        title: "Backend Not Configured",
        message:
          "The annotation backend service is not running or not configured.",
        suggestion:
          "Set NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 and run backend/app.py using 'uvicorn app:app --port 7861 --reload'.",
      });
      return;
    }

    const token = cleanToken(pushSettings.hfToken);
    if (!token && !backendHealth?.has_hf_token) {
      setPushError({
        title: "Hugging Face Token Required",
        message:
          "A Hugging Face access token with Write permissions is required to commit datasets to the Hub.",
        suggestion:
          "Please enter your Hugging Face write token (usually starting with hf_). You can generate one at huggingface.co/settings/tokens, or set HF_TOKEN in the environment.",
      });
      return;
    }

    const isPushInPlace = pushSettings.pushInPlace && !!ident.repoId;
    const targetRepo = isPushInPlace
      ? ident.repoId!
      : pushSettings.targetRepoId.trim();

    if (!targetRepo) {
      setPushError({
        title: "Target Repository Required",
        message:
          "Please specify the target repository ID to commit to (e.g. 'username/dataset-name').",
        suggestion:
          "Enter your Hugging Face username and dataset name in the format: username/dataset-name.",
      });
      return;
    }

    if (!pushSettings.commitMessage.trim()) {
      setPushError({
        title: "Commit Message Required",
        message: "Please provide a commit summary message.",
        suggestion:
          "A commit message describes the annotations being added or updated (e.g. 'Add language annotations').",
      });
      return;
    }

    // Save persisted settings (persisting sanitized token)
    writePersistedHubSettings({
      hfToken: token,
      pushInPlace: pushSettings.pushInPlace,
      targetRepoId: pushSettings.targetRepoId,
      privateRepo: pushSettings.privateRepo,
      branch: pushSettings.branch,
      createPr: pushSettings.createPr,
    });

    setPushInProgress(true);
    setPushResult(null);

    // If there are unsaved changes in the current episode, automatically commit them first
    if (dirty) {
      try {
        setExportStatus("Saving current episode annotations before commit…");
        const saveRes = await save();
        if (!saveRes.ok) {
          throw new Error(
            saveRes.error ||
              "Failed to save episode annotations to backend before commit.",
          );
        }
      } catch (saveErr) {
        setPushInProgress(false);
        const errStr =
          saveErr instanceof Error ? saveErr.message : String(saveErr);
        setPushError({
          title: "Pre-commit Save Failed",
          message:
            "Failed to save the current episode's unsaved annotations to the backend before pushing.",
          rawDetails: errStr,
          suggestion:
            "Please check that backend/app.py is reachable and running.",
        });
        return;
      }
    }

    try {
      setExportStatus("Exporting dataset and committing to Hugging Face…");
      const result = await pushToHub({
        ident,
        hfToken: token || undefined,
        pushInPlace: isPushInPlace,
        newRepoId: isPushInPlace ? null : targetRepo,
        privateRepo: pushSettings.privateRepo,
        commitMessage: pushSettings.commitMessage.trim(),
        commitDescription: pushSettings.commitDescription.trim() || undefined,
        branch: pushSettings.branch.trim() || "main",
        createPr: pushSettings.createPr,
      });

      setPushModalOpen(false);
      setPushSuccess({
        repoId: result.repo_id,
        url: result.url,
        commitUrl: result.commit_url,
        prUrl: result.pr_url,
        commitOid: result.commit_oid,
      });
      setPushResult(`Pushed dataset to ${result.repo_id}.`);
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      let suggestion =
        "Please verify your settings, permissions, and network connection.";

      if (
        rawMsg.includes("401") ||
        rawMsg.toLowerCase().includes("unauthorized") ||
        rawMsg.toLowerCase().includes("invalid user token") ||
        rawMsg.toLowerCase().includes("token validation failed")
      ) {
        if (backendHealth?.has_hf_token && token) {
          suggestion = `Authentication failed using the custom token in the input. Because your backend has a valid server token active (@${backendHealth.hf_user || "configured"}), click 'Clear' on the token field in the push dialog to commit using the server token instead.`;
        } else {
          suggestion =
            "Authentication failed. Check that your Hugging Face token is valid and has Write permissions (Role: Write). You can generate a new token at huggingface.co/settings/tokens.";
        }
      } else if (
        rawMsg.includes("403") ||
        rawMsg.toLowerCase().includes("forbidden")
      ) {
        const repoSuffix = ident.repoId?.split("/")[1] || "my-dataset";
        suggestion = `Permission denied for repository '${targetRepo}'. If you are not an owner/collaborator of this repository, select 'New / Custom repo' and specify your own repository ID (e.g. your-username/${repoSuffix}).`;
      } else if (
        rawMsg.includes("404") ||
        rawMsg.toLowerCase().includes("not found")
      ) {
        suggestion =
          "The repository or dataset was not found. If pushing to a new repository, check the namespace/name format.";
      } else if (
        rawMsg.toLowerCase().includes("failed to fetch") ||
        rawMsg.toLowerCase().includes("networkerror") ||
        rawMsg.toLowerCase().includes("backend not configured")
      ) {
        suggestion =
          "Cannot reach the annotation backend service. Verify that 'uvicorn app:app --port 7861' is running and NEXT_PUBLIC_ANNOTATE_BACKEND_URL is set.";
      }

      setPushError({
        title: "Push to Hugging Face Failed",
        message:
          "An error occurred while exporting or pushing the dataset to Hugging Face Hub.",
        rawDetails: rawMsg,
        suggestion,
      });
    } finally {
      setPushInProgress(false);
    }
  };

  const selectedAtom =
    selectedIdx != null && selectedIdx >= 0 && selectedIdx < atoms.length
      ? atoms[selectedIdx]
      : null;

  // ============ Render ============
  return (
    <div className="annotation-workbench">
      <div className="annotation-actionbar">
        <div>
          <h3>
            Language annotations
            {dirty && <span className="dirty-pill">unsaved</span>}
          </h3>
          <p>
            Select an atom from the timeline or list, then edit it in the
            inspector.
          </p>
        </div>
        <div className="actionbar-actions">
          {!backendEnabled && (
            <span className="backend-offline">
              backend offline — edits saved to sessionStorage only
            </span>
          )}
          <button
            disabled={saving || !dirty}
            onClick={handleSave}
            className="text-xs h-7 px-3 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save episode"}
          </button>
          <button
            disabled={!backendEnabled}
            onClick={handleSaveDataset}
            className="text-xs h-7 px-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            Save dataset
          </button>
          <button
            disabled={!backendEnabled}
            onClick={() => setPushModalOpen(true)}
            className="text-xs h-7 px-3 rounded border border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 disabled:opacity-40"
          >
            Push dataset to hub
          </button>
        </div>
      </div>

      {exportStatus && <div className="save-status">{exportStatus}</div>}
      {pushResult && <div className="save-status">{pushResult}</div>}

      {/* Visible Error Popup */}
      {pushError && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-lg rounded-xl border border-rose-500/40 bg-slate-900 p-5 shadow-2xl ring-1 ring-rose-500/20">
            <div className="flex items-start gap-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/20 text-rose-400 ring-1 ring-rose-500/30">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-rose-100">
                    {pushError.title}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setPushError(null)}
                    className="h-6 w-6 rounded flex items-center justify-center text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    ×
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                  {pushError.message}
                </p>
              </div>
            </div>

            {pushError.suggestion && (
              <div className="mt-3.5 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                <div className="font-semibold text-amber-300 flex items-center gap-1.5 mb-1">
                  <span>💡 How to fix:</span>
                </div>
                <p className="leading-relaxed">{pushError.suggestion}</p>
              </div>
            )}

            {pushError.rawDetails && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-400 mb-1">
                  <span>Technical details</span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(pushError.rawDetails || "");
                      setCopiedError(true);
                      setTimeout(() => setCopiedError(false), 2000);
                    }}
                    className="text-xs text-cyan-400 hover:text-cyan-300"
                  >
                    {copiedError ? "✓ Copied" : "Copy details"}
                  </button>
                </div>
                <pre className="max-h-32 overflow-auto rounded border border-slate-800 bg-slate-950 p-2.5 font-mono text-[11px] text-rose-300 whitespace-pre-wrap break-all select-all">
                  {pushError.rawDetails}
                </pre>
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setPushError(null)}
                className="h-8 rounded border border-slate-700 bg-slate-800 px-3 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  setPushError(null);
                  setPushModalOpen(true);
                }}
                className="h-8 rounded border border-violet-500/40 bg-violet-600 px-3.5 text-xs font-medium text-white hover:bg-violet-500"
              >
                Edit Settings & Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Visible Success Popup */}
      {pushSuccess && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-emerald-500/40 bg-slate-900 p-5 shadow-2xl ring-1 ring-emerald-500/20">
            <div className="flex items-start gap-3.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-emerald-100">
                  Dataset Pushed to Hugging Face!
                </h3>
                <p className="mt-1 text-xs text-slate-300">
                  Your dataset annotations have been committed and uploaded
                  successfully.
                </p>
                <div className="mt-3 rounded border border-slate-800 bg-slate-950 p-2.5 font-mono text-xs text-slate-300">
                  <div>
                    Repo:{" "}
                    <span className="text-emerald-300 font-semibold">
                      {pushSuccess.repoId}
                    </span>
                  </div>
                  {pushSuccess.commitOid && (
                    <div className="text-[11px] text-slate-400 mt-1">
                      Commit: {pushSuccess.commitOid.slice(0, 8)}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
              <a
                href={pushSuccess.url}
                target="_blank"
                rel="noreferrer"
                className="h-8 inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-600 px-3.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                <span>
                  {pushSuccess.prUrl
                    ? "View Pull Request ↗"
                    : "Open Dataset on Hub ↗"}
                </span>
              </a>
              <button
                type="button"
                onClick={() => setPushSuccess(null)}
                className="h-8 rounded border border-slate-700 bg-slate-800 px-3 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Push to Hub Configuration Modal */}
      {pushModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="annotations-skin w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl my-6">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400">
                  Hugging Face Hub
                </div>
                <h4 className="mt-0.5 text-lg font-semibold text-slate-100">
                  Push Dataset to Hub
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setPushModalOpen(false)}
                className="h-7 w-7 rounded border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white"
              >
                ×
              </button>
            </div>

            <div className="space-y-3.5 max-h-[75vh] overflow-y-auto pr-1">
              {/* Token Input */}
              <div>
                {backendHealth?.has_hf_token && (
                  <div className="mb-2.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-emerald-400 font-bold">✓</span>
                      <div>
                        <span className="font-medium text-emerald-100">
                          Server HF Token detected
                        </span>
                        {backendHealth.hf_user && (
                          <span className="text-emerald-300 ml-1">
                            (@{backendHealth.hf_user})
                          </span>
                        )}
                        <div className="text-[10px] text-emerald-300/80">
                          {pushSettings.hfToken
                            ? "Custom token is entered below. Click 'Use Server Token' to use the backend token."
                            : "Leave token blank to use this server token."}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {backendHealth.hf_token_preview && (
                        <span className="text-[11px] font-mono text-emerald-300/90 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                          {backendHealth.hf_token_preview}
                        </span>
                      )}
                      {pushSettings.hfToken ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPushSettings((prev) => ({
                              ...prev,
                              hfToken: "",
                            }))
                          }
                          className="rounded border border-emerald-500/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-100 hover:bg-emerald-500/30 transition-colors"
                        >
                          Use Server Token
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
                    HF Token{" "}
                    {backendHealth?.has_hf_token
                      ? "(optional, server token active)"
                      : "*"}
                  </label>
                  <a
                    href="https://huggingface.co/settings/tokens"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 underline"
                  >
                    Get token ↗
                  </a>
                </div>
                <div className="relative mt-1">
                  <input
                    type={showToken ? "text" : "password"}
                    value={pushSettings.hfToken}
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) =>
                      setPushSettings((prev) => ({
                        ...prev,
                        hfToken: sanitizeHfToken(e.target.value),
                      }))
                    }
                    placeholder={
                      backendHealth?.has_hf_token
                        ? `Using server token (${backendHealth.hf_token_preview || "configured"}) — or enter custom token`
                        : "hf_..."
                    }
                    className="w-full pr-24 font-mono text-xs"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                    {pushSettings.hfToken ? (
                      <button
                        type="button"
                        onClick={() =>
                          setPushSettings((prev) => ({
                            ...prev,
                            hfToken: "",
                          }))
                        }
                        title={
                          backendHealth?.has_hf_token
                            ? "Clear to use server token"
                            : "Clear token"
                        }
                        className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-amber-300 hover:bg-slate-700 border border-slate-700"
                      >
                        Clear
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
                    >
                      {showToken ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  {pushSettings.hfToken ? (
                    <div className="text-amber-300 flex items-center gap-1">
                      <span>●</span>
                      <span>
                        Custom token active ({pushSettings.hfToken.length}{" "}
                        chars)
                      </span>
                      {backendHealth?.has_hf_token && (
                        <button
                          type="button"
                          onClick={() =>
                            setPushSettings((prev) => ({
                              ...prev,
                              hfToken: "",
                            }))
                          }
                          className="ml-1 text-cyan-400 hover:text-cyan-300 underline"
                        >
                          Revert to server token
                        </button>
                      )}
                    </div>
                  ) : backendHealth?.has_hf_token ? (
                    <span className="text-emerald-400">
                      ✓ Using backend server token{" "}
                      {backendHealth.hf_user && `(@${backendHealth.hf_user}) `}(
                      {backendHealth.hf_token_preview})
                    </span>
                  ) : (
                    <span className="text-slate-400">
                      Write role permission required to push commits or create
                      repositories.
                    </span>
                  )}
                </div>
              </div>

              {/* Destination Repository */}
              <div className="space-y-2">
                <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">
                  Destination Repository
                </span>
                {ident.repoId ? (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        setPushSettings((prev) => ({
                          ...prev,
                          pushInPlace: false,
                        }))
                      }
                      className={`p-2.5 rounded border text-left transition-colors ${
                        !pushSettings.pushInPlace
                          ? "border-violet-500 bg-violet-500/20 text-white font-medium"
                          : "border-slate-700 bg-slate-950/60 text-slate-400 hover:border-slate-600"
                      }`}
                    >
                      <div>New / Custom repo</div>
                      <div className="text-[10px] text-slate-400 font-normal mt-0.5">
                        Push to your own HF account
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPushSettings((prev) => ({
                          ...prev,
                          pushInPlace: true,
                        }))
                      }
                      className={`p-2.5 rounded border text-left transition-colors ${
                        pushSettings.pushInPlace
                          ? "border-violet-500 bg-violet-500/20 text-white font-medium"
                          : "border-slate-700 bg-slate-950/60 text-slate-400 hover:border-slate-600"
                      }`}
                    >
                      <div>Current repo (in-place)</div>
                      <div className="text-[10px] text-slate-400 font-normal mt-0.5">
                        Requires write access to repo
                      </div>
                    </button>
                  </div>
                ) : (
                  <div className="rounded border border-cyan-500/30 bg-cyan-500/10 p-2 text-xs text-cyan-200">
                    Local dataset: Specify your target Hugging Face repository
                    below.
                  </div>
                )}

                {!pushSettings.pushInPlace || !ident.repoId ? (
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
                      Target Repo ID *
                      <input
                        type="text"
                        value={pushSettings.targetRepoId}
                        onChange={(e) =>
                          setPushSettings((prev) => ({
                            ...prev,
                            targetRepoId: e.target.value,
                          }))
                        }
                        placeholder={
                          ident.repoId
                            ? `your-username/${ident.repoId.split("/")[1] || ident.repoId}`
                            : "username/dataset-name"
                        }
                        className="mt-1 w-full font-mono text-xs"
                      />
                    </label>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Format:{" "}
                      <code className="text-slate-300">
                        username/dataset-name
                      </code>{" "}
                      or{" "}
                      <code className="text-slate-300">
                        organization/dataset-name
                      </code>
                    </p>
                  </div>
                ) : (
                  <div className="rounded border border-slate-700 bg-slate-950/60 p-2.5 text-xs text-slate-300">
                    Target repo:{" "}
                    <span className="font-mono text-cyan-300 font-semibold">
                      {ident.repoId}
                    </span>
                  </div>
                )}
              </div>

              {/* Commit Title */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
                  Commit Title / Summary *
                  <input
                    type="text"
                    value={pushSettings.commitMessage}
                    onChange={(e) =>
                      setPushSettings((prev) => ({
                        ...prev,
                        commitMessage: e.target.value,
                      }))
                    }
                    placeholder="Add language annotations"
                    className="mt-1 w-full text-xs"
                  />
                </label>
              </div>

              {/* Extended Commit Description */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
                  Commit Description (optional)
                  <textarea
                    rows={2}
                    value={pushSettings.commitDescription}
                    onChange={(e) =>
                      setPushSettings((prev) => ({
                        ...prev,
                        commitDescription: e.target.value,
                      }))
                    }
                    placeholder="Optional notes or changelog for this dataset commit..."
                    className="mt-1 w-full text-xs"
                  />
                </label>
              </div>

              {/* Branch and Privacy */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium uppercase tracking-[0.12em] text-slate-400">
                  Branch / Revision
                  <input
                    type="text"
                    value={pushSettings.branch}
                    onChange={(e) =>
                      setPushSettings((prev) => ({
                        ...prev,
                        branch: e.target.value,
                      }))
                    }
                    placeholder="main"
                    className="mt-1 w-full text-xs font-mono"
                  />
                </label>

                <div className="flex flex-col justify-center pt-2">
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pushSettings.privateRepo}
                      onChange={(e) =>
                        setPushSettings((prev) => ({
                          ...prev,
                          privateRepo: e.target.checked,
                        }))
                      }
                    />
                    <span>Private repository</span>
                  </label>
                  <span className="text-[10px] text-slate-500 ml-5">
                    Only visible to you / your org
                  </span>
                </div>
              </div>

              {/* Pull Request Checkbox */}
              <div>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pushSettings.createPr}
                    onChange={(e) =>
                      setPushSettings((prev) => ({
                        ...prev,
                        createPr: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    Create a Pull Request instead of committing directly
                  </span>
                </label>
              </div>

              {/* Dirty notice */}
              {dirty && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200 flex items-start gap-2">
                  <span className="text-amber-400 font-bold">⚡</span>
                  <div>
                    <strong>Unsaved episode edits:</strong> Changes in this
                    episode will be saved and included in the commit
                    automatically.
                  </div>
                </div>
              )}

              {/* Modal Actions */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setPushModalOpen(false)}
                  disabled={pushInProgress}
                  className="h-8 rounded border border-slate-600 px-3 text-xs text-slate-200 hover:border-slate-400 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePushToHub}
                  disabled={pushInProgress}
                  className="h-8 rounded border border-violet-500/40 bg-violet-600 px-4 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50 shadow-sm flex items-center gap-2"
                >
                  {pushInProgress ? (
                    <>
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-solid border-white border-r-transparent" />
                      <span>Committing & Pushing…</span>
                    </>
                  ) : (
                    "Commit & Push to Hub"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <section className="annotation-composer">
        <div className="composer-copy">
          <span className="section-kicker">Add text annotation</span>
          <p>
            Adds task phrasing, subtask, plan, memory, speech, or non-spatial
            VQA atoms. Task phrasings are saved at episode start.
          </p>
        </div>
        <div className="quick-add">
          <span className="ts-pill">
            t = {qaDef.atEpisodeStart ? fmtTime(0) : fmtTime(currentTime)}
          </span>
          <select
            value={qaKind}
            onChange={(e) => {
              setQaKind(e.target.value as QuickAddKind);
              setQaValues({});
            }}
          >
            {QUICK_ADD_DEFS.map((d) => (
              <option key={d.kind} value={d.kind}>
                {d.label}
              </option>
            ))}
          </select>
          {qaDef.fields.map((f, i) => (
            <input
              key={f.name}
              type={f.type === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              className={f.grow ? "grow" : undefined}
              style={f.width ? { width: f.width } : undefined}
              value={qaValues[f.name] ?? ""}
              onChange={(e) =>
                setQaValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
              onKeyDown={
                i === qaDef.fields.length - 1
                  ? (e) => e.key === "Enter" && handleQuickAdd()
                  : undefined
              }
            />
          ))}
          <button className="add-btn" onClick={handleQuickAdd}>
            + Add at frame
          </button>
        </div>
      </section>

      <div className="workspace inspector-workspace">
        <div className="rail annotation-list">
          <div className="list-head">
            <div>
              <span className="section-kicker">Annotations</span>
              <p>{atoms.length} atoms in this episode</p>
            </div>
            <span className="ts-pill">{fmtTime(currentTime)}</span>
          </div>
          {atoms.length === 0 && (
            <div className="rail-empty">
              No annotations yet.
              <br />
              Add text above or draw on the active video.
            </div>
          )}
          {(["persistent", "events"] as const).map((column) => {
            const colGroups = groups.filter(({ def }) => def.column === column);
            const total = colGroups.reduce(
              (n, { entries }) => n + entries.length,
              0,
            );
            if (total === 0) return null;
            return (
              <div className="rail-column" key={column}>
                <div className={`rail-column-head ${column}`}>
                  <span className="rail-column-title">
                    {column === "persistent" ? "Persistent" : "Events"}
                  </span>
                  <span className="rail-column-sub">
                    {column === "persistent"
                      ? "language_persistent · broadcast across every frame"
                      : "language_events · fire on a single frame"}
                  </span>
                </div>
                {colGroups.map(({ def, entries }) => (
                  <RailGroup
                    key={def.key}
                    title={def.title}
                    dotClass={def.dotClass}
                    entries={entries}
                    currentTime={currentTime}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div className="editor inspector">
          {selectedAtom == null ? (
            <div className="editor-empty">
              <span className="section-kicker">Inspector</span>
              <p>
                Select an annotation from the list or timeline, or draw a new
                bbox/keypoint on the video.
              </p>
            </div>
          ) : (
            <AtomEditor
              atom={selectedAtom}
              cameraKeys={cameraKeys}
              onChange={(updates) => updateAtom(selectedIdx as number, updates)}
              onDelete={() => deleteAtom(selectedAtom)}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Rail group — one row per atom, click selects.
// ---------------------------------------------------------------------------

const RailGroup: React.FC<{
  title: string;
  dotClass: string;
  entries: { atom: LanguageAtom; idx: number; label: string }[];
  currentTime: number;
}> = ({ title, dotClass, entries, currentTime }) => {
  const { selectedIdx, selectAtom } = useAnnotations();
  const jump = useJump();
  if (entries.length === 0) return null;
  return (
    <div className="rail-group">
      <div className="rail-group-head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className={`style-dot ${dotClass}`} />
          {title}
        </span>
        <span className="count">{entries.length}</span>
      </div>
      {entries.map(({ atom, idx, label }) => {
        const sel = idx === selectedIdx;
        const active = isActiveAt(atom.timestamp, currentTime);
        return (
          <div
            key={idx}
            className={`rail-row ${sel ? "selected" : ""} ${active ? "active-now" : ""}`}
            onClick={() => {
              selectAtom(idx);
              jump(atom.timestamp);
            }}
          >
            <span className="ts">{fmtTime(atom.timestamp)}</span>
            <span className="body">{label}</span>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// AtomEditor — form for the currently selected atom.
// ---------------------------------------------------------------------------

const AtomEditor: React.FC<{
  atom: LanguageAtom;
  cameraKeys: string[];
  onChange: (updates: Partial<LanguageAtom>) => void;
  onDelete: () => void;
}> = ({ atom, cameraKeys, onChange, onDelete }) => {
  const jump = useJump();
  const { snap } = useAnnotations();
  const isSpeech = isSpeechAtom(atom);
  const cameraLabel = atom.camera ?? "all cameras";
  const roleLabel = isSpeech ? "speech" : atom.role;
  const [timestampDraft, setTimestampDraft] = useState(() =>
    String(atom.timestamp),
  );

  React.useEffect(() => {
    setTimestampDraft(String(atom.timestamp));
  }, [atom.timestamp]);

  const commitTimestamp = React.useCallback(
    (raw = timestampDraft) => {
      const next = Number(raw);
      if (!Number.isFinite(next) || next < 0) {
        setTimestampDraft(String(atom.timestamp));
        return;
      }
      onChange({ timestamp: next });
      setTimestampDraft(String(next));
    },
    [atom.timestamp, onChange, timestampDraft],
  );

  const commitSnappedTimestamp = () => {
    const parsed = Number(timestampDraft);
    const next = snap(Number.isFinite(parsed) ? parsed : atom.timestamp);
    onChange({ timestamp: next });
    setTimestampDraft(String(next));
  };

  return (
    <div className="inspector-body">
      <div className="editor-head inspector-head">
        <div className="inspector-title">
          <StylePill style={atom.style} />
          <div>
            <strong>{fmtTime(atom.timestamp)}</strong>
            <span>
              {roleLabel} · {cameraLabel}
            </span>
          </div>
        </div>
        <div className="right">
          <button
            className="icon-btn"
            title="Jump to this atom's frame"
            onClick={() => jump(atom.timestamp)}
          >
            ▶
          </button>
          <button
            className="icon-btn danger"
            title="Delete this atom"
            onClick={onDelete}
          >
            ×
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field-label">Timestamp (s)</label>
        <div className="ts-row">
          <input
            type="text"
            inputMode="decimal"
            value={timestampDraft}
            onChange={(e) => setTimestampDraft(e.target.value)}
            onBlur={() => commitTimestamp()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTimestamp();
              if (e.key === "Escape") setTimestampDraft(String(atom.timestamp));
            }}
          />
          <button
            type="button"
            className="frame-pill"
            onPointerDown={(e) => {
              e.preventDefault();
              commitSnappedTimestamp();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                commitSnappedTimestamp();
              }
            }}
          >
            snap to frame
          </button>
        </div>
      </div>

      {/* Content / role-specific fields */}
      {(atom.style === "task_aug" ||
        atom.style === "subtask" ||
        atom.style === "plan" ||
        atom.style === "memory" ||
        atom.style === "interjection") && (
        <div className="field">
          <label className="field-label">
            {atom.style === "subtask"
              ? "Subtask"
              : atom.style === "task_aug"
                ? "Task augmentation"
                : atom.style === "plan"
                  ? "Plan"
                  : atom.style === "memory"
                    ? "Memory"
                    : "Interjection"}
          </label>
          {atom.style === "task_aug" ||
          atom.style === "subtask" ||
          atom.style === "interjection" ? (
            <textarea
              rows={3}
              value={atom.content || ""}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          ) : (
            <textarea
              rows={4}
              value={atom.content || ""}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          )}
        </div>
      )}

      {isSpeech && atom.tool_calls && (
        <div className="field">
          <label className="field-label">Robot speech (say tool call)</label>
          <input
            type="text"
            value={speechText(atom) || ""}
            onChange={(e) => {
              const next = atom.tool_calls
                ? atom.tool_calls.map((tc, i) =>
                    i === 0
                      ? {
                          ...tc,
                          function: {
                            ...tc.function,
                            arguments: { text: e.target.value },
                          },
                        }
                      : tc,
                  )
                : null;
              onChange({ tool_calls: next });
            }}
          />
        </div>
      )}

      {atom.style === "vqa" && (
        <>
          <CameraField
            atom={atom}
            cameraKeys={cameraKeys}
            onChange={onChange}
          />
          <VqaEditorFields atom={atom} onChange={onChange} />
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// CameraField — surface the row-level camera tag for VQA atoms (PR 3467).
// ---------------------------------------------------------------------------

const CameraField: React.FC<{
  atom: LanguageAtom;
  cameraKeys: string[];
  onChange: (updates: Partial<LanguageAtom>) => void;
}> = ({ atom, cameraKeys, onChange }) => {
  if (atom.style !== "vqa") return null;
  if (cameraKeys.length === 0) return null;
  const value = atom.camera ?? "";
  return (
    <div className="field">
      <label className="field-label">Camera</label>
      <select
        value={value}
        onChange={(e) =>
          onChange({ camera: e.target.value === "" ? null : e.target.value })
        }
      >
        <option value="">(any — renders on every camera)</option>
        {cameraKeys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </div>
  );
};

const VqaEditorFields: React.FC<{
  atom: LanguageAtom;
  onChange: (updates: Partial<LanguageAtom>) => void;
}> = ({ atom, onChange }) => {
  const parsed = parseVqaAnswer(atom.content);
  const kind = parsed ? classifyVqa(parsed) : null;

  if (atom.role === "user") {
    return (
      <div className="field">
        <label className="field-label">Question</label>
        <input
          type="text"
          value={atom.content || ""}
          onChange={(e) => onChange({ content: e.target.value })}
        />
      </div>
    );
  }

  // Assistant atom — answer JSON (raw + structured viewer)
  return (
    <div className="field">
      <label className="field-label">Answer ({kind || "unknown"})</label>
      <textarea
        rows={5}
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
        value={atom.content || ""}
        onChange={(e) => onChange({ content: e.target.value })}
      />
      {parsed && kind === "bbox" && (
        <p className="text-[11px] text-slate-400 mt-1">
          Tip: bbox values are 0..1 image-relative (xyxy). Edit on the video
          itself by deleting this and re-drawing.
        </p>
      )}
      {parsed && kind === "keypoint" && (
        <p className="text-[11px] text-slate-400 mt-1">
          Tip: point values are 0..1 image-relative (xy).
        </p>
      )}
    </div>
  );
};

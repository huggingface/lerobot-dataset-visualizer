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

import React, { useMemo, useState } from "react";
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
  isAnnotateBackendEnabled,
} from "../utils/annotationsClient";

interface Props {
  cameraKeys: string[];
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
  const qaDef = QUICK_ADD_DEFS_BY_KIND[qaKind];

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
        </div>
      </div>

      {exportStatus && <div className="save-status">{exportStatus}</div>}

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

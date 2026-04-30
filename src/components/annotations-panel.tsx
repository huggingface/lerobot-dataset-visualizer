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

const QUICK_ADD_KINDS: { value: QuickAddKind; label: string }[] = [
  { value: "task_aug", label: "task augmentation" },
  { value: "subtask", label: "subtask" },
  { value: "plan", label: "plan" },
  { value: "memory", label: "memory" },
  { value: "interjection", label: "interjection (user)" },
  { value: "speech", label: "speech (robot say)" },
  { value: "count", label: "vqa: count" },
  { value: "attribute", label: "vqa: attribute" },
  { value: "spatial", label: "vqa: spatial relation" },
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
  const [qaLabel, setQaLabel] = useState("");
  const [qaCount, setQaCount] = useState<number | "">("");
  const [qaAttr, setQaAttr] = useState("");
  const [qaAttrVal, setQaAttrVal] = useState("");
  const [qaSubject, setQaSubject] = useState("");
  const [qaRel, setQaRel] = useState("");
  const [qaObject, setQaObject] = useState("");
  const [exportStatus, setExportStatus] = useState<string | null>(null);

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
  const groups = useMemo(() => {
    type Entry = { atom: LanguageAtom; idx: number; label: string };
    const taskAug: Entry[] = [];
    const subtask: Entry[] = [];
    const plan: Entry[] = [];
    const memory: Entry[] = [];
    const interjection: Entry[] = [];
    const speech: Entry[] = [];
    const vqa: Entry[] = [];

    atoms.forEach((a, idx) => {
      if (a.style === "task_aug") {
        taskAug.push({ atom: a, idx, label: a.content || "(empty)" });
      } else if (a.style === "subtask") {
        subtask.push({ atom: a, idx, label: a.content || "(empty)" });
      } else if (a.style === "plan") {
        plan.push({
          atom: a,
          idx,
          label: (a.content || "").split("\n")[0] || "(empty)",
        });
      } else if (a.style === "memory") {
        memory.push({
          atom: a,
          idx,
          label: (a.content || "").split("\n")[0] || "(empty)",
        });
      } else if (a.style === "interjection") {
        interjection.push({ atom: a, idx, label: a.content || "(empty)" });
      } else if (isSpeechAtom(a)) {
        speech.push({ atom: a, idx, label: speechText(a) || "(empty)" });
      } else if (a.style === "vqa") {
        // Multi-camera datasets emit one (vqa, user) + (vqa, assistant) per
        // camera at each tick. Only show this camera's VQA in the rail so the
        // user sees the answer that goes with the video they're looking at.
        // Camera-agnostic VQA (a.camera == null) — e.g. older annotations —
        // still shows everywhere.
        if (
          activeCamera &&
          cameraKeys.length > 1 &&
          a.camera != null &&
          a.camera !== activeCamera
        ) {
          return;
        }
        const role = a.role === "user" ? "Q" : "A";
        const t = a.content || "";
        const cameraSuffix =
          a.camera && a.camera !== activeCamera ? `  [${a.camera}]` : "";
        vqa.push({
          atom: a,
          idx,
          label: `${role}: ${t.slice(0, 60)}${t.length > 60 ? "…" : ""}${cameraSuffix}`,
        });
      }
    });

    const sortByTs = <T extends { atom: LanguageAtom }>(arr: T[]) =>
      arr.sort((x, y) => x.atom.timestamp - y.atom.timestamp);
    return {
      taskAug: sortByTs(taskAug),
      subtask: sortByTs(subtask),
      plan: sortByTs(plan),
      memory: sortByTs(memory),
      interjection: sortByTs(interjection),
      speech: sortByTs(speech),
      vqa: sortByTs(vqa),
    };
  }, [atoms, activeCamera, cameraKeys.length]);

  // ============ Quick-add handlers ============
  const handleQuickAdd = () => {
    const ts = snap(currentTime);
    const text = qaLabel.trim();
    const newAtoms: LanguageAtom[] = [];

    // VQA quick-adds inherit the active camera so per-camera filtering
    // shows them in the right rail / overlay. Non-VQA atoms stay
    // camera-agnostic.
    const vqaCamera = activeCamera ?? cameraKeys[0] ?? null;

    if (qaKind === "task_aug") {
      if (!text) return;
      newAtoms.push({
        role: "user",
        content: text,
        style: "task_aug",
        timestamp: 0,
        camera: null,
        tool_calls: null,
      });
    } else if (
      qaKind === "subtask" ||
      qaKind === "plan" ||
      qaKind === "memory"
    ) {
      if (!text) return;
      newAtoms.push({
        role: "assistant",
        content: text,
        style: qaKind,
        timestamp: ts,
        camera: null,
        tool_calls: null,
      });
    } else if (qaKind === "interjection") {
      if (!text) return;
      newAtoms.push({
        role: "user",
        content: text,
        style: "interjection",
        timestamp: ts,
        camera: null,
        tool_calls: null,
      });
    } else if (qaKind === "speech") {
      if (!text) return;
      newAtoms.push(buildSpeechAtom(ts, text));
    } else if (qaKind === "count") {
      if (!text || qaCount === "") return;
      newAtoms.push(
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
          content: JSON.stringify({ label: text, count: Number(qaCount) }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      );
    } else if (qaKind === "attribute") {
      if (!text || !qaAttr || !qaAttrVal) return;
      newAtoms.push(
        {
          role: "user",
          content: `What ${qaAttr} is the ${text}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({
            label: text,
            attribute: qaAttr,
            value: qaAttrVal,
          }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      );
    } else if (qaKind === "spatial") {
      if (!qaSubject || !qaRel || !qaObject) return;
      newAtoms.push(
        {
          role: "user",
          content: `Where is the ${qaSubject} relative to the ${qaObject}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({
            subject: qaSubject,
            relation: qaRel,
            object: qaObject,
          }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      );
    }

    if (!newAtoms.length) return;
    addAtoms(newAtoms);
    // Select the freshly added atom (last one added) so the editor opens for it.
    selectAtom(atoms.length + newAtoms.length - 1);
    setQaLabel("");
    setQaCount("");
    setQaAttr("");
    setQaAttrVal("");
    setQaSubject("");
    setQaRel("");
    setQaObject("");
  };

  // ============ Save / export ============
  const handleSave = async () => {
    const r = await save();
    setExportStatus(r.ok ? "Saved." : `Save failed: ${r.error || "unknown"}`);
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
            t = {qaKind === "task_aug" ? fmtTime(0) : fmtTime(currentTime)}
          </span>
          <select
            value={qaKind}
            onChange={(e) => setQaKind(e.target.value as QuickAddKind)}
          >
            {QUICK_ADD_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          {qaKind === "task_aug" && (
            <input
              type="text"
              placeholder="pick up the blue cube and place it in the green box"
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "subtask" && (
            <input
              type="text"
              placeholder="grasp the handle of the sponge"
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "plan" && (
            <input
              type="text"
              placeholder="1. grab sponge / 2. wipe / 3. tidy"
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "memory" && (
            <input
              type="text"
              placeholder="sponge picked up; counter still dirty"
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "interjection" && (
            <input
              type="text"
              placeholder="user: actually skip the wipe…"
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "speech" && (
            <input
              type="text"
              placeholder="robot say: Got it, skipping the wipe."
              className="grow"
              value={qaLabel}
              onChange={(e) => setQaLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
            />
          )}
          {qaKind === "count" && (
            <>
              <input
                type="text"
                placeholder="object label (e.g. cup)"
                className="grow"
                value={qaLabel}
                onChange={(e) => setQaLabel(e.target.value)}
              />
              <input
                type="number"
                placeholder="count"
                style={{ width: 80 }}
                value={qaCount}
                onChange={(e) =>
                  setQaCount(
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
                onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
              />
            </>
          )}
          {qaKind === "attribute" && (
            <>
              <input
                type="text"
                placeholder="label"
                style={{ width: 120 }}
                value={qaLabel}
                onChange={(e) => setQaLabel(e.target.value)}
              />
              <input
                type="text"
                placeholder="attribute (color)"
                style={{ width: 120 }}
                value={qaAttr}
                onChange={(e) => setQaAttr(e.target.value)}
              />
              <input
                type="text"
                placeholder="value (red)"
                className="grow"
                value={qaAttrVal}
                onChange={(e) => setQaAttrVal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
              />
            </>
          )}
          {qaKind === "spatial" && (
            <>
              <input
                type="text"
                placeholder="subject"
                style={{ width: 100 }}
                value={qaSubject}
                onChange={(e) => setQaSubject(e.target.value)}
              />
              <input
                type="text"
                placeholder="relation (right_of)"
                style={{ width: 130 }}
                value={qaRel}
                onChange={(e) => setQaRel(e.target.value)}
              />
              <input
                type="text"
                placeholder="object"
                className="grow"
                value={qaObject}
                onChange={(e) => setQaObject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
              />
            </>
          )}
          <button className="add-btn" onClick={handleQuickAdd}>
            + Add at frame
          </button>
        </div>
      </section>

      <div className="grounding-panel">
        <div>
          <span className="section-kicker">Grounded VQA</span>
          <p>
            Draw directly on the active video to create visual questions. Drag
            for a bounding box, click for a point. The camera is detected from
            the video you draw on.
          </p>
        </div>
      </div>

      <div className="hint-banner">
        <span>
          Drag on any video to add a bbox question. Click any video to add a
          keypoint question. Confirm the popup with <kbd>↵</kbd>, or cancel with{" "}
          <kbd>Esc</kbd>.
        </span>
      </div>

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
          <RailGroup
            title="task aug"
            dotClass="dot-task-aug"
            entries={groups.taskAug}
            currentTime={currentTime}
          />
          <RailGroup
            title="subtask"
            dotClass="dot-subtask"
            entries={groups.subtask}
            currentTime={currentTime}
          />
          <RailGroup
            title="plan"
            dotClass="dot-plan"
            entries={groups.plan}
            currentTime={currentTime}
          />
          <RailGroup
            title="memory"
            dotClass="dot-memory"
            entries={groups.memory}
            currentTime={currentTime}
          />
          <RailGroup
            title="interjection"
            dotClass="dot-interjection"
            entries={groups.interjection}
            currentTime={currentTime}
          />
          <RailGroup
            title="speech"
            dotClass="dot-speech"
            entries={groups.speech}
            currentTime={currentTime}
          />
          <RailGroup
            title="vqa"
            dotClass="dot-vqa"
            entries={groups.vqa}
            currentTime={currentTime}
          />
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

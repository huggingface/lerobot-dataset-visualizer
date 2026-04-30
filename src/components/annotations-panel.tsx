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
  pushToHub as apiPush,
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
  | "subtask"
  | "plan"
  | "memory"
  | "interjection"
  | "speech"
  | "count"
  | "attribute"
  | "spatial";

const QUICK_ADD_KINDS: { value: QuickAddKind; label: string }[] = [
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
    const subtask: Entry[] = [];
    const plan: Entry[] = [];
    const memory: Entry[] = [];
    const interjection: Entry[] = [];
    const speech: Entry[] = [];
    const vqa: Entry[] = [];

    atoms.forEach((a, idx) => {
      if (a.style === "subtask") {
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

    if (qaKind === "subtask" || qaKind === "plan" || qaKind === "memory") {
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

  const handleExport = async () => {
    if (!isAnnotateBackendEnabled()) {
      setExportStatus(
        "Backend not configured. Set NEXT_PUBLIC_ANNOTATE_BACKEND_URL and run backend/app.py.",
      );
      return;
    }
    setExportStatus("Exporting…");
    try {
      const r = await apiExport(ident);
      setExportStatus(
        `Exported to ${r.output_dir} (persistent: ${r.persistent_rows}, events: ${r.event_rows}).`,
      );
    } catch (e) {
      setExportStatus(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const selectedAtom =
    selectedIdx != null && selectedIdx >= 0 && selectedIdx < atoms.length
      ? atoms[selectedIdx]
      : null;

  // ============ Render ============
  return (
    <div className="flex flex-col gap-3">
      {/* Top toolbar — save + export */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          Language annotations
          {dirty && (
            <span className="ml-2 text-xs text-orange-400">(unsaved)</span>
          )}
        </h3>
        <div className="flex gap-2 items-center">
          {!backendEnabled && (
            <span className="text-[11px] text-slate-500">
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
            onClick={handleExport}
            className="text-xs h-7 px-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            Export parquet
          </button>
        </div>
      </div>

      {exportStatus && (
        <div className="text-xs text-slate-400">{exportStatus}</div>
      )}

      {/* Camera selector */}
      {cameraKeys.length > 1 && (
        <div className="text-xs text-slate-400 flex items-center gap-2">
          Active camera for drawing:
          <select
            value={activeCamera || cameraKeys[0]}
            onChange={(e) => setActiveCamera(e.target.value)}
          >
            {cameraKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ============ Inline quick-add ============ */}
      <div className="quick-add">
        <span className="ts-pill">t = {fmtTime(currentTime)}</span>
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
        {/* Label / content input — adapts placeholder per kind */}
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
                setQaCount(e.target.value === "" ? "" : Number(e.target.value))
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

      {/* The timeline lives just above the workspace; it's rendered by
          AnnotationsTimeline in episode-viewer.tsx, immediately above this
          component. */}

      {/* VQA hint banner */}
      <div className="hint-banner">
        <span>
          ▸ <span className="style-pill vqa">vqa</span> <strong>Drag</strong> on
          the active camera to draw a bounding box (auto-templated as{" "}
          <code>&quot;Where is the &lt;label&gt;?&quot;</code>).{" "}
          <strong>Click</strong> to drop a keypoint (
          <code>&quot;Point to the &lt;label&gt;.&quot;</code>). Press{" "}
          <kbd>↵</kbd> to confirm or <kbd>Esc</kbd> to cancel.
        </span>
      </div>

      {/* ============ 2-column workspace ============ */}
      <div className="workspace">
        {/* Left rail */}
        <div className="rail">
          {atoms.length === 0 && (
            <div className="rail-empty">
              No annotations yet.
              <br />
              Use the quick-add bar above or drag on the video to start.
            </div>
          )}
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

        {/* Right editor pane */}
        <div className="editor">
          {selectedAtom == null ? (
            <div className="editor-empty">
              Select an annotation from the rail or click a marker on the
              timeline to edit it here.
            </div>
          ) : (
            <AtomEditor
              atom={selectedAtom}
              index={selectedIdx as number}
              cameraKeys={cameraKeys}
              onChange={(updates) => updateAtom(selectedIdx as number, updates)}
              onDelete={() => deleteAtom(selectedAtom)}
              onJump={() => {
                /* selection already implies the row was clicked, but expose
                   an explicit jump via the editor head too */
              }}
            />
          )}
        </div>
      </div>

      {backendEnabled && <PushToHubBlock ident={ident} />}
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
  index: number;
  cameraKeys: string[];
  onChange: (updates: Partial<LanguageAtom>) => void;
  onDelete: () => void;
  onJump: () => void;
}> = ({ atom, cameraKeys, onChange, onDelete }) => {
  const jump = useJump();
  const isSpeech = isSpeechAtom(atom);

  return (
    <div>
      <div className="editor-head">
        <StylePill style={atom.style} />
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
            type="number"
            step={0.001}
            value={atom.timestamp}
            onChange={(e) => onChange({ timestamp: Number(e.target.value) })}
          />
          <span className="frame-pill">snap to frame</span>
        </div>
      </div>

      {/* Content / role-specific fields */}
      {(atom.style === "subtask" ||
        atom.style === "plan" ||
        atom.style === "memory" ||
        atom.style === "interjection") && (
        <div className="field">
          <label className="field-label">
            {atom.style === "subtask"
              ? "Subtask"
              : atom.style === "plan"
                ? "Plan"
                : atom.style === "memory"
                  ? "Memory"
                  : "Interjection"}
          </label>
          {atom.style === "subtask" || atom.style === "interjection" ? (
            <input
              type="text"
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

// ---------------------------------------------------------------------------
// Push to Hub block (kept from the previous implementation, restyled).
// ---------------------------------------------------------------------------

const PushToHubBlock: React.FC<{
  ident: { repoId?: string | null; localPath?: string | null };
}> = ({ ident }) => {
  const [token, setToken] = useState("");
  const [pushInPlace, setPushInPlace] = useState(true);
  const [newRepoId, setNewRepoId] = useState("");
  const [privateRepo, setPrivateRepo] = useState(false);
  const [commit, setCommit] = useState("Add language annotations");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "ok" | "err";
    text: string;
    url?: string;
  } | null>(null);

  const onPush = async () => {
    if (!token) {
      setStatus({ kind: "err", text: "HF token is required" });
      return;
    }
    if (!pushInPlace && !newRepoId) {
      setStatus({
        kind: "err",
        text: "Provide a target repo or enable push-in-place",
      });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const r = await apiPush(
        ident,
        token,
        pushInPlace,
        pushInPlace ? null : newRepoId,
        privateRepo,
        commit,
      );
      setStatus({ kind: "ok", text: r.message, url: r.url });
    } catch (e) {
      setStatus({
        kind: "err",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="panel p-3 flex flex-col gap-2"
      style={{ marginTop: 12 }}
    >
      <header>
        <h4 className="text-xs uppercase tracking-wide text-slate-400">
          Push to Hub
        </h4>
        <p className="text-[11px] text-slate-500">
          Exports parquet shards with the new language columns and pushes via
          the FastAPI backend.
        </p>
      </header>
      <div className="flex flex-wrap gap-2 items-center text-xs text-slate-300">
        <input
          type="password"
          placeholder="hf_xxx token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="flex-1 min-w-[200px]"
        />
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={pushInPlace}
            onChange={(e) => setPushInPlace(e.target.checked)}
          />
          push in place
        </label>
        {!pushInPlace && (
          <>
            <input
              type="text"
              placeholder="org/new-dataset"
              value={newRepoId}
              onChange={(e) => setNewRepoId(e.target.value)}
              className="flex-1 min-w-[200px]"
            />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={privateRepo}
                onChange={(e) => setPrivateRepo(e.target.checked)}
              />
              private
            </label>
          </>
        )}
        <input
          type="text"
          placeholder="commit message"
          value={commit}
          onChange={(e) => setCommit(e.target.value)}
          className="flex-1 min-w-[200px]"
        />
        <button
          onClick={onPush}
          disabled={busy}
          className="text-xs h-7 px-3 rounded border border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
        >
          {busy ? "Pushing…" : "Push to Hub"}
        </button>
      </div>
      {status && (
        <div
          className={`text-xs ${status.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}
        >
          {status.text}
          {status.url && (
            <a href={status.url} target="_blank" className="ml-2 underline">
              open ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
};

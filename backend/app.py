"""LeRobot dataset visualizer — annotation backend.

A small FastAPI service that lets the Next.js visualizer write the v3.1
language schema introduced in lerobot#3467 (PR1) and used by the steerable
annotation pipeline in lerobot#3471 (PR2). Specifically it owns:

- per-episode annotation state, persisted to ``meta/lerobot_annotations.json``
- snapping event-style atom timestamps to exact source-frame timestamps
  (the writer in lerobot#3471 enforces exact match)
- exporting the annotated dataset by rewriting ``data/chunk-*/file-*.parquet``
  with two new columns:
    * ``language_persistent`` — broadcast per-episode (subtask/plan/memory)
    * ``language_events``     — per-frame (interjection/vqa, plus speech
      tool-call atoms with style=None)
  and a dataset-level ``tools`` column carrying the JSON schema for ``say``.
- pushing the result back to the Hugging Face Hub.

The frontend can run without this backend (read-only browsing). Annotation
write paths only light up when ``NEXT_PUBLIC_ANNOTATE_BACKEND_URL`` points to
an instance of this service.

Run locally:

    cd backend && pip install -r requirements.txt
    uvicorn app:app --port 7861 --reload

Then in another terminal:

    NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from pydantic import BaseModel

logger = logging.getLogger("lerobot-annotate")
logging.basicConfig(level=logging.INFO)

CACHE_ROOT = Path(os.environ.get("LEROBOT_ANNOTATE_CACHE", "/tmp/lerobot_visualizer_annotate_cache"))
EXPORT_ROOT = Path(os.environ.get("LEROBOT_ANNOTATE_EXPORT", "/tmp/lerobot_visualizer_annotate_exports"))

# --- Schema mirrors src/lerobot/datasets/language.py --------------------------

PERSISTENT_STYLES = {"subtask", "plan", "memory"}
EVENT_ONLY_STYLES = {"interjection", "vqa"}
KNOWN_STYLES = PERSISTENT_STYLES | EVENT_ONLY_STYLES
LANGUAGE_PERSISTENT = "language_persistent"
LANGUAGE_EVENTS = "language_events"

SAY_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "say",
        "description": "Speak a short utterance to the user via the TTS executor.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The verbatim text to speak."},
            },
            "required": ["text"],
        },
    },
}


def column_for_style(style: str | None) -> str:
    if style is None:
        return LANGUAGE_EVENTS
    if style in PERSISTENT_STYLES:
        return LANGUAGE_PERSISTENT
    if style in EVENT_ONLY_STYLES:
        return LANGUAGE_EVENTS
    raise ValueError(f"Unknown language style: {style!r}")


# --- Pydantic models ----------------------------------------------------------


class DatasetRef(BaseModel):
    repo_id: str | None = None
    revision: str | None = None
    local_path: str | None = None


class LoadRequest(DatasetRef):
    pass


class LanguageAtom(BaseModel):
    role: str
    content: str | None = None
    style: str | None = None
    timestamp: float
    # ``observation.images.*`` feature key for view-dependent atoms
    # (vqa / trace). ``None`` for camera-agnostic atoms. Mirrors the
    # row-level ``camera`` field added in lerobot PR 3467.
    camera: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class EpisodeAtomsPayload(BaseModel):
    repo_id: str | None = None
    local_path: str | None = None
    episode_index: int
    atoms: list[LanguageAtom] = []


class ExportRequest(DatasetRef):
    output_dir: str | None = None
    copy_videos: bool = False


class PushToHubRequest(DatasetRef):
    hf_token: str
    push_in_place: bool = True
    new_repo_id: str | None = None
    private: bool = False
    commit_message: str = "Add language annotations"


@dataclass
class EpisodeAnnotations:
    atoms: list[dict[str, Any]] = field(default_factory=list)


# --- Per-dataset state cache --------------------------------------------------


@dataclass
class DatasetState:
    repo_id: str | None
    local_path: str | None
    revision: str | None
    root: Path
    info: dict[str, Any]
    episodes_df: pd.DataFrame
    annotations: dict[int, EpisodeAnnotations] = field(default_factory=dict)
    frame_ts_cache: dict[int, list[float]] = field(default_factory=dict)

    @property
    def annotations_path(self) -> Path:
        return self.root / "meta" / "lerobot_annotations.json"


_states: dict[str, DatasetState] = {}


def _state_key(req: DatasetRef) -> str:
    if req.local_path:
        return f"local::{Path(req.local_path).expanduser().resolve()}"
    if req.repo_id:
        return f"hf::{req.repo_id}@{req.revision or 'main'}"
    raise HTTPException(status_code=400, detail="need repo_id or local_path")


def _ensure_state(req: DatasetRef) -> DatasetState:
    key = _state_key(req)
    if key in _states:
        return _states[key]
    return _load_state(req, key)


def _load_state(req: DatasetRef, key: str) -> DatasetState:
    if req.local_path:
        root = Path(req.local_path).expanduser().resolve()
        if not root.exists():
            raise HTTPException(status_code=404, detail=f"Dataset path not found: {root}")
    elif req.repo_id:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        slug = req.repo_id.replace("/", "__") + (f"@{req.revision}" if req.revision else "")
        root = CACHE_ROOT / slug
        root.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            req.repo_id,
            repo_type="dataset",
            revision=req.revision,
            local_dir=root,
            allow_patterns=["meta/*"],
        )
    else:
        raise HTTPException(status_code=400, detail="need repo_id or local_path")

    info_path = root / "meta" / "info.json"
    if not info_path.exists():
        raise HTTPException(status_code=404, detail=f"Missing meta/info.json at {root}")
    info = json.loads(info_path.read_text())

    episodes_root = root / "meta" / "episodes"
    if not episodes_root.exists():
        raise HTTPException(status_code=404, detail="Missing meta/episodes/ directory")
    files = sorted(episodes_root.rglob("*.parquet"))
    if not files:
        raise HTTPException(status_code=404, detail="No episodes parquet files found")
    episodes_df = (
        pd.concat([pd.read_parquet(p) for p in files], ignore_index=True)
        .sort_values("episode_index")
        .reset_index(drop=True)
    )

    state = DatasetState(
        repo_id=req.repo_id,
        local_path=str(root) if req.local_path else None,
        revision=req.revision,
        root=root,
        info=info,
        episodes_df=episodes_df,
    )
    _load_existing_annotations(state)
    _states[key] = state
    return state


def _load_existing_annotations(state: DatasetState) -> None:
    path = state.annotations_path
    if not path.exists():
        return
    data = json.loads(path.read_text())
    for ep_str, payload in data.get("episodes", {}).items():
        ep_idx = int(ep_str)
        atoms = payload.get("atoms")
        if atoms is None:
            # v1 format from older lerobot-annotate (legacy)
            atoms = []
            for seg in payload.get("subtasks", []):
                if "label" in seg and "start" in seg:
                    atoms.append(
                        {
                            "role": "assistant",
                            "content": str(seg["label"]),
                            "style": "subtask",
                            "timestamp": float(seg["start"]),
                            "tool_calls": None,
                        }
                    )
            for seg in payload.get("high_levels", []):
                ts = float(seg.get("start", 0.0))
                if seg.get("user_prompt"):
                    atoms.append(
                        {
                            "role": "user",
                            "content": str(seg["user_prompt"]),
                            "style": "interjection",
                            "timestamp": ts,
                            "tool_calls": None,
                        }
                    )
                if seg.get("robot_utterance"):
                    atoms.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "style": None,
                            "timestamp": ts,
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "function": {
                                        "name": "say",
                                        "arguments": {"text": str(seg["robot_utterance"])},
                                    },
                                }
                            ],
                        }
                    )
        state.annotations[ep_idx] = EpisodeAnnotations(atoms=[dict(a) for a in atoms])


def _save_annotations(state: DatasetState) -> None:
    path = state.annotations_path
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 2,
        "schema": {
            "persistent_styles": sorted(PERSISTENT_STYLES),
            "event_styles": sorted(EVENT_ONLY_STYLES),
        },
        "episodes": {str(ep): {"atoms": ann.atoms} for ep, ann in state.annotations.items()},
    }
    path.write_text(json.dumps(payload, indent=2))


# --- Frame-timestamp helpers --------------------------------------------------


def _episode_data_path(state: DatasetState, episode_index: int) -> Path | None:
    rows = state.episodes_df[state.episodes_df["episode_index"] == episode_index]
    if rows.empty:
        return None
    row = rows.iloc[0]
    chunk_col = "data/chunk_index"
    file_col = "data/file_index"
    if chunk_col not in row or file_col not in row:
        return None
    chunk_index = int(row[chunk_col])
    file_index = int(row[file_col])
    rel = state.info.get("data_path") or "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
    rel = rel.format(chunk_index=chunk_index, file_index=file_index)
    full = (state.root / rel).resolve()
    if full.exists():
        return full
    if state.repo_id:
        try:
            hf_hub_download(
                repo_id=state.repo_id,
                repo_type="dataset",
                filename=rel,
                revision=state.revision,
                local_dir=state.root,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("frame_ts download failed for ep %s: %s", episode_index, e)
            return None
    return full if full.exists() else None


def _frame_timestamps(state: DatasetState, episode_index: int) -> list[float]:
    if episode_index in state.frame_ts_cache:
        return state.frame_ts_cache[episode_index]
    path = _episode_data_path(state, episode_index)
    if path is None:
        return []
    try:
        df = pd.read_parquet(path, columns=["episode_index", "timestamp"])
    except Exception as e:  # noqa: BLE001
        logger.warning("frame_ts read failed for ep %s: %s", episode_index, e)
        return []
    ts = df.loc[df["episode_index"] == episode_index, "timestamp"].astype(float).tolist()
    ts.sort()
    state.frame_ts_cache[episode_index] = ts
    return ts


def _coerce_existing_atom(
    raw: Any, fallback_ts: float | None = None
) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        try:
            raw = dict(raw)
        except Exception:  # noqa: BLE001
            return None
    if not raw.get("role"):
        return None
    tool_calls = raw.get("tool_calls")
    if tool_calls is not None and not isinstance(tool_calls, list):
        tool_calls = [tool_calls]
    camera = raw.get("camera")
    if isinstance(camera, str) and not camera:
        camera = None
    raw_ts = raw.get("timestamp")
    if raw_ts is None:
        # v3.1 event rows don't carry a ``timestamp`` field in the struct —
        # the writer drops it because the parquet row's frame timestamp is
        # already the event's firing time. Use the caller-provided fallback
        # so dedup doesn't collapse every event atom into one (timestamp=0.0)
        # entry.
        timestamp = float(fallback_ts) if fallback_ts is not None else 0.0
    else:
        timestamp = float(raw_ts)
    return {
        "role": str(raw["role"]),
        "content": None if raw.get("content") is None else str(raw.get("content")),
        "style": raw.get("style"),
        "timestamp": timestamp,
        "camera": camera if isinstance(camera, str) else None,
        "tool_calls": tool_calls or None,
    }


def _extract_existing_atoms_from_table(table: pa.Table, episode_index: int) -> list[dict[str, Any]]:
    if "episode_index" not in table.column_names:
        return []

    episode_col = table.column("episode_index").to_pylist()
    persistent_col = (
        table.column(LANGUAGE_PERSISTENT).to_pylist()
        if LANGUAGE_PERSISTENT in table.column_names
        else None
    )
    events_col = (
        table.column(LANGUAGE_EVENTS).to_pylist()
        if LANGUAGE_EVENTS in table.column_names
        else None
    )
    # Event rows don't carry their own ``timestamp`` in the v3.1 struct;
    # the parquet row's frame timestamp IS the event's firing time. Read
    # the timestamp column so we can pass it as a fallback to
    # ``_coerce_existing_atom`` — without this, every event row defaults
    # to timestamp=0.0 and dedup collapses them all into one.
    ts_col = (
        table.column("timestamp").to_pylist()
        if "timestamp" in table.column_names
        else None
    )

    atoms: list[dict[str, Any]] = []
    seen: set[str] = set()
    persistent_loaded = False

    def add_many(raw_atoms: Any, fallback_ts: float | None = None) -> None:
        if not raw_atoms:
            return
        for raw in raw_atoms:
            atom = _coerce_existing_atom(raw, fallback_ts=fallback_ts)
            if atom is None:
                continue
            key = json.dumps(atom, sort_keys=True, default=str)
            if key in seen:
                continue
            seen.add(key)
            atoms.append(atom)

    for row_idx, ep_value in enumerate(episode_col):
        if int(ep_value) != int(episode_index):
            continue
        if persistent_col is not None and not persistent_loaded:
            add_many(persistent_col[row_idx])
            persistent_loaded = True
        if events_col is not None:
            row_ts = float(ts_col[row_idx]) if ts_col is not None else None
            add_many(events_col[row_idx], fallback_ts=row_ts)

    atoms.sort(key=lambda a: (a["timestamp"], a.get("style") or "", a.get("role") or ""))
    return atoms


def _snap(ts: float, frame_ts: list[float]) -> float:
    if not frame_ts:
        return float(ts)
    return float(min(frame_ts, key=lambda f: abs(f - ts)))


VIEW_DEPENDENT_STYLES = {"vqa", "trace"}


def _validate_atom(atom: dict[str, Any]) -> None:
    style = atom.get("style")
    if style is not None and style not in KNOWN_STYLES:
        raise HTTPException(status_code=400, detail=f"Unknown language style: {style!r}")
    has_content = atom.get("content") is not None
    has_tools = bool(atom.get("tool_calls"))
    if not (has_content or has_tools):
        raise HTTPException(status_code=400, detail="atom must have content or tool_calls")
    if style is None and not has_tools:
        raise HTTPException(status_code=400, detail="style=None requires tool_calls (speech atom)")
    camera = atom.get("camera")
    if camera is not None and not isinstance(camera, str):
        raise HTTPException(status_code=400, detail="camera must be a string or null")
    # Mirror lerobot's row-level invariant: camera is set iff the style is
    # view-dependent. We don't enforce camera-required here because the
    # visualizer accepts in-progress edits where the user hasn't picked a
    # camera yet — the writer (or the next save round-trip) will surface
    # the missing tag. We DO reject camera-on-non-view-dependent so the
    # field can't drift onto subtask/plan/memory rows.
    if (
        camera is not None
        and style is not None
        and style not in VIEW_DEPENDENT_STYLES
    ):
        raise HTTPException(
            status_code=400,
            detail=f"camera must be null for style={style!r} (only vqa/trace are view-dependent)",
        )


def _normalize_atom(atom: dict[str, Any]) -> dict[str, Any]:
    camera = atom.get("camera")
    if isinstance(camera, str) and not camera:
        camera = None
    return {
        "role": str(atom["role"]),
        "content": None if atom.get("content") is None else str(atom["content"]),
        "style": atom.get("style"),
        "timestamp": float(atom.get("timestamp", 0.0)),
        "camera": camera if isinstance(camera, str) else None,
        "tool_calls": list(atom["tool_calls"]) if atom.get("tool_calls") else None,
    }


# --- Export -------------------------------------------------------------------


def _materialize_table(table: pa.Table, atoms_by_ep: dict[int, list[dict[str, Any]]]) -> tuple[pa.Table, int, int]:
    if "episode_index" not in table.column_names or "timestamp" not in table.column_names:
        raise HTTPException(
            status_code=400,
            detail="data parquet missing 'episode_index' or 'timestamp' columns",
        )

    episode_col = table.column("episode_index").to_pylist()
    ts_col = [float(x) for x in table.column("timestamp").to_pylist()]
    n_rows = table.num_rows

    persistent_by_ep: dict[int, list[dict[str, Any]]] = {}
    events_by_ep_ts: dict[int, dict[float, list[dict[str, Any]]]] = {}

    n_persistent_total = 0
    n_event_total = 0

    unique_eps = sorted(set(episode_col))
    for ep_idx in unique_eps:
        atoms = atoms_by_ep.get(int(ep_idx))
        if atoms is None:
            atoms = _extract_existing_atoms_from_table(table, int(ep_idx))
        persistent_rows: list[dict[str, Any]] = []
        event_rows: list[dict[str, Any]] = []
        frame_ts = sorted({ts_col[i] for i in range(n_rows) if episode_col[i] == ep_idx})

        for atom in atoms:
            normalized = _normalize_atom(atom)
            col = column_for_style(atom.get("style"))
            if col == LANGUAGE_PERSISTENT:
                persistent_rows.append(normalized)
            else:
                if frame_ts:
                    normalized["timestamp"] = _snap(normalized["timestamp"], frame_ts)
                event_rows.append(normalized)

        persistent_rows.sort(
            key=lambda r: (r["timestamp"], r.get("style") or "", r.get("role") or "")
        )
        persistent_by_ep[ep_idx] = persistent_rows

        buckets: dict[float, list[dict[str, Any]]] = {}
        for r in event_rows:
            buckets.setdefault(r["timestamp"], []).append(r)
        for ts in buckets:
            buckets[ts].sort(key=lambda r: (r.get("style") or "", r.get("role") or ""))
        events_by_ep_ts[ep_idx] = buckets

        n_persistent_total += len(persistent_rows)
        n_event_total += sum(len(v) for v in buckets.values())

    per_row_persistent = [persistent_by_ep.get(episode_col[i], []) for i in range(n_rows)]
    per_row_events = [
        events_by_ep_ts.get(episode_col[i], {}).get(ts_col[i], []) for i in range(n_rows)
    ]

    keep_names: list[str] = []
    keep_cols: list[Any] = []
    for name in table.column_names:
        if name == "subtask_index":
            continue
        if name in {LANGUAGE_PERSISTENT, LANGUAGE_EVENTS, "tools"}:
            continue
        keep_names.append(name)
        keep_cols.append(table.column(name))

    persistent_arr = pa.array(per_row_persistent)
    events_arr = pa.array(per_row_events)
    tools_json = json.dumps([SAY_TOOL_SCHEMA], sort_keys=True)
    tools_arr = pa.array([tools_json] * n_rows, type=pa.string())

    new_names = keep_names + [LANGUAGE_PERSISTENT, LANGUAGE_EVENTS, "tools"]
    new_cols = keep_cols + [persistent_arr, events_arr, tools_arr]
    return pa.Table.from_arrays(new_cols, names=new_names), n_persistent_total, n_event_total


def _do_export(state: DatasetState, output_dir: str | None, copy_videos: bool) -> dict[str, Any]:
    if output_dir:
        out_root = Path(output_dir).expanduser().resolve()
    else:
        EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
        name = (state.repo_id or Path(state.root).name or "dataset").replace("/", "__")
        out_root = EXPORT_ROOT / f"{name}_annotated"

    out_root.mkdir(parents=True, exist_ok=True)

    # Copy meta/
    src_meta = state.root / "meta"
    dst_meta = out_root / "meta"
    if dst_meta.exists():
        shutil.rmtree(dst_meta)
    shutil.copytree(src_meta, dst_meta)

    info_path = dst_meta / "info.json"
    info = json.loads(info_path.read_text())
    info.setdefault("features", {})
    info["features"].pop("subtask_index", None)
    info["features"][LANGUAGE_PERSISTENT] = {"dtype": "language", "shape": [1], "names": None}
    info["features"][LANGUAGE_EVENTS] = {"dtype": "language", "shape": [1], "names": None}
    info["features"]["tools"] = {"dtype": "string", "shape": [1], "names": None}
    info_path.write_text(json.dumps(info, indent=2))

    # Drop legacy meta files if present
    for legacy in ("subtasks.parquet", "tasks_high_level.parquet"):
        p = dst_meta / legacy
        if p.exists():
            p.unlink()

    # Make sure data is downloaded for HF datasets
    data_dir = state.root / "data"
    data_files = sorted(data_dir.rglob("*.parquet"))
    if not data_files and state.repo_id:
        snapshot_download(
            state.repo_id,
            repo_type="dataset",
            revision=state.revision,
            local_dir=state.root,
            allow_patterns=["data/**/*.parquet"],
        )
        data_files = sorted(data_dir.rglob("*.parquet"))
    if not data_files:
        raise HTTPException(status_code=404, detail="No data parquet files found")

    atoms_by_ep = {ep: ann.atoms for ep, ann in state.annotations.items()}

    n_persistent = 0
    n_events = 0
    for src_path in data_files:
        rel_path = src_path.relative_to(state.root)
        dst_path = out_root / rel_path
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        table = pq.read_table(src_path)
        new_table, np_n, ne_n = _materialize_table(table, atoms_by_ep)
        n_persistent += np_n
        n_events += ne_n
        pq.write_table(new_table, dst_path)

    src_videos = state.root / "videos"
    dst_videos = out_root / "videos"
    if src_videos.exists():
        if dst_videos.exists():
            shutil.rmtree(dst_videos)
        if copy_videos:
            shutil.copytree(src_videos, dst_videos)
        else:
            try:
                os.symlink(src_videos, dst_videos)
            except OSError:
                shutil.copytree(src_videos, dst_videos)

    return {"output_dir": str(out_root), "persistent_rows": n_persistent, "event_rows": n_events}


# --- FastAPI app --------------------------------------------------------------

app = FastAPI(title="LeRobot dataset visualizer — annotation backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "service": "lerobot-visualizer-annotate",
            "persistent_styles": sorted(PERSISTENT_STYLES),
            "event_styles": sorted(EVENT_ONLY_STYLES),
        }
    )


@app.post("/api/dataset/load")
def load_dataset(req: LoadRequest) -> JSONResponse:
    state = _ensure_state(req)
    return JSONResponse(
        {
            "repo_id": state.repo_id,
            "local_path": state.local_path,
            "revision": state.revision,
            "root": str(state.root),
            "fps": float(state.info.get("fps", 30)),
            "num_episodes": int(state.episodes_df["episode_index"].nunique()),
            "persistent_styles": sorted(PERSISTENT_STYLES),
            "event_styles": sorted(EVENT_ONLY_STYLES),
        }
    )


@app.get("/api/episodes/{episode_index}/atoms")
def get_episode_atoms(
    episode_index: int,
    repo_id: str | None = None,
    revision: str | None = None,
    local_path: str | None = None,
) -> JSONResponse:
    state = _ensure_state(DatasetRef(repo_id=repo_id, revision=revision, local_path=local_path))
    ann = state.annotations.get(episode_index)
    if ann is None:
        path = _episode_data_path(state, episode_index)
        atoms: list[dict[str, Any]] = []
        if path is not None:
            try:
                schema = pq.read_schema(path)
                columns = ["episode_index"]
                # Always pull the row timestamp — needed as a fallback for
                # event rows whose v3.1 struct intentionally omits it.
                if "timestamp" in schema.names:
                    columns.append("timestamp")
                if LANGUAGE_PERSISTENT in schema.names:
                    columns.append(LANGUAGE_PERSISTENT)
                if LANGUAGE_EVENTS in schema.names:
                    columns.append(LANGUAGE_EVENTS)
                if (
                    LANGUAGE_PERSISTENT in columns
                    or LANGUAGE_EVENTS in columns
                ):
                    atoms = _extract_existing_atoms_from_table(
                        pq.read_table(path, columns=columns),
                        episode_index,
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning("language column read failed for ep %s: %s", episode_index, e)
        ann = EpisodeAnnotations(atoms=atoms)
        if atoms:
            state.annotations[episode_index] = ann
    return JSONResponse({"episode_index": episode_index, "atoms": ann.atoms})


@app.post("/api/episodes/{episode_index}/atoms")
def set_episode_atoms(episode_index: int, payload: EpisodeAtomsPayload) -> JSONResponse:
    if episode_index != payload.episode_index:
        raise HTTPException(status_code=400, detail="episode index mismatch")
    state = _ensure_state(DatasetRef(repo_id=payload.repo_id, local_path=payload.local_path))
    atoms = [a.dict() for a in payload.atoms]
    for atom in atoms:
        _validate_atom(atom)
    # Snap event timestamps to exact frame timestamps (matches lerobot#3471).
    frame_ts = _frame_timestamps(state, episode_index)
    for atom in atoms:
        if column_for_style(atom.get("style")) == LANGUAGE_EVENTS and frame_ts:
            atom["timestamp"] = _snap(float(atom["timestamp"]), frame_ts)
    state.annotations[episode_index] = EpisodeAnnotations(atoms=atoms)
    _save_annotations(state)
    return JSONResponse({"ok": True, "saved": len(atoms)})


@app.get("/api/episodes/{episode_index}/frame_timestamps")
def episode_frame_timestamps(
    episode_index: int,
    repo_id: str | None = None,
    revision: str | None = None,
    local_path: str | None = None,
) -> JSONResponse:
    state = _ensure_state(DatasetRef(repo_id=repo_id, revision=revision, local_path=local_path))
    ts = _frame_timestamps(state, episode_index)
    return JSONResponse({"episode_index": episode_index, "timestamps": ts})


@app.post("/api/export")
def export_dataset(req: ExportRequest) -> JSONResponse:
    state = _ensure_state(req)
    return JSONResponse(_do_export(state, req.output_dir, req.copy_videos))


@app.post("/api/push_to_hub")
def push_to_hub(req: PushToHubRequest) -> JSONResponse:
    state = _ensure_state(req)
    if not state.repo_id and not req.new_repo_id:
        raise HTTPException(status_code=400, detail="repo_id or new_repo_id required")

    # Ensure data + videos are present locally before exporting.
    if state.repo_id:
        snapshot_download(
            state.repo_id,
            repo_type="dataset",
            revision=state.revision,
            local_dir=state.root,
            allow_patterns=["data/**/*.parquet", "videos/**/*.mp4"],
        )
    export_result = _do_export(state, output_dir=None, copy_videos=True)
    export_dir = Path(export_result["output_dir"])

    target_repo = state.repo_id if req.push_in_place else req.new_repo_id
    if not target_repo:
        raise HTTPException(status_code=400, detail="No target repo")

    api = HfApi(token=req.hf_token)
    if not req.push_in_place:
        api.create_repo(
            repo_id=target_repo,
            repo_type="dataset",
            private=req.private,
            exist_ok=True,
        )
    api.upload_folder(
        folder_path=str(export_dir),
        repo_id=target_repo,
        repo_type="dataset",
        commit_message=req.commit_message,
    )
    return JSONResponse(
        {
            "ok": True,
            "repo_id": target_repo,
            "url": f"https://huggingface.co/datasets/{target_repo}",
            "message": f"Pushed annotated dataset to {target_repo}",
        }
    )

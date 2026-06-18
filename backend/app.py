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

import hashlib
import json
import logging
import math
import os
import shutil
import threading
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from pydantic import BaseModel

logger = logging.getLogger("lerobot-annotate")
logging.basicConfig(level=logging.INFO)

CACHE_ROOT = Path(os.environ.get("LEROBOT_ANNOTATE_CACHE", "/tmp/lerobot_visualizer_annotate_cache"))
EXPORT_ROOT = Path(os.environ.get("LEROBOT_ANNOTATE_EXPORT", "/tmp/lerobot_visualizer_annotate_exports"))
# Cache for transcoded copies of undecodable videos (e.g. gray12le depth),
# keyed by source identity so each shard transcodes once.
TRANSCODE_CACHE = Path(
    os.environ.get("LEROBOT_TRANSCODE_CACHE", "/tmp/lerobot_visualizer_transcode_cache")
)

# --- Schema mirrors src/lerobot/datasets/language.py --------------------------

PERSISTENT_STYLES = {"task_aug", "subtask", "plan", "memory"}
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
    # field can't drift onto task_aug/subtask/plan/memory rows.
    if (
        camera is not None
        and style is not None
        and style not in VIEW_DEPENDENT_STYLES
    ):
        raise HTTPException(
            status_code=400,
            detail=f"camera must be null for style={style!r} (only vqa/trace are view-dependent)",
        )


def _normalize_atom(atom: dict[str, Any], *, with_timestamp: bool) -> dict[str, Any]:
    """Coerce an atom into a language-column struct row.

    Field order matches the canonical schema in ``lerobot.datasets.language``
    (``PERSISTENT_ROW_FIELDS`` / ``EVENT_ROW_FIELDS``); pyarrow infers the
    struct schema from insertion order. Persistent rows carry their own
    ``timestamp`` (the moment the state became active); event rows do NOT —
    the parquet frame's ``timestamp`` column IS the event's firing time, so a
    per-row ``timestamp`` field would be redundant (matches lerobot#3471's
    ``language_event_row_arrow_type``, which omits it).
    """
    camera = atom.get("camera")
    if isinstance(camera, str) and not camera:
        camera = None
    row: dict[str, Any] = {
        "role": str(atom["role"]),
        "content": None if atom.get("content") is None else str(atom["content"]),
        "style": atom.get("style"),
    }
    if with_timestamp:
        row["timestamp"] = float(atom.get("timestamp", 0.0))
    row["camera"] = camera if isinstance(camera, str) else None
    row["tool_calls"] = list(atom["tool_calls"]) if atom.get("tool_calls") else None
    return row


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
        frame_ts = sorted({ts_col[i] for i in range(n_rows) if episode_col[i] == ep_idx})

        buckets: dict[float, list[dict[str, Any]]] = {}
        for atom in atoms:
            col = column_for_style(atom.get("style"))
            if col == LANGUAGE_PERSISTENT:
                persistent_rows.append(_normalize_atom(atom, with_timestamp=True))
            else:
                # The event row's firing time lives in the parquet frame's
                # ``timestamp`` column, so we bucket by the snapped timestamp
                # but do NOT store it inside the event struct (matches the
                # lerobot#3471 writer / canonical schema).
                ts = float(atom.get("timestamp", 0.0))
                if frame_ts:
                    ts = _snap(ts, frame_ts)
                buckets.setdefault(ts, []).append(_normalize_atom(atom, with_timestamp=False))

        persistent_rows.sort(
            key=lambda r: (r["timestamp"], r.get("style") or "", r.get("role") or "")
        )
        persistent_by_ep[ep_idx] = persistent_rows

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

    # NOTE: we deliberately do NOT add a per-row ``tools`` column. The ``say``
    # tool *schema* is dataset-level metadata and lives in
    # ``meta/info.json["tools"]`` (written in ``_do_export``), exactly as the
    # lerobot#3471 pipeline does. Tool *calls* travel per-row inside the
    # ``tool_calls`` field of the language structs. Any pre-existing ``tools``
    # column is stripped in the keep-loop above.
    new_names = keep_names + [LANGUAGE_PERSISTENT, LANGUAGE_EVENTS]
    new_cols = keep_cols + [persistent_arr, events_arr]
    return pa.Table.from_arrays(new_cols, names=new_names), n_persistent_total, n_event_total


def _materialize_tree(src: Path, dst: Path, *, force_copy: bool) -> None:
    """Recreate ``src`` under ``dst`` as real files (no symlinks).

    Hardlinks each file when ``force_copy`` is False and the source/target sit
    on the same filesystem (cheap, self-contained, uploadable); otherwise
    falls back to a byte copy. The result is always a standalone tree that
    survives being moved and is uploaded verbatim by ``upload_folder``.
    """

    def _copy_file(s: str, d: str) -> None:
        if not force_copy:
            try:
                os.link(s, d)
                return
            except OSError:
                pass
        shutil.copy2(s, d)

    shutil.copytree(src, dst, copy_function=_copy_file)


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
    # The ``say`` tool schema is dataset-level metadata, stored at the top of
    # info.json under "tools" (NOT as a per-frame feature). Mirrors the
    # lerobot#3471 pipeline's ``_ensure_annotation_metadata_in_info``: merge
    # additively so any user-declared tools are preserved, and stop emitting
    # the stray ``tools`` feature older exports added.
    info["features"].pop("tools", None)
    existing_tools = info.get("tools") or []
    tool_names = {
        (t.get("function") or {}).get("name") for t in existing_tools if isinstance(t, dict)
    }
    if SAY_TOOL_SCHEMA["function"]["name"] not in tool_names:
        info["tools"] = [*existing_tools, SAY_TOOL_SCHEMA]
    info_path.write_text(json.dumps(info, indent=2))

    # Drop legacy meta files if present
    for legacy in ("subtasks.parquet", "tasks_high_level.parquet"):
        p = dst_meta / legacy
        if p.exists():
            p.unlink()

    # Make sure data AND videos are downloaded for HF datasets. The export
    # must be a self-contained, loadable dataset (the writer only rewrites
    # the parquet shards; videos are carried over untouched), so we pull the
    # video shards too — otherwise the exported folder is missing the
    # observation videos and won't load. Mirrors the lerobot#3471 pipeline,
    # which annotates a full local snapshot in place.
    data_dir = state.root / "data"
    data_files = sorted(data_dir.rglob("*.parquet"))
    if not data_files and state.repo_id:
        snapshot_download(
            state.repo_id,
            repo_type="dataset",
            revision=state.revision,
            local_dir=state.root,
            allow_patterns=["data/**/*.parquet", "videos/**"],
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

    # Carry over the video shards so the export is self-contained. We
    # materialize *real* files (hardlink where the filesystem allows it, else
    # copy) rather than symlinking the source tree: a symlinked ``videos/``
    # breaks as soon as the folder is moved and is not uploaded by
    # ``HfApi.upload_folder``, which is exactly the "downloaded dataset isn't
    # usable" problem. ``copy_videos=True`` forces a full byte copy (used by
    # the push-to-hub path, where the upload reads the bytes anyway).
    src_videos = state.root / "videos"
    dst_videos = out_root / "videos"
    if src_videos.exists():
        if dst_videos.exists() or dst_videos.is_symlink():
            if dst_videos.is_symlink():
                dst_videos.unlink()
            else:
                shutil.rmtree(dst_videos)
        _materialize_tree(src_videos, dst_videos, force_copy=copy_videos)

    return {"output_dir": str(out_root), "persistent_rows": n_persistent, "event_rows": n_events}


# --- Video transcoding --------------------------------------------------------
#
# Browsers can't decode grayscale depth/IR sources (e.g. gray12le/gray16le).
# The frontend calls this endpoint as a fallback; only grayscale sources are
# transcoded — to yuv420p H.264 with a colormap, via in-process PyAV (no ffmpeg
# subprocess) — then cached on disk keyed by source identity and served with
# Range support. Every other source is served untouched.

# pseudocolor preset used to colorize grayscale depth/IR sources. Any preset the
# filter supports works (magma, inferno, plasma, viridis, turbo, cividis, ...).
DEPTH_COLORMAP = os.environ.get("LEROBOT_DEPTH_COLORMAP", "viridis")

# Colormap range source: "stats" spans meta/stats.json percentiles (high
# contrast); "fixed" spans the full encoded depth range from meta/info.json
# (consistent across datasets, lower contrast).
DEPTH_RANGE_MODE = os.environ.get("LEROBOT_DEPTH_RANGE", "stats").lower()

# Percentile keys driving the "stats" window (tighter = higher contrast).
_pctl = os.environ.get("LEROBOT_DEPTH_PCTL", "q10,q90").split(",")
DEPTH_PCTL_LOW = _pctl[0].strip() or "q10"
DEPTH_PCTL_HIGH = (_pctl[1].strip() if len(_pctl) > 1 else "q90") or "q90"

# Mixed into the cache key so a recipe change invalidates stale cached outputs.
TRANSCODE_RECIPE = (
    f"v3-h264-crf20-gray:{DEPTH_COLORMAP}:{DEPTH_RANGE_MODE}"
    f":{DEPTH_PCTL_LOW}-{DEPTH_PCTL_HIGH}"
)

# One lock per cache key so concurrent requests for a shard don't race.
_transcode_locks: dict[str, threading.Lock] = {}
_transcode_locks_guard = threading.Lock()


def _require_av():
    """Import PyAV lazily — only the transcode endpoint needs it."""
    try:
        import av

        return av
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="PyAV is not installed — run `pip install av` to enable "
            "video transcoding",
        )


def _lock_for(key: str) -> threading.Lock:
    with _transcode_locks_guard:
        lock = _transcode_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _transcode_locks[key] = lock
        return lock


def _resolve_video_source(
    repo_id: str | None,
    revision: str | None,
    local_path: str | None,
    rel_path: str,
    hf_token: str | None,
) -> Path:
    """Locate (downloading from HF if needed) the source video file."""
    rel = rel_path.lstrip("/")
    if not rel or ".." in Path(rel).parts:
        raise HTTPException(status_code=400, detail="invalid video path")

    if local_path:
        root = Path(local_path).expanduser().resolve()
        full = (root / rel).resolve()
        if not str(full).startswith(str(root)):
            raise HTTPException(status_code=400, detail="path escapes dataset root")
        if not full.exists():
            raise HTTPException(status_code=404, detail=f"video not found: {rel}")
        return full

    if repo_id:
        slug = repo_id.replace("/", "__") + (f"@{revision}" if revision else "")
        root = CACHE_ROOT / slug
        root.mkdir(parents=True, exist_ok=True)
        try:
            downloaded = hf_hub_download(
                repo_id=repo_id,
                repo_type="dataset",
                filename=rel,
                revision=revision,
                local_dir=root,
                token=hf_token or None,
            )
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=404, detail=f"could not fetch video: {e}")
        return Path(downloaded)

    raise HTTPException(status_code=400, detail="need repo_id or local_path")


# Cache of parsed meta/*.json so cache-hit requests don't re-read/re-HEAD.
_meta_cache: dict[tuple[str, str], dict[str, Any] | None] = {}
_meta_cache_guard = threading.Lock()


def _stat_scalar(value: Any) -> float | None:
    """Flatten lerobot's nested per-channel stat (e.g. [[[x]]]) to a scalar."""
    while isinstance(value, list):
        if not value:
            return None
        value = value[0]
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _load_meta_json(
    rel_name: str,
    repo_id: str | None,
    revision: str | None,
    local_path: str | None,
    hf_token: str | None,
) -> dict[str, Any] | None:
    """Load and cache a ``meta/<rel_name>`` JSON file for a dataset (or None)."""
    dataset = local_path or f"{repo_id}@{revision or 'main'}"
    cache_key = (rel_name, dataset)
    with _meta_cache_guard:
        if cache_key in _meta_cache:
            return _meta_cache[cache_key]

    data: dict[str, Any] | None = None
    try:
        if local_path:
            p = Path(local_path).expanduser().resolve() / "meta" / rel_name
            if p.exists():
                data = json.loads(p.read_text())
        elif repo_id:
            slug = repo_id.replace("/", "__") + (f"@{revision}" if revision else "")
            downloaded = hf_hub_download(
                repo_id=repo_id,
                repo_type="dataset",
                filename=f"meta/{rel_name}",
                revision=revision,
                local_dir=CACHE_ROOT / slug,
                token=hf_token or None,
            )
            data = json.loads(Path(downloaded).read_text())
    except Exception as e:  # noqa: BLE001
        logger.warning("could not load meta/%s (%s): %s", rel_name, dataset, e)
        data = None

    with _meta_cache_guard:
        _meta_cache[cache_key] = data
    return data


def _depth_feature_params(
    info: dict[str, Any] | None, rel_path: str
) -> dict[str, Any] | None:
    """Depth encoding params (lerobot#3253) for the feature in ``rel_path``, or None.

    Reads video.depth_min/depth_max (metres) and video.shift/use_log from
    meta/info.json.
    """
    features = (info or {}).get("features")
    if not isinstance(features, dict):
        return None
    key = _match_feature_key(features, rel_path)
    if not key:
        return None
    feature = features.get(key) or {}
    # Params live under "info", but tolerate them directly on the feature too.
    finfo = feature.get("info") if isinstance(feature.get("info"), dict) else feature
    dmin = _stat_scalar(finfo.get("video.depth_min"))
    dmax = _stat_scalar(finfo.get("video.depth_max"))
    if dmin is None or dmax is None:
        return None
    return {
        "depth_min": dmin,
        "depth_max": dmax,
        "shift": _stat_scalar(finfo.get("video.shift")) or 0.0,
        "use_log": bool(finfo.get("video.use_log", False)),
    }


def _encode_depth_norm(depth_m: float, params: dict[str, Any]) -> float | None:
    """Map a physical depth (metres) to lerobot's encoded code, normalized 0..1.

    Mirrors the shifted-log quantization (lerobot#3253) so a depth value lands in
    the encoded domain the colormap operates on; linear when use_log is False::

        norm = (ln(d + shift) - ln(dmin + shift))
               / (ln(dmax + shift) - ln(dmin + shift))
    """
    dmin = params.get("depth_min")
    dmax = params.get("depth_max")
    if dmin is None or dmax is None or dmax <= dmin:
        return None
    shift = params.get("shift") or 0.0
    d = min(max(depth_m, dmin), dmax)
    if params.get("use_log"):
        denom = math.log(dmax + shift) - math.log(dmin + shift)
        if denom <= 0:
            return None
        norm = (math.log(d + shift) - math.log(dmin + shift)) / denom
    else:
        norm = (d - dmin) / (dmax - dmin)
    return min(1.0, max(0.0, norm))


def _match_feature_key(stats: dict[str, Any], rel_path: str) -> str | None:
    """Stats feature key contained in the video path, preferring the longest match."""
    candidates = [k for k in stats if k and k in rel_path]
    return max(candidates, key=len) if candidates else None


def _depth_colormap_window(
    repo_id: str | None,
    revision: str | None,
    local_path: str | None,
    rel_path: str,
    hf_token: str | None,
) -> tuple[float, float] | None:
    """[low, high] colormap stretch window (0..1, encoded domain) for depth.

    In "stats" mode, percentiles from meta/stats.json (raw uint16 mm) are
    converted to metres and run through ``_encode_depth_norm`` into the code
    domain the colorlevels filter expects. Returns None (no stretch) in "fixed"
    mode or when metadata is missing/degenerate.
    """
    if DEPTH_RANGE_MODE != "stats":
        # Fixed mode: [depth_min, depth_max] == full encoded range, no stretch.
        return None

    info = _load_meta_json("info.json", repo_id, revision, local_path, hf_token)
    params = _depth_feature_params(info, rel_path)
    if not params:
        return None

    stats = _load_meta_json("stats.json", repo_id, revision, local_path, hf_token)
    if not stats:
        return None
    key = _match_feature_key(stats, rel_path)
    if not key:
        return None
    feature = stats[key]
    lo_mm = _stat_scalar(feature.get(DEPTH_PCTL_LOW))
    if lo_mm is None:
        lo_mm = _stat_scalar(feature.get("min"))
    hi_mm = _stat_scalar(feature.get(DEPTH_PCTL_HIGH))
    if hi_mm is None:
        hi_mm = _stat_scalar(feature.get("max"))
    if lo_mm is None or hi_mm is None:
        return None

    # Raw depth stats are uint16 millimetres; encode expects metres.
    low = _encode_depth_norm(lo_mm / 1000.0, params)
    high = _encode_depth_norm(hi_mm / 1000.0, params)
    if low is None or high is None or high <= low:
        return None
    return (low, high)


def _probe_video(src: Path) -> tuple[str | None, str | None]:
    """Read the first video stream's (codec_name, pixel format) — no decode."""
    av = _require_av()
    try:
        with av.open(str(src)) as container:
            streams = container.streams.video
            if not streams:
                return (None, None)
            stream = streams[0]
            codec = getattr(stream.codec_context, "name", None)
            try:
                pix_fmt = stream.format.name
            except Exception:  # noqa: BLE001
                pix_fmt = getattr(stream.codec_context, "pix_fmt", None)
            return (codec, pix_fmt)
    except Exception as e:  # noqa: BLE001
        logger.warning("video probe failed for %s: %s", src, e)
        return (None, None)


def _needs_transcode(pix_fmt: str | None) -> bool:
    """True only for grayscale depth/IR sources (e.g. gray12le); everything else
    is left for the browser to decode natively."""
    return (pix_fmt or "").startswith("gray")


def _transcode_cache_path(
    src: Path,
    codec: str | None,
    pix_fmt: str | None,
    window: tuple[float, float] | None,
) -> Path:
    st = src.stat()
    h = hashlib.sha256()
    h.update(str(src.resolve()).encode())
    h.update(str(st.st_size).encode())
    h.update(str(st.st_mtime_ns).encode())
    h.update((codec or "unknown").encode())
    h.update((pix_fmt or "unknown").encode())
    h.update(repr(window).encode())
    h.update(TRANSCODE_RECIPE.encode())
    return TRANSCODE_CACHE / f"{h.hexdigest()}.mp4"


def _build_depth_colormap_graph(av, in_stream, window: tuple[float, float] | None):
    """Colorize a grayscale depth stream: gbrp -> [colorlevels] -> pseudocolor
    -> yuv420p.

    gbrp is required because pseudocolor preserves the input format (gray in =>
    gray out) and it gives a fixed luma->0..255 mapping so gradients don't
    flicker. ``window`` (see ``_depth_colormap_window``) stretches the colormap
    over the depth range that actually occurs.
    """
    chain: list[tuple[str, str]] = [("format", "gbrp")]
    if window is not None:
        low, high = window
        chain.append(
            (
                "colorlevels",
                f"rimin={low:.6f}:rimax={high:.6f}:"
                f"gimin={low:.6f}:gimax={high:.6f}:"
                f"bimin={low:.6f}:bimax={high:.6f}",
            )
        )
    chain.append(("pseudocolor", f"preset={DEPTH_COLORMAP}"))
    chain.append(("format", "yuv420p"))

    graph = av.filter.Graph()
    last = graph.add_buffer(template=in_stream)
    for name, args in chain:
        node = graph.add(name, args)
        last.link_to(node)
        last = node
    last.link_to(graph.add("buffersink"))
    graph.configure()
    return graph


def _transcode_to_web(
    src: Path,
    dst: Path,
    window: tuple[float, float] | None = None,
) -> None:
    """Colorize a grayscale depth source and write it as yuv420p H.264 at ``dst``,
    stretched to ``window`` when given."""
    av = _require_av()
    TRANSCODE_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".partial.mp4")

    try:
        # +faststart moves the moov atom to the front so the browser can begin
        # playback / seeking without downloading the whole file first.
        with av.open(str(src)) as in_container, av.open(
            str(tmp), mode="w", options={"movflags": "+faststart"}
        ) as out_container:
            in_streams = in_container.streams.video
            if not in_streams:
                raise HTTPException(status_code=400, detail="no video stream")
            in_stream = in_streams[0]
            in_stream.thread_type = "AUTO"

            rate = (
                in_stream.average_rate
                or in_stream.guessed_rate
                or Fraction(30, 1)
            )
            out_stream = out_container.add_stream("libx264", rate=rate)
            out_stream.width = in_stream.codec_context.width
            out_stream.height = in_stream.codec_context.height
            out_stream.pix_fmt = "yuv420p"
            out_stream.options = {"crf": "20", "preset": "veryfast"}

            graph = _build_depth_colormap_graph(av, in_stream, window)

            def encode_and_mux(frame) -> None:
                for packet in out_stream.encode(frame):
                    out_container.mux(packet)

            def drain_graph() -> None:
                # Pull every frame the graph can currently produce. EAGAIN
                # (needs more input) and EOF surface as the builtin
                # BlockingIOError / EOFError, which PyAV's errors subclass.
                while True:
                    try:
                        encode_and_mux(graph.pull())
                    except (BlockingIOError, EOFError):
                        return

            for frame in in_container.decode(in_stream):
                graph.push(frame)
                drain_graph()

            graph.push(None)  # flush the filter graph
            drain_graph()
            # Flush the encoder.
            for packet in out_stream.encode():
                out_container.mux(packet)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        logger.error("PyAV transcode failed for %s: %s", src, e)
        raise HTTPException(status_code=500, detail="video transcode failed")

    if not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="video transcode produced no output")

    # Atomic publish — readers only ever see a complete file.
    os.replace(tmp, dst)


def _ensure_web_playable(
    src: Path,
    *,
    repo_id: str | None = None,
    revision: str | None = None,
    local_path: str | None = None,
    rel_path: str = "",
    hf_token: str | None = None,
) -> Path:
    """Return a path to a browser-decodable copy of ``src`` (cached)."""
    codec, pix_fmt = _probe_video(src)
    if not _needs_transcode(pix_fmt):
        return src

    window = _depth_colormap_window(repo_id, revision, local_path, rel_path, hf_token)

    dst = _transcode_cache_path(src, codec, pix_fmt, window)
    if dst.exists() and dst.stat().st_size > 0:
        return dst

    with _lock_for(dst.name):
        # Re-check inside the lock: a concurrent request may have finished
        # the transcode while we were waiting.
        if dst.exists() and dst.stat().st_size > 0:
            return dst
        logger.info(
            "transcoding %s (codec=%s pix_fmt=%s window=%s) -> %s",
            src,
            codec,
            pix_fmt,
            window,
            dst.name,
        )
        _transcode_to_web(src, dst, window)
    return dst


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


@app.get("/api/video/transcode")
def transcode_video(
    path: str,
    repo_id: str | None = None,
    revision: str | None = None,
    local_path: str | None = None,
    hf_token: str | None = None,
) -> FileResponse:
    """Serve a browser-decodable copy of a dataset video.

    Grayscale depth sources are transcoded once and cached; everything else is
    streamed back untouched. FileResponse handles HTTP Range for seeking.
    """
    src = _resolve_video_source(repo_id, revision, local_path, path, hf_token)
    served = _ensure_web_playable(
        src,
        repo_id=repo_id,
        revision=revision,
        local_path=local_path,
        rel_path=path,
        hf_token=hf_token,
    )
    return FileResponse(served, media_type="video/mp4", filename=Path(path).name)


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
    return JSONResponse(
        {"ok": True, "saved": len(atoms), "path": str(state.annotations_path)}
    )


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

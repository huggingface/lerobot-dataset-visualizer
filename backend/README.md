# Annotations backend

FastAPI service that lets the visualizer write the LeRobot v3.1 language
schema (`language_persistent` + `language_events`) directly into
`data/chunk-*/file-*.parquet`. Mirrors the conventions of the steerable
annotation pipeline in [lerobot#3471](https://github.com/huggingface/lerobot/pull/3471):

- per-episode persistent identity (every frame in the episode sees the same
  `language_persistent` list)
- exact-frame timestamps for events (`language_events`)
- column routing per `column_for_style(style)` — `subtask`/`plan`/`memory`
  go to `language_persistent`, `interjection`/`vqa` and speech tool-call
  atoms (`style=null`) go to `language_events`
- dataset-level `tools` column carrying the JSON schema for the `say` tool
- legacy `subtask_index` column dropped

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 7861 --reload
```

### Video transcoding dependency (optional)

`/api/video/transcode` needs [PyAV](https://pyav.org) (`av` in
`requirements.txt`; its wheels bundle FFmpeg). Without it the endpoint returns
503 and the rest of the backend is unaffected.

Then start the Next.js visualizer with the backend URL configured:

```bash
NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
```

## API

| Method | Path                                  | Purpose                                                                                                 |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                         | Liveness + style catalog                                                                                |
| POST   | `/api/dataset/load`                   | Cache + read a dataset's `meta/`                                                                        |
| GET    | `/api/episodes/{ep}/atoms`            | Read saved atoms                                                                                        |
| POST   | `/api/episodes/{ep}/atoms`            | Write atoms (event timestamps are snapped to exact frame timestamps)                                    |
| GET    | `/api/episodes/{ep}/frame_timestamps` | Frame timestamps for client-side snapping                                                               |
| GET    | `/api/video/transcode`                | Serve a browser-decodable copy of a video (transcodes + caches grayscale depth sources like `gray12le`) |
| POST   | `/api/export`                         | Rewrite parquet shards into a new directory                                                             |
| POST   | `/api/push_to_hub`                    | Export and push to a target repo                                                                        |

### Video transcoding

Browsers can't decode grayscale depth/IR sources (`gray12le`/`gray16le`). The
frontend calls `/api/video/transcode` for likely-depth cameras (key contains
`depth`) proactively — they'd otherwise decode as flat grayscale without
erroring — and as a fallback when any `<video>` fails to decode. Only grayscale
sources are transcoded: once to `yuv420p` H.264 with the **viridis** colormap
(FFmpeg `pseudocolor`), cached on disk keyed by source identity and served with
HTTP Range support. Everything else is served untouched. Override the colormap
with `LEROBOT_DEPTH_COLORMAP` (any `pseudocolor` preset).

The colormap range comes from the depth quantization params in `meta/info.json`
(`video.depth_min/max/shift/use_log`, lerobot#3253), selected by
`LEROBOT_DEPTH_RANGE`:

- `stats` (default): span percentiles from `meta/stats.json`
  (`LEROBOT_DEPTH_PCTL`, default `q10,q90`) for high contrast.
- `fixed`: span the full depth range — consistent across datasets, lower
  contrast.

Falls back to a full-range colormap when the metadata is missing.

## Storage layout

Annotations are persisted to `<dataset_root>/meta/lerobot_annotations.json`,
v2 schema:

```json
{
  "version": 2,
  "schema": {
    "persistent_styles": ["memory", "plan", "subtask"],
    "event_styles": ["interjection", "vqa"]
  },
  "episodes": {
    "0": {
      "atoms": [
        {
          "role": "assistant",
          "content": "grasp the sponge",
          "style": "subtask",
          "timestamp": 0.0,
          "tool_calls": null
        }
      ]
    }
  }
}
```

The legacy v1 layout (`subtasks`/`high_levels` from earlier `lerobot-annotate`)
is auto-migrated on load.

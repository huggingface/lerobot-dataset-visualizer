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

The video transcode endpoint (`/api/video/transcode`) uses
[PyAV](https://pyav.org) (in-process FFmpeg bindings) — installed via
`requirements.txt` as `av`. PyAV's wheels bundle FFmpeg, so there's no separate
system install. If `av` is not installed, the endpoint returns HTTP 503 and the
rest of the backend works normally.

Then start the Next.js visualizer with the backend URL configured:

```bash
NEXT_PUBLIC_ANNOTATE_BACKEND_URL=http://127.0.0.1:7861 bun run dev
```

## API

| Method | Path                                  | Purpose                                                                                               |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                         | Liveness + style catalog                                                                              |
| POST   | `/api/dataset/load`                   | Cache + read a dataset's `meta/`                                                                      |
| GET    | `/api/episodes/{ep}/atoms`            | Read saved atoms                                                                                      |
| POST   | `/api/episodes/{ep}/atoms`            | Write atoms (event timestamps are snapped to exact frame timestamps)                                  |
| GET    | `/api/episodes/{ep}/frame_timestamps` | Frame timestamps for client-side snapping                                                             |
| GET    | `/api/video/transcode`                | Serve a browser-decodable copy of a video (transcodes + caches non-`yuv420p` sources like `gray12le`) |
| POST   | `/api/export`                         | Rewrite parquet shards into a new directory                                                           |
| POST   | `/api/push_to_hub`                    | Export and push to a target repo                                                                      |

### Video transcoding

Browsers can only decode 8-bit 4:2:0 (`yuv420p`) via the `<video>` element, so
depth/IR cameras stored as `gray12le`/`gray16le` (or other exotic pixel
formats) won't play. The frontend streams videos directly from Hugging Face and
calls `/api/video/transcode` in two cases: **proactively** for likely-depth
cameras (key contains `depth`) — since some browsers decode those natively as
flat grayscale, an error would never fire — and as a **fallback** for any other
camera whose `<video>` element fails to decode (e.g. AV1 in Safari). The
endpoint probes the source codec + pixel format with PyAV, serves it untouched
only if it's already H.264 + yuv420p, otherwise transcodes once to
`yuv420p` H.264 (in-process, via PyAV) and caches the result on disk (keyed by
source path + size + mtime + pixel format). Subsequent loads and seeks hit the
cached file with full HTTP Range support, so playback is as fast as any normal
video after the one-time conversion. Grayscale depth/IR formats are colorized
with the **viridis** colormap (via FFmpeg's `pseudocolor` filter) for
readability, using a fixed, temporally stable range mapping rather than
per-frame normalization (which would flicker). Override the colormap with the
`LEROBOT_DEPTH_COLORMAP` env var (any `pseudocolor` preset: `magma`, `inferno`,
`plasma`, `viridis`, `turbo`, `cividis`, ...).

The colormap range is derived from the depth **quantization parameters** in
`meta/info.json` (`video.depth_min`, `video.depth_max`, `video.shift`,
`video.use_log` — lerobot's per-key depth encoding, lerobot#3253). The video
codes are a shifted-log quantization of physical depth over `[depth_min,
depth_max]`, so any chosen depth window is run back through that same encode
(`_encode_depth_norm`) to land in the encoded code domain the `colorlevels`
filter operates on. Two modes via `LEROBOT_DEPTH_RANGE`:

- `stats` (default): span percentiles from `meta/stats.json` (which low/high
  percentile keys is set by `LEROBOT_DEPTH_PCTL`, default `q10,q90`; use
  `q01,q99` for a wider window). Those stats are computed on the **raw uint16
  depth in millimetres** (a different domain from the log-quantized video
  pixels), so they're converted to metres and re-encoded before being used as
  the stretch window — this spreads the colormap across the depth values that
  actually occur (high contrast) while keeping pixel values meaningful. (Earlier
  versions normalized the raw-mm percentiles by `2**bits - 1` directly, which
  mixed the raw and encoded domains.)
- `fixed`: span the full `[depth_min, depth_max]` range. That encodes to the
  full code range, so colors are **consistent across episodes/datasets** but
  lower-contrast; no stretch is applied.

If the encoding metadata is unavailable, it falls back to a full-range colormap.

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

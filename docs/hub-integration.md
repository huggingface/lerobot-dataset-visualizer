# Multiple LeRobot datasets per repository

## Goal

Select and visualize a LeRobot dataset stored below the repo root, with root
behavior as the default. Public example:
[`lerobot/community_dataset_v3`](https://huggingface.co/datasets/lerobot/community_dataset_v3),
directory `00ri/so100_battery`.

## Implemented

- **huggingface.js:** `LeRobotDataset(repoId, { path })` prefixes metadata,
  episode indexes, parquet and video URLs. Supports v2.0, v2.1 and v3.0;
  validates directories and keeps each instance's caches separate.
- **Visualizer:** `?path=00ri/so100_battery` selects the directory and persists
  through episode navigation, sharing, analysis and 3D Replay. Includes a
  directory input and isolates caches and browser annotations by directory.
  Uses an adapter until the library option is published.
- **Tests:** local fixtures cover all three versions, directory isolation,
  encoded names, links and v3 video offsets.

## Remaining Hub work

1. **Backend:** discover dataset roots, validate each `meta/info.json`, and
   return entries such as `{ configName, path, lerobot }` alongside the existing
   single-dataset props. Include the directory in preview requests and cache
   keys. Keep existing root detection.
2. **Svelte preview:** show a dataset selector when several entries exist.
   Changing it resets playback and loads that dataset's episodes, cameras,
   tasks and joints; cancel stale requests. Preserve v3 video offsets.
3. **Visualizer links:** keep the Space's existing route parameter and add the
   selected directory: `?path=/lerobot/community_dataset_v3/episode_0&datasetPath=00ri/so100_battery`.
4. **Release:** publish the library option, upgrade the viewer to use it, and
   deploy the updated Space. Neither fork changes the private Hub directly.

Suggested discovery convention: use the existing `configs[].data_dir` field as
the dataset root and keep `data_files` pointed at frame parquet:

```yaml
configs:
  - config_name: so100_battery
    data_dir: 00ri/so100_battery
    data_files: data/*/*.parquet
```

This is a proposed LeRobot detection rule for the Hub, not current preview
behavior. Do not point `data_files` at `info.json`. Repositories without configs
can be discovered from paths ending in `meta/info.json`, using a cached file
inventory rather than scanning all frame shards on every page load.

The optional annotation write backend and external LeRobot Doctor still need
subdirectory support. Nested datasets currently use browser session storage for
annotation edits, and Doctor is unavailable for them.

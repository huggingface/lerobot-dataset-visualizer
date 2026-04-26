# CLAUDE.md — LeRobot Dataset Visualizer

## Package manager

Always use **bun** (`bun install`, `bun dev`, `bun run build`, `bun test`). Never use npm or yarn.

## Post-process — run after every code change

After making any code changes, always run these commands in order and fix any errors before finishing:

```
bun run format        # auto-fix formatting (prettier)
bun run type-check    # TypeScript: app + test files
bun run lint          # ESLint (next lint)
bun test              # unit tests
```

Or run them all at once (format first, then the full validate suite):

```
bun run format && bun run validate
```

`bun run validate` runs: type-check → lint → format:check → test

## Key scripts

```
bun dev              # Next.js dev server
bun test             # Run all unit tests (bun:test)
bun run type-check   # tsc --noEmit (app) + tsc -p tsconfig.test.json --noEmit (tests)
bun run lint         # next lint
bun run validate     # type-check + lint + format:check
```

## Architecture

### Dataset version support

Three versions are supported. Version is detected from `meta/info.json` → `codebase_version`.

| Version  | Path pattern                                                      | Episode metadata                           | Video                                          |
| -------- | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| **v2.0** | `data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet`    | None (computed from `chunks_size`)         | Full file per episode                          |
| **v2.1** | Same as v2.0                                                      | None                                       | Full file per episode                          |
| **v3.0** | `data/chunk-{N:03d}/file-{N:03d}.parquet` (via `buildV3DataPath`) | `meta/episodes/chunk-{N}/file-{N}.parquet` | Segmented (timestamps per episode, per camera) |

### Routing to parsers

`src/app/[org]/[dataset]/[episode]/fetch-data.ts` → `getEpisodeData()` dispatches to:

- `getEpisodeDataV2()` for v2.0 and v2.1
- `getEpisodeDataV3()` for v3.0

### v3.0 specifics

- Episode metadata row has named keys (`episode_index`, `data/chunk_index`, `data/file_index`, `dataset_from_index`, `dataset_to_index`, `videos/{key}/chunk_index`, etc.)
- Integer columns from parquet come out as **BigInt** — always use `bigIntToNumber()` from `src/utils/typeGuards.ts`
- Row-range selection: `dataset_from_index` / `dataset_to_index` allow reading only the episode's rows from a shared parquet file
- Fallback format uses numeric keys `"0"`.."9"` when column names are unavailable
- Episode metadata can span **multiple chunks** (when episode count exceeds `chunks_size`). Always walk via the `iterateEpisodeMetadataFilesV3(repoId, version)` async generator in `fetch-data.ts` — it advances chunk-000 → chunk-001 → … and stops on the first missing `file-000`. Never hardcode `chunk-000`.
- Multi-task episodes: episode-metadata rows carry a `tasks` field (`list[str]`) — prefer it over the legacy single `task_index` lookup. `EpisodeMetadataV3.tasks?: string[]` exposes it.
- `meta/tasks.parquet` lookup: rows are **not** ordered by `task_index`, and the task string lives in a named pandas index (`__index_level_0__`). Always filter by the `task_index` **column** (`row.task_index === taskIndexNum`), never by row position.

### v2.x path construction

```ts
formatStringWithVars(info.data_path, {
  episode_chunk: Math.floor(episodeId / chunkSize)
    .toString()
    .padStart(3, "0"),
  episode_index: episodeId.toString().padStart(6, "0"),
});
// → "data/000/episode_000042.parquet"
```

`formatStringWithVars` strips `:03d` format specifiers — padding must be done by the caller.

## Key files

| File                                              | Purpose                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/[org]/[dataset]/[episode]/fetch-data.ts` | Main data-loading entry point; v2/v3 parsers; `computeColumnMinMax`                                                                      |
| `src/utils/versionUtils.ts`                       | `getDatasetInfo`, `getDatasetVersionAndInfo`, `buildVersionedUrl`                                                                        |
| `src/utils/stringFormatting.ts`                   | `buildV3DataPath`, `buildV3VideoPath`, `buildV3EpisodesMetadataPath`, padding helpers                                                    |
| `src/utils/parquetUtils.ts`                       | `fetchParquetFile`, `readParquetAsObjects`, `formatStringWithVars`                                                                       |
| `src/utils/dataProcessing.ts`                     | Chart grouping pipeline: `buildSuffixGroupsMap` → `computeGroupStats` → `groupByScale` → `flattenScaleGroups` → `processChartDataGroups` |
| `src/utils/typeGuards.ts`                         | `bigIntToNumber`, `isNumeric`, `isValidTaskIndex`, etc.                                                                                  |
| `src/utils/constants.ts`                          | `PADDING`, `EXCLUDED_COLUMNS`, `CHART_CONFIG`, `THRESHOLDS`                                                                              |
| `src/types/`                                      | TypeScript types: `DatasetVersion`, `EpisodeMetadataV3`, `VideoInfo`, `ChartDataGroup`, etc.                                             |

## Chart data pipeline

Series keys use `" | "` as delimiter (e.g. `observation.state | 0`).
`groupRowBySuffix` groups by **suffix**: if two different prefixes share suffix `"0"` (e.g. `observation.state | 0` and `action | 0`), they are merged under `result["0"] = { "observation.state": ..., "action": ... }`. A series with a unique suffix stays flat with its full original key.

## Testing

- Test files live in `**/__tests__/` directories alongside source
- Uses `bun:test` (built-in, no extra install)
- BigInt literals (`42n`) require `tsconfig.test.json` (target ES2020) — test files are excluded from `tsconfig.json`
- `@types/bun` is installed as a devDependency for `bun:test` type resolution
- Mocking fetch: `globalThis.fetch = mock(() => Promise.resolve(new Response(...))) as unknown as typeof fetch`
- CI: `.github/workflows/test.yml` runs `bun test` on push/PR to main

## URL structure

All dataset URLs:

```
https://huggingface.co/datasets/{org}/{dataset}/resolve/main/{path}
```

Built by `buildVersionedUrl(repoId, version, path)`. The `version` param is accepted but currently unused in the URL (always `main` revision).

## Excluded columns (not shown in charts)

Reserved/bookkeeping columns from lerobot — see `EXCLUDED_COLUMNS` in `src/utils/constants.ts`:

- v2.x: `timestamp`, `frame_index`, `episode_index`, `index`, `task_index`, `next.reward`, `next.done`, `next.truncated`
- v3.0: `index`, `task_index`, `episode_index`, `frame_index`, `next.reward`, `next.done`, `next.truncated`, `subtask_index`

## 3D URDF viewer (`src/components/urdf-viewer.tsx`)

- URDFs and meshes are hosted in the HF bucket `lerobot/robot-urdfs` — base URL `https://huggingface.co/buckets/lerobot/robot-urdfs/resolve` (no `/main` segment; buckets are unbranched). Override with `NEXT_PUBLIC_URDF_BASE_URL` for local development.
- Asset layout under the bucket: `g1/`, `openarm/`, `so101/` (both SO-100 and SO-101 live here).
- **URDFLoader gotcha**: after our `loadMeshCb` returns, `URDFLoader.js` does `if (obj instanceof THREE.Mesh) obj.material = <urdf-material>`, overwriting any material we set. Workaround: wrap the loaded mesh in a `THREE.Group` so the `instanceof Mesh` check fails. DAE returns a Group already; STL must be wrapped explicitly.
- **STLLoader event ordering**: `manager.itemEnd(url)` fires _before_ the user `onLoad` callback, so `manager.onLoad` can fire before meshes are attached to the robot tree. Defer post-load work (auto-fit camera, shadow flags) with `setTimeout(..., 0)`. Don't try to rebuild materials in `manager.onLoad` — pick the archetype color directly inside `loadMeshCb`.
- **OpenArm DAE files ship 23 stray `PointLight`s** that drown out scene lighting. Strip non-`AmbientLight` lights from `collada.scene` before adding it to the robot.
- Scene setup: `<Canvas shadows>` with `ACESFilmicToneMapping` (exposure 0.9), 3-point directional + ambient lights, `<Environment preset="studio" background={false} />`, `<color attach="background" args={["#1a2433"]} />`. `<OrbitControls makeDefault />` is required so `useThree().controls` exposes the controls for auto-fit.

## Design system

CSS tokens in `src/app/globals.css` (Tailwind v4 `@theme inline`):

- Surfaces: `--bg #0a0e17`, `--surface-0`, `--surface-1`, `--surface-2`
- Text: `--text-primary`, `--text-muted`, `--text-faint`
- Accent: `--accent #38bdf8` (cyan) — primary interactive color across UI
- Helpers: `.panel`, `.panel-raised`, `.tabular` (tabular-nums)
- **Color semantics**: cyan = primary/active, orange (`orange-400/500`) is reserved for **flagged-episode** UI only — don't reuse it for generic accents.

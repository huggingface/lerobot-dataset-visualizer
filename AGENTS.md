# AGENTS.md — LeRobot Dataset Visualizer

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
bun run validate     # type-check + lint + format:check + test
```

## Architecture

### Dataset version support

Three versions are supported. Version is detected from `meta/info.json` → `codebase_version`.

| Version  | Path pattern                                                   | Episode metadata                           | Video                                          |
| -------- | -------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| **v2.0** | `data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet` | None (computed from `chunks_size`)         | Full file per episode                          |
| **v2.1** | Same as v2.0                                                   | None                                       | Full file per episode                          |
| **v3.0** | `data/chunk-{N:03d}/file-{N:03d}.parquet`                      | `meta/episodes/chunk-{N}/file-{N}.parquet` | Segmented (timestamps per episode, per camera) |

### Routing to parsers

`src/app/[org]/[dataset]/[episode]/fetch-data.ts` → `getEpisodeData()` dispatches to:

- `getEpisodeDataV2()` for v2.0 and v2.1
- `getEpisodeDataV3()` for v3.0

### `@huggingface/lerobot`

Locating an episode (its video URLs and offsets, its data file and row range) and reading camera sizes go through [`@huggingface/lerobot`](https://github.com/huggingface/huggingface.js/tree/main/packages/lerobot). Don't build v3 data, video or episode-metadata paths by hand.

- Create datasets with `leRobotDataset(repoId)` in `fetch-data.ts`: it passes the `DATASET_URL` endpoint and `authHeaders()`.
- `episodes({ offset, limit })` reads the v3 episode index across every metadata chunk. `offset` is a position in the listing, not an `episode_index`.
- `episode.data.fromRow` / `toRow` are row offsets **inside `episode.data.url`**, not dataset-wide frame indexes. Pass them straight to `rowStart` / `rowEnd`; never subtract the file's first `index`. `episode.data` is optional: it is absent when the data file can't be read.
- Episode charts come from `frames()` (numeric and boolean series, bookkeeping columns left out). `loadEpisodeFrames` reads the task and language columns (`TEXT_COLUMNS`) from the same file alongside it, since `frames()` returns numbers only. hyparquet decodes a nested column for its whole row group, so a nested language column is left out past `MAX_NESTED_TEXT_VALUES` values.
- Camera sizes come from `parseInfo(...).cameras`. Never read them from `shape[0]` / `shape[1]`: some datasets declare channel-first shapes (`[3, H, W]`).
- To upgrade, bump the version in `package.json` and run `bun install`. Read the package's changes first: 0.0.4 changed what `fromRow` / `toRow` mean.

### v3.0 specifics

- Integer columns from parquet come out as **BigInt** — always use `bigIntToNumber()` from `src/utils/typeGuards.ts`
- Fallback format uses numeric keys `"0"`.."9"` when column names are unavailable
- Multi-task episodes: episodes carry a `tasks` list (`list[str]`) — prefer it over the legacy single `task_index` lookup. `EpisodeMetadataV3.tasks?: string[]` exposes it.
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

## Dataset-wide analyses

Episode lengths, the Frames listing and the cross-episode statistics describe the dataset, not the episode on screen.

- They load through `useCachedResource` into the `AsyncCache`s exported from `fetch-data.ts` (`episodeLengthsCache`, `episodeFramesCache`, `crossEpisodeCache`), keyed by `datasetCacheKey(repoId)`. The viewer remounts on every episode change; without the cache each analysis ran again. Add a new dataset-wide load the same way, never as component state.
- The cross-episode statistics are computed in `src/utils/crossEpisode.ts` (pure, tested) from flat `Float32Array`s; `loadCrossEpisodeActionVariance` only reads. It reads with `openParquetFile` + `readParquetColumnChunks`: no row objects, and nothing kept once the pass is over (`fetchParquetFile` keeps every byte for the life of the page).
- A v3.0 data file is read a row group at a time, so an episode costs its file. `planEpisodeSample` picks the files first, within `MAX_CROSS_EPISODE_BYTES`, then the episodes from them.
- Lag statistics (autocorrelation, state–action alignment) run on consecutive frames: at most `LAG_WINDOW_FRAMES` from the middle of a long episode. Never subsample frames for them: a lag across skipped frames is no longer in frames.

## Frames tab (`src/components/overview-panel.tsx`)

- Thumbnails come from `frameThumbnails()` (`src/utils/frameThumbnails.ts`): a few hidden `<video>` decoders shared by the page, one per file and at most six at once, each seeking from frame to frame and handing them back as cached canvases. Never mount a `<video>` per thumbnail: in v3.0 dozens of episodes share a file, and a page of 48 opened it 48 times.
- Seek inside a frame, not on its boundary: `loadAllEpisodeFrameInfo` gives `firstFrameTime` / `lastFrameTime` half a frame in from the episode's ends (`lastFrameTime: null` on v2.x means half a frame before the file's end). On the boundary the browser may show the neighbouring episode's frame.
- The videos are loaded without CORS: frames are drawn, never read back.

## Playback (`src/context/time-context.tsx`, `src/components/playback-bar.tsx`)

- `TimeProvider` takes the episode's `fps` and `frames` (its frame count). Pass the real count: on v2.x `duration` is the last frame's timestamp, one frame short of the episode.
- `stepFrames(n)` (from `useTimeControls`) pauses and moves `n` frames; the arithmetic is in `src/utils/playback.ts`. A step seeks a millisecond inside the frame, never onto the boundary between two, where the browser may show either.
- The end-of-episode loop in `SimpleVideosPlayer` only runs while playing. Paused, a seek or a step onto the last frames must show them.
- The playback speed lives in the time context and `sessionStorage`; `SimpleVideosPlayer` applies it to every camera, and as each video's default rate so it survives a reload of the video.
- Keys: Space plays and pauses; `←` `→` (or `,` `.`) step a frame, with Shift a second; `↑` `↓` change episode. The horizontal arrows are left to whatever is focused when it uses them itself (text fields, sliders, option groups).

## Viewer state

- The open tab is mirrored into `?tab=` (`searchWithTab`, the default Episodes tab is left out) with `replaceState`, so a link opens the same view and Back returns to an analysis tab after following an `EpisodeLink`. `sessionStorage` still carries the tab across sidebar navigation, whose links have no query.
- Flagged episodes are stored per dataset in `localStorage` (`src/utils/flaggedEpisodes.ts`); mount `FlaggedEpisodesProvider` with `key={repoId}`.

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

## 3D Replay viewer (`src/components/replay-viewer.tsx`)

- Every robot is a USD from the dataset [`lerobot/robot-usds`](https://huggingface.co/datasets/lerobot/robot-usds) (SO-100 uses SO-101's), loaded with `@huggingface/usd-web-viewer`; no URDF is involved. `getRobotConfig` picks it from `robot_type` and, for the G1's hands, the columns.
- The USD's UsdPhysics joints move it: `setJointPositions` takes them by prim path, in degrees for revolute joints and meters for prismatic ones (the joint values here are radians), and throws on a value that isn't finite. Mimic joints (OpenArm's second finger, the Inspire fingers' outer joints) follow their joint, so they are left out of the mapping.
- Joints are mapped by name, the last segment of their prim path. The trails follow `getWorldMatrix` at a frame, body or mesh found by name (`gripper_frame_link`, `openarm_*_hand_tcp`, the G1's palms or hand bases).
- New robots or fixes go into `lerobot/robot-usds` with its `scripts/`, not here.
- Scene setup: `<Canvas shadows>` with `ACESFilmicToneMapping` (exposure 0.9), 3-point directional + ambient lights, `<Environment preset="studio" background={false} />`, `<color attach="background" args={["#1a2433"]} />`. `<OrbitControls makeDefault />` is required so `useThree().controls` exposes the controls for auto-fit.

## Design system

Colours, surfaces and fonts follow the Hub (moon-landing). Tokens live in `src/app/globals.css`: light values on `:root`, dark under `:root.dark`, exposed as Tailwind colours. **Never hard-code** `text-slate-*`, `border-white/*`, `bg-white/*` or hex colours for UI chrome; use the tokens so both themes work:

- Surfaces: `--bg`, `--surface-0` (chrome), `--surface-1` (cards), `--surface-2` — white / gray-50 / gray-100 light, gray-950 / gray-925 / gray-850 dark
- Text: `text-fg`, `text-fg-soft`, `text-fg-muted`, `text-fg-faint`; accent text `text-accent-fg`, flag text `text-flag-fg`
- Lines and fills: `border-line` / `border-line-subtle` / `border-line-strong`, `bg-fill` / `bg-fill-strong` (hover and control fills)
- Charts: `var(--chart-grid)`, `var(--chart-axis)`, `var(--fg-muted)` for ticks; CSS variables work in Recharts' SVG attributes. Three.js needs real colours: read `useTheme()` from `src/utils/theme.ts`
- Chart marks take `--series-1` … `--series-8`, in that order and never cycled past the eighth (fold the rest, or facet). The order is what keeps neighbours apart under colour-vision deficiency, and it was checked on both themes' surfaces: re-run the check before changing a value. A single series is `--series-1`; the accent marks what is selected. Text never takes a series colour.
- `src/components/charts.tsx` has the SVG charts the analysis tabs share: `Histogram` (hover and focus readout, selectable bins, a table for screen readers), `Heatmap`, `RangeBar`, `SeriesLegend`, and the helpers `niceTicks`, `roundBins`, `seriesStyle`, `sequentialColor`. Grids are solid hairlines, bars are rounded at the data end only and separated by a gap rather than an outline
- More than eight lines in one chart: `seriesStyle(i)` gives the eight hues again, dashed, for series 9 to 16. A magnitude (a heatmap) is one hue from `sequentialColor`, whose zero is the step nearest the page in either theme
- Verdicts (smooth / moderate / jerky, consistent / high variance) use `text-good-fg` / `text-warning-fg` / `text-critical-fg` for the word and `--status-good` / `--status-warning` / `--status-critical` for a mark. They always sit beside the word, and are never series colours. Don't use raw `green-400` / `red-400`: they are unreadable on the light theme
- Theme: `<html class="dark">`, set before paint by `THEME_INIT_SCRIPT` (`src/utils/theme-init.ts`) from `?__theme=` (what HF Spaces passes), then the saved choice, then the OS; `ThemeToggle` in the tab bar switches it. `dark:` utilities target that class
- Fonts: Source Sans 3 (Source Sans Pro) and IBM Plex Mono via `next/font` in `layout.tsx`, as `font-sans` / `font-mono`
- Accent: `--accent #ff9d00`, LeRobot orange (the logo colour) — primary interactive colour across UI. Use `bg-accent/10`, `border-accent/30`, `text-accent-fg` (a darker/lighter orange with readable contrast per theme), never raw `cyan-*`/`orange-*`
- Helpers: `.panel`, `.panel-raised`, `.tabular` (tabular-nums)
- **Color semantics**: orange (accent) = primary/active; rose (`rose-500`, `text-flag-fg`, `.btn-flagged`) is reserved for **flagged-episode** UI only — don't reuse it for generic accents. The annotation role colours (task aug cyan, subtask yellow, …) are semantic and stay as they are.
- **Playhead**: the playback position (chart cursor, annotation timeline) uses `--playhead`, a neutral near-white, so it never reads as a series, a role or a flag.
- **Buttons**: `.btn` (secondary), plus `.btn-active` for a selected toggle, `.btn-flagged` for flag filters/actions and `.btn-primary` for the main action. They live in `@layer components`, so a utility on the element (size, width) overrides them.
- **Analysis tabs** (Statistics, Filtering, Frames, Action Insights) build on `src/components/ui.tsx`: `PageHeader`, `StatCard`, `InlineLoading` / `Spinner`, `Switch`; `EpisodeHeader` heads every tab that plays an episode. An episode named in an analysis is an `EpisodeLink` (it opens that episode), and flagging goes through `FlagButton` / `FlagAllButton`. Tab roots are `w-full max-w-5xl mx-auto py-6 space-y-6` (`w-full` matters: `mx-auto` in the flex-column content area otherwise sizes the column to its content). Section cards are `bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10` with an `h3` of `text-sm font-semibold text-slate-200`.
- **Annotations** keeps its own skin (`annotations-skin.css`) for role colours (subtask yellow, plan blue, …); generic UI in it (focus, selection, primary button) uses the app `--accent`.

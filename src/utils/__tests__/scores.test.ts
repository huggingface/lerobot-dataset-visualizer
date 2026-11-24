import { describe, expect, mock, test } from "bun:test";
import type { FileMetaData } from "hyparquet";
import {
  DEFAULT_MAX_CURVES,
  ScoreFileError,
  axisKey,
  axisRange,
  buildEpisodeSeries,
  categoricalRuns,
  collectColumns,
  defaultScoreSelection,
  episodeRowRange,
  episodeRowsIn,
  formatScore,
  isCategorical,
  listScoreFiles,
  parseScoreFile,
  parseScoreSelection,
  parseSignalDescriptor,
  readEpisodeScores,
  scoreCamera,
  scoreFileMismatch,
  scoreFileNames,
  scoreFileUrl,
  scoreModelName,
  seriesPath,
  signalKey,
  signalLabel,
  type ScoreFile,
} from "@/utils/scores";

// ---------------------------------------------------------------------------
// Score-file footers, built by hand as `parquetUtils.test.ts` builds its metadata. The `info` and
// dataset blocks are those `lerobot-score` (lerobot#4554) wrote for Robometer and RynnValue on
// lerobot/svla_so100_pickplace and for SARM on Lebruhbruh/NEW_SARM_drawer_sarm, less the scorer
// options other than `image_key`.
// ---------------------------------------------------------------------------

const SVLA_DATASET = {
  lerobot_version: "0.6.2",
  repo_id: "lerobot/svla_so100_pickplace",
  revision: "v3.0",
  total_episodes: 50,
  total_frames: 19631,
};

const ROBOMETER_INFO = {
  provenance: {
    model: { id: "lerobot/Robometer-4B", revision: null, type: "robometer" },
    scorer: { options: { image_key: "observation.images.top" }, version: 1 },
  },
  signals: {
    "reward.robometer.progress": {
      allow_nan: false,
      bounds: [0.0, 1.0],
      description:
        "RoboMeter task progress for the trajectory prefix ending at this frame.",
      greater_is_better: true,
      labels: null,
      unit: null,
    },
    "reward.robometer.success_probability": {
      allow_nan: false,
      bounds: [0.0, 1.0],
      description:
        "RoboMeter success probability for the trajectory prefix ending at this frame.",
      greater_is_better: true,
      labels: null,
      unit: null,
    },
  },
};

const RYNNVALUE_INFO = {
  provenance: {
    model: { id: "lerobot/RynnValue-4B", revision: null, type: "rynnvalue" },
    scorer: { options: { image_key: "observation.images.top" }, version: 1 },
  },
  signals: {
    "reward.rynnvalue.remaining_time_s": {
      allow_nan: false,
      bounds: null,
      description:
        "RynnValue predicted seconds until the task is completed, for the trajectory prefix ending at this frame, linearly interpolated between the frames RynnValue ran on.",
      greater_is_better: false,
      labels: null,
      unit: "s",
    },
  },
};

const SARM_LABELS = [
  "Open the drawer and pick up the blue test tube rack",
  "Place the blue test tube rack in the drawer",
  "Close the drawer",
  "Retract the arm",
];

const SARM_INFO = {
  provenance: {
    model: {
      id: "Lebruhbruh/new-sarm-drawer-bimanual",
      revision: null,
      type: "sarm",
    },
    scorer: { options: { image_key: "observation.images.top" }, version: 1 },
  },
  signals: {
    "reward.sarm.dense_progress": {
      allow_nan: true,
      bounds: [0.0, 1.0],
      description:
        "SARM task progress from its dense head, predicted from the window of frames around this frame.",
      greater_is_better: true,
      labels: null,
      unit: null,
    },
    "reward.sarm.dense_stage": {
      allow_nan: true,
      bounds: [0.0, 3.0],
      description:
        "SARM's most likely subtask from its dense head, as an index into labels.",
      greater_is_better: null,
      labels: SARM_LABELS,
      unit: null,
    },
  },
};

/** A row group: its row count and the `episode_index` range its statistics give, if any. */
type Group = { rows: number; episodes?: [number, number] };

/** A score file's footer: the reserved columns, one per signal, and its key-value metadata. */
function scoreFooter({
  signals,
  info,
  dataset = SVLA_DATASET,
  groups = [],
  keyValues = {},
}: {
  signals: string[];
  info: unknown;
  dataset?: unknown;
  groups?: Group[];
  /** Replaces (or, with undefined, removes) entries of the key-value metadata. */
  keyValues?: Record<string, string | undefined>;
}): FileMetaData {
  const columns = ["index", "episode_index", "frame_index", ...signals];
  const kv: Record<string, string | undefined> = {
    "lerobot.scores.format": "lerobot.scores",
    "lerobot.scores.schema_version": "1",
    "lerobot.scores.dataset": JSON.stringify(dataset),
    "lerobot.scores.info":
      typeof info === "string" ? info : JSON.stringify(info),
    ...keyValues,
  };
  return {
    schema: [
      { name: "schema", num_children: columns.length },
      ...columns.map((name) => ({ name })),
    ],
    num_rows: BigInt(groups.reduce((n, g) => n + g.rows, 0)),
    row_groups: groups.map((group) => ({
      num_rows: BigInt(group.rows),
      columns: [
        {
          meta_data: {
            path_in_schema: ["episode_index"],
            statistics: group.episodes && {
              min_value: BigInt(group.episodes[0]),
              max_value: BigInt(group.episodes[1]),
            },
          },
        },
      ],
    })),
    key_value_metadata: Object.entries(kv)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ key, value })),
  } as unknown as FileMetaData;
}

const ROBOMETER_SIGNALS = Object.keys(ROBOMETER_INFO.signals);
// Episodes 0 and 1, one row group each, as the real file has them.
const robometer = scoreFooter({
  signals: ROBOMETER_SIGNALS,
  info: ROBOMETER_INFO,
  groups: [
    { rows: 454, episodes: [0, 0] },
    { rows: 468, episodes: [1, 1] },
  ],
});
const rynnvalue = scoreFooter({
  signals: Object.keys(RYNNVALUE_INFO.signals),
  info: RYNNVALUE_INFO,
});
const sarm = scoreFooter({
  signals: Object.keys(SARM_INFO.signals),
  info: SARM_INFO,
  dataset: {
    ...SVLA_DATASET,
    repo_id: "Lebruhbruh/NEW_SARM_drawer_sarm",
    total_episodes: 110,
    total_frames: 53026,
  },
});

describe("parseScoreFile", () => {
  test("reads signals, descriptors, provenance and dataset identity", () => {
    const file = parseScoreFile("robometer", robometer);
    expect(file.name).toBe("robometer");
    expect(file.signals.map((s) => s.name)).toEqual(ROBOMETER_SIGNALS);
    expect(file.signals[0].descriptor).toEqual({
      description:
        "RoboMeter task progress for the trajectory prefix ending at this frame.",
      greaterIsBetter: true,
      bounds: [0, 1],
      unit: null,
      allowNan: false,
      labels: null,
    });
    expect(file.provenance).toEqual({
      modelType: "robometer",
      modelId: "lerobot/Robometer-4B",
      modelRevision: null,
      scorerVersion: "1",
      convertedFrom: null,
      imageKey: "observation.images.top",
    });
    expect(file.dataset).toEqual({
      repoId: "lerobot/svla_so100_pickplace",
      revision: "v3.0",
      totalEpisodes: 50,
      totalFrames: 19631,
      lerobotVersion: "0.6.2",
    });
  });

  test("a signal in seconds where lower is better, without bounds", () => {
    const [signal] = parseScoreFile("rynnvalue", rynnvalue).signals;
    expect(signal.descriptor.unit).toBe("s");
    expect(signal.descriptor.greaterIsBetter).toBe(false);
    expect(signal.descriptor.bounds).toBeNull();
    expect(signalLabel(signal)).toBe("remaining time");
  });

  test("a categorical signal carries its label names", () => {
    const file = parseScoreFile("sarm", sarm);
    const stage = file.signals.find(
      (s) => s.name === "reward.sarm.dense_stage",
    )!;
    expect(isCategorical(stage)).toBe(true);
    expect(stage.descriptor.labels).toEqual(SARM_LABELS);
    expect(stage.descriptor.greaterIsBetter).toBeNull();
    expect(stage.descriptor.allowNan).toBe(true);
    const progress = file.signals.find(
      (s) => s.name === "reward.sarm.dense_progress",
    )!;
    expect(isCategorical(progress)).toBe(false);
  });

  test("rejects a parquet file that is not a score file", () => {
    const footer = scoreFooter({
      signals: ROBOMETER_SIGNALS,
      info: ROBOMETER_INFO,
      keyValues: { "lerobot.scores.format": undefined },
    });
    expect(() => parseScoreFile("x", footer)).toThrow(ScoreFileError);
  });

  test("rejects another schema version", () => {
    const footer = scoreFooter({
      signals: ROBOMETER_SIGNALS,
      info: ROBOMETER_INFO,
      keyValues: { "lerobot.scores.schema_version": "2" },
    });
    expect(() => parseScoreFile("x", footer)).toThrow(/version 2/);
  });

  test("reads a converted file's provenance, which has no scorer options", () => {
    const file = parseScoreFile(
      "old",
      scoreFooter({
        signals: ROBOMETER_SIGNALS,
        info: {
          ...ROBOMETER_INFO,
          provenance: {
            model: { type: "robometer", id: null, revision: null },
            scorer: { converted_from: "reward_robometer.parquet" },
          },
        },
      }),
    );
    expect(file.provenance.convertedFrom).toBe("reward_robometer.parquet");
    expect(file.provenance.scorerVersion).toBeNull();
    expect(file.provenance.imageKey).toBeNull();
    expect(scoreModelName(file)).toBe("robometer");
  });

  test("keeps a column without a descriptor and drops a descriptor without a column", () => {
    const file = parseScoreFile(
      "robometer",
      scoreFooter({
        signals: ROBOMETER_SIGNALS,
        info: {
          ...ROBOMETER_INFO,
          signals: {
            "reward.robometer.progress":
              ROBOMETER_INFO.signals["reward.robometer.progress"],
            "reward.robometer.missing": { bounds: [0, 1] },
          },
        },
      }),
    );
    expect(file.signals.map((s) => s.name)).toEqual(ROBOMETER_SIGNALS);
    expect(file.signals[1].descriptor.bounds).toBeNull();
  });

  test("a nested column counts once", () => {
    const footer = {
      ...robometer,
      schema: [
        { name: "schema", num_children: 4 },
        { name: "index" },
        { name: "episode_index" },
        { name: "frame_index" },
        { name: "reward.x.embedding", num_children: 1 },
        { name: "list", num_children: 1 },
        { name: "element" },
      ],
    } as unknown as FileMetaData;
    expect(parseScoreFile("x", footer).signals.map((s) => s.name)).toEqual([
      "reward.x.embedding",
    ]);
  });

  test("survives info that is not JSON", () => {
    const file = parseScoreFile(
      "robometer",
      scoreFooter({ signals: ROBOMETER_SIGNALS, info: "{oops" }),
    );
    expect(file.signals).toHaveLength(2);
    expect(scoreModelName(file)).toBe("robometer");
  });
});

describe("parseSignalDescriptor", () => {
  test("ignores malformed fields", () => {
    expect(
      parseSignalDescriptor({
        bounds: [1, 0],
        greater_is_better: "yes",
        unit: "",
        labels: [],
        allow_nan: 1,
      }),
    ).toEqual({
      description: null,
      greaterIsBetter: null,
      bounds: null,
      unit: null,
      allowNan: false,
      labels: null,
    });
    expect(parseSignalDescriptor(null).bounds).toBeNull();
  });
});

describe("names", () => {
  test("a model is named by its id without the org, else its type", () => {
    expect(scoreModelName(parseScoreFile("robometer", robometer))).toBe(
      "Robometer-4B",
    );
    const file: ScoreFile = {
      ...parseScoreFile("topreward", robometer),
      provenance: {
        modelType: "topreward",
        modelId: null,
        modelRevision: null,
        scorerVersion: null,
        convertedFrom: null,
        imageKey: null,
      },
    };
    expect(scoreModelName(file)).toBe("topreward");
  });

  test("signal labels drop the namespace, the unit suffix and underscores", () => {
    const descriptor = parseSignalDescriptor({});
    expect(
      signalLabel({
        name: "reward.robometer.success_probability",
        descriptor,
      }),
    ).toBe("success probability");
    expect(signalLabel({ name: "plain", descriptor })).toBe("plain");
  });
});

describe("scoreFileMismatch", () => {
  const file = parseScoreFile("robometer", robometer);
  const dataset = {
    repoId: "lerobot/svla_so100_pickplace",
    totalEpisodes: 50,
    totalFrames: 19631,
  };
  test("matching dataset", () => {
    expect(scoreFileMismatch(file, dataset)).toBeNull();
    expect(
      scoreFileMismatch(file, { ...dataset, totalEpisodes: 60 }),
    ).toBeNull();
  });
  test("scored on more frames than the dataset has", () => {
    expect(
      scoreFileMismatch(file, { ...dataset, totalFrames: 100 })?.severity,
    ).toBe("error");
  });
  test("scored under another repo id", () => {
    expect(
      scoreFileMismatch(file, { ...dataset, repoId: "someone/copy" }),
    ).toEqual({
      severity: "warning",
      message: "Scored on lerobot/svla_so100_pickplace",
    });
  });
});

describe("episodeRowRange", () => {
  test("finds an episode's row group from the statistics", () => {
    expect(episodeRowRange(robometer, 0)).toEqual({ rowStart: 0, rowEnd: 454 });
    expect(episodeRowRange(robometer, 1)).toEqual({
      rowStart: 454,
      rowEnd: 922,
    });
  });

  test("null for an episode that was not scored", () => {
    expect(episodeRowRange(robometer, 7)).toBeNull();
  });

  test("undefined when a row group has no statistics", () => {
    const footer = scoreFooter({
      signals: ROBOMETER_SIGNALS,
      info: ROBOMETER_INFO,
      groups: [{ rows: 454, episodes: [0, 0] }, { rows: 468 }],
    });
    expect(episodeRowRange(footer, 1)).toBeUndefined();
  });
});

describe("episodeRowsIn", () => {
  test("the rows of an episode in an episode_index column", () => {
    expect(episodeRowsIn([0n, 0n, 1n, 1n, 1n, 2n], 1)).toEqual({
      rowStart: 2,
      rowEnd: 5,
    });
    expect(episodeRowsIn([0, 0, 2], 1)).toBeNull();
    expect(episodeRowsIn([], 0)).toBeNull();
  });
});

describe("collectColumns", () => {
  test("keeps only the rows asked for, wherever a chunk starts", () => {
    const { add, columns } = collectColumns(3, 6);
    add({
      columnName: "frame_index",
      columnData: [0, 1, 2, 3, 4],
      rowStart: 0,
      rowEnd: 5,
    });
    add({
      columnName: "frame_index",
      columnData: [5, 6, 7],
      rowStart: 5,
      rowEnd: 8,
    });
    add({
      columnName: "reward.x",
      columnData: [0.3, 0.4, 0.5],
      rowStart: 3,
      rowEnd: 6,
    });
    expect(columns).toEqual({
      frame_index: [3, 4, 5],
      "reward.x": [0.3, 0.4, 0.5],
    });
  });
});

describe("readEpisodeScores", () => {
  test("an episode the statistics rule out reads nothing and is all NaN", async () => {
    const untouched = {
      byteLength: 1,
      slice: () => {
        throw new Error("read");
      },
    };
    const scores = await readEpisodeScores(
      untouched,
      robometer,
      parseScoreFile("robometer", robometer),
      5,
      3,
    );
    expect(scores.scoredRows).toBe(0);
    expect(Array.from(scores.series["reward.robometer.progress"])).toEqual([
      NaN,
      NaN,
      NaN,
    ]);
  });
});

describe("buildEpisodeSeries", () => {
  test("sparse frames and NaN scores are both NaN; other episodes are ignored", () => {
    const { series, scoredRows } = buildEpisodeSeries(
      3,
      6,
      {
        episode_index: [2n, 3n, 3n, 3n, 3n],
        frame_index: [0n, 0n, 2n, 4n, 9n],
        "reward.x": [0.9, 0.1, NaN, 0.5, 0.7],
        "reward.ok": [true, false, true, true, true],
      },
      ["reward.x", "reward.ok"],
    );
    expect(scoredRows).toBe(3); // frame 9 is past the episode's end
    expect(Array.from(series["reward.x"])).toEqual([
      expect.closeTo(0.1, 6),
      NaN,
      NaN,
      NaN,
      0.5,
      NaN,
    ]);
    expect(Array.from(series["reward.ok"])).toEqual([0, NaN, 1, NaN, 1, NaN]);
  });

  test("without a frame count, sized to the last scored frame", () => {
    const { series } = buildEpisodeSeries(
      0,
      0,
      { episode_index: [0, 0], frame_index: [0, 3], s: [1, 2] },
      ["s"],
    );
    expect(Array.from(series.s)).toEqual([1, NaN, NaN, 2]);
  });
});

describe("axes", () => {
  const descriptor = (d: Record<string, unknown>) => parseSignalDescriptor(d);

  test("curves sharing bounds use them", () => {
    const d = descriptor({ bounds: [0, 1] });
    expect(axisRange([{ descriptor: d, values: [0.2, 0.4] }])).toEqual([0, 1]);
    expect(axisKey(d)).toBe("bounds:0:1");
  });

  test("without bounds, zero to a rounded maximum in the unit", () => {
    const d = descriptor({ unit: "s" });
    expect(axisKey(d)).toBe("unit:s");
    expect(axisRange([{ descriptor: d, values: [1.4, NaN, 7.3] }])).toEqual([
      0, 8,
    ]);
    expect(axisRange([{ descriptor: d, values: [12] }])).toEqual([0, 15]);
    expect(axisRange([{ descriptor: d, values: [-2, 2.2] }])).toEqual([-2, 3]);
  });

  test("no values, or one flat value at zero", () => {
    const d = descriptor({});
    expect(axisRange([{ descriptor: d, values: [NaN] }])).toEqual([0, 1]);
    expect(axisRange([{ descriptor: d, values: [0, 0] }])).toEqual([0, 1]);
  });
});

describe("formatScore", () => {
  test("with a unit, plain, categorical and missing", () => {
    expect(formatScore(3.14159, parseSignalDescriptor({ unit: "s" }))).toBe(
      "3.1 s",
    );
    expect(formatScore(0.456, parseSignalDescriptor({}))).toBe("0.46");
    expect(
      formatScore(1, parseSignalDescriptor({ labels: ["reach", "grasp"] })),
    ).toBe("grasp");
    expect(formatScore(NaN, parseSignalDescriptor({}))).toBe("–");
    expect(
      formatScore(5, parseSignalDescriptor({ labels: ["reach", "grasp"] })),
    ).toBe("–");
  });
});

describe("categoricalRuns", () => {
  test("NaN and unknown labels are gaps", () => {
    expect(categoricalRuns([0, 0, NaN, 1, 1, 7, 1], 2)).toEqual([
      { start: 0, end: 2, label: 0 },
      { start: 3, end: 5, label: 1 },
      { start: 6, end: 7, label: 1 },
    ]);
  });
});

describe("seriesPath", () => {
  test("breaks the line where a frame has no score", () => {
    expect(
      seriesPath(
        [1, 2, NaN, 4],
        (f) => f * 10,
        (v) => v,
      ),
    ).toBe("M0.00 1.00L10.00 2.00M30.00 4.00");
  });
  test("no scores, no path", () => {
    expect(
      seriesPath(
        [NaN, NaN],
        (f) => f,
        (v) => v,
      ),
    ).toBe("");
  });
});

describe("listing", () => {
  test("keeps published score files, not staging entries", () => {
    expect(
      scoreFileNames([
        { type: "file", path: "scores/topreward.parquet" },
        { type: "file", path: "scores/robometer.parquet" },
        { type: "directory", path: "scores/.sarm.parquet.parts" },
        { type: "file", path: "scores/.hidden.parquet" },
        { type: "file", path: "scores/sarm.parquet.tmp" },
        { type: "file", path: "scores/notes.md" },
        { type: "file", path: "scores/sub/x.parquet" },
      ]),
    ).toEqual(["robometer", "topreward"]);
    expect(scoreFileNames({ error: "nope" })).toEqual([]);
  });

  test("lists through the Hub tree API at the revision", async () => {
    const fetchImpl = mock((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ type: "file", path: "scores/sarm.parquet" }]),
          { status: url.includes("/tree/main/scores") ? 200 : 500 },
        ),
      ),
    );
    expect(
      await listScoreFiles(
        "https://hub.test",
        "org/ds",
        "main",
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).toEqual(["sarm"]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://hub.test/api/datasets/org/ds/tree/main/scores",
    );
  });

  test("a repo without scores/ has none", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("{}", { status: 404 })),
    );
    expect(
      await listScoreFiles(
        "https://hub.test",
        "org/ds",
        "v3.0",
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).toEqual([]);
  });

  test("other failures throw", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    await expect(
      listScoreFiles(
        "https://hub.test",
        "org/ds",
        "main",
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/401/);
  });

  test("file URLs resolve at the revision", () => {
    expect(
      scoreFileUrl(
        "https://huggingface.co/datasets",
        "org/ds",
        "refs/pr/1",
        "robometer",
      ),
    ).toBe(
      "https://huggingface.co/datasets/org/ds/resolve/refs%2Fpr%2F1/scores/robometer.parquet",
    );
  });
});

describe("selection", () => {
  test("by default every categorical signal and up to eight curves", () => {
    const files = [
      parseScoreFile("robometer", robometer),
      parseScoreFile("rynnvalue", rynnvalue),
      parseScoreFile("sarm", sarm),
    ];
    expect([...defaultScoreSelection(files)]).toEqual([
      signalKey("robometer", "reward.robometer.progress"),
      signalKey("robometer", "reward.robometer.success_probability"),
      signalKey("rynnvalue", "reward.rynnvalue.remaining_time_s"),
      signalKey("sarm", "reward.sarm.dense_progress"),
      signalKey("sarm", "reward.sarm.dense_stage"),
    ]);
    const many = Array.from({ length: 6 }, (_, i) =>
      parseScoreFile(`r${i}`, robometer),
    );
    expect(defaultScoreSelection(many).size).toBe(DEFAULT_MAX_CURVES);
  });

  test("a stored selection, or none", () => {
    expect(parseScoreSelection('["a\\nb", 3]')).toEqual(new Set(["a\nb"]));
    expect(parseScoreSelection("[]")).toEqual(new Set());
    expect(parseScoreSelection(null)).toBeNull();
    expect(parseScoreSelection("{")).toBeNull();
    expect(parseScoreSelection("{}")).toBeNull();
  });
});

describe("scoreCamera", () => {
  const file = parseScoreFile("robometer", robometer);
  const cameras = ["observation.images.wrist", "observation.images.top"];

  test("the camera the model read", () => {
    expect(scoreCamera(file, cameras)).toEqual({
      camera: "observation.images.top",
      known: true,
      note: null,
    });
  });

  test("a file that does not say goes on the first camera, with a note", () => {
    const unsaid: ScoreFile = {
      ...file,
      provenance: { ...file.provenance, imageKey: null },
    };
    expect(scoreCamera(unsaid, cameras)).toEqual({
      camera: "observation.images.wrist",
      known: false,
      note: "The file does not say which camera was scored",
    });
  });

  test("a camera the dataset has no video for", () => {
    const result = scoreCamera(file, ["observation.images.front"]);
    expect(result.camera).toBe("observation.images.front");
    expect(result.known).toBe(false);
    expect(result.note).toBe(
      "Scored on observation.images.top, which this dataset has no video for",
    );
    expect(scoreCamera(file, []).camera).toBeNull();
  });
});

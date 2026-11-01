import { describe, expect, test } from "bun:test";
import {
  fluToScene,
  cameraPathRuns,
  handFrameIndex,
  handProjectionMetadata,
  hasHandTracking,
  parseHandCalibration,
  projectHandPoint,
  readHandTracking,
  wristTrail,
} from "../hand-tracking";
import type { DatasetMetadata } from "@/utils/parquetUtils";

function info(): DatasetMetadata {
  const widths = {
    action: 156,
    "annotation.hand_joints_camera": 126,
    "annotation.hand_joints_world": 126,
    "annotation.hand_action_valid": 1,
    "annotation.hand_observed": 2,
    "annotation.hand_reference_frame": 1,
  };
  return {
    codebase_version: "v3.0",
    robot_type: "human_egocentric",
    fps: 10,
    total_episodes: 1,
    total_frames: 6,
    total_tasks: 1,
    total_videos: 1,
    total_chunks: 1,
    chunks_size: 1000,
    splits: {},
    data_path: "",
    video_path: "",
    features: {
      ...Object.fromEntries(
        Object.entries(widths).map(([key, width]) => [
          key,
          { dtype: "float32", shape: [width], names: null },
        ]),
      ),
      "observation.images.ego": {
        dtype: "video",
        shape: [480, 640, 3],
        names: null,
      },
    },
  };
}
const calibration = {
  model: "pinhole",
  width: 640,
  height: 480,
  fx: 600,
  fy: 610,
  cx: 320,
  cy: 240,
  distortion: [],
};
const metadata = {
  cameraKey: "observation.images.ego",
  calibration: parseHandCalibration(calibration),
  overlayIssue: null,
};
function numericFrames(): {
  length: number;
  timestamps: number[];
  series: Record<string, number[][]>;
} {
  const vector = () =>
    Array.from({ length: 126 }, (_, component) =>
      Array.from({ length: 6 }, () =>
        component % 3 === 2 ? 1 : component / 100,
      ),
    );
  return {
    length: 6,
    timestamps: [20, 20.1, 20.2, 20.3, 20.4, 20.5],
    series: {
      "annotation.hand_joints_camera": vector(),
      "annotation.hand_joints_world": vector(),
      "annotation.hand_action_valid": [[1, 1, 0, 1, 1, 1]],
      "annotation.hand_observed": [
        [1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1],
      ],
      "annotation.hand_reference_frame": [[0, 0, -1, 3, 3, 5]],
    },
  };
}

describe("native hand schema and time alignment", () => {
  test("an arbitrary 156D action is not detected as hand tracking", () => {
    const metadata = info();
    expect(hasHandTracking(metadata)).toBe(true);
    delete metadata.features["annotation.hand_joints_camera"];
    expect(hasHandTracking(metadata)).toBe(false);
  });
  test("all source frames survive, with local timestamps and independently masked hands", () => {
    const frames = numericFrames();
    frames.series["annotation.hand_observed"][1][1] = 0;
    const data = readHandTracking(info(), frames, metadata)!;
    expect(data.frames).toHaveLength(6);
    expect(data.frames[1].time).toBeCloseTo(0.1);
    expect(data.frames[0].camera[0]).toHaveLength(21);
    expect(data.frames[1].camera[1]).toBeNull();
    expect(data.frames[2].camera).toEqual([null, null]);
    expect(data.frames[2].segment).toEqual([null, null]);
  });
  test("a non-finite point hides the affected hand in both views", () => {
    const frames = numericFrames();
    frames.series["annotation.hand_joints_camera"][0][0] = NaN;
    const data = readHandTracking(info(), frames, metadata)!;
    expect(data.frames[0].camera[0]).toBeNull();
    expect(data.frames[0].segment[0]).toBeNull();
    expect(data.frames[0].segment[1]).not.toBeNull();
  });
  test("selects the displayed frame without interpolating or looking ahead", () => {
    const frames = readHandTracking(info(), numericFrames(), metadata)!.frames;
    expect(handFrameIndex(frames, 0.099)).toBe(0);
    expect(handFrameIndex(frames, 0.1)).toBe(1);
    expect(handFrameIndex(frames, 0.2)).toBe(2);
    // A frame at 0.2 s lives at media time 12.7 s in a shared video starting at 12.5 s.
    expect(handFrameIndex(frames, 12.7 - 12.5)).toBe(2);
    expect(handFrameIndex(frames, -1)).toBe(-1);
  });
  test("trails stop at gaps and segment-reference resets", () => {
    const frames = readHandTracking(info(), numericFrames(), metadata)!.frames;
    expect(wristTrail(frames, 1, 0)).toHaveLength(2);
    expect(wristTrail(frames, 2, 0)).toHaveLength(0);
    expect(wristTrail(frames, 4, 0)).toHaveLength(2);
    expect(wristTrail(frames, 5, 0)).toHaveLength(1);
    expect(fluToScene([1, 2, 3])).toEqual([-2, 3, -1]);
  });
});

describe("recording-wide camera and wrist coordinates", () => {
  const rigid = (x = 0) => [1, 0, 0, x, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
  const withPoses = (poses: number[][]) => {
    const frames = numericFrames();
    frames.series["annotation.camera_world_from_optical"] = Array.from(
      { length: 16 },
      (_, a) => poses.map((pose) => pose[a]),
    );
    return readHandTracking(info(), frames, metadata)!;
  };
  test("removes the first camera's translation and rotation from the recording frame", () => {
    const pose = [0, -1, 0, 10, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    const moved = [...pose];
    moved[7] += 1;
    const tracking = withPoses([pose, moved, pose, pose, pose, pose]);
    expect(tracking.coordinateFrame).toBe("recording");
    expect(tracking.frames[0].cameraPose?.position).toEqual([0, -0, -0]);
    expect(tracking.frames[1].cameraPose?.position).toEqual([0, -1, -0]);
    expect(tracking.frames[0].recording[0]?.[0][0]).toBeCloseTo(1);
    expect(tracking.frames[1].recording[0]?.[0][1]).toBeCloseTo(-1);
    expect(tracking.frames[1].recording[0]?.[0][2]).toBeCloseTo(-0.01);
  });
  test("rotates optical joints with each camera pose instead of displaying span-local joints as global", () => {
    const rotated = [0, -1, 0, 1, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
    const tracking = withPoses([
      rigid(),
      rotated,
      rigid(),
      rigid(),
      rigid(),
      rigid(),
    ]);
    expect(tracking.frames[1].recording[0]?.[0][1]).toBeCloseTo(-0.99);
    expect(tracking.frames[1].recording[0]?.[0][2]).toBeCloseTo(0);
    expect(tracking.frames[1].cameraPose?.axes[0]).toEqual([0, 0, -1]);
    // Reference frame changes at frame 5, but the saved global trajectory remains continuous.
    expect(wristTrail(tracking.frames, 5, 0, 2, "recording")).toHaveLength(3);
    expect(wristTrail(tracking.frames, 5, 0)).toHaveLength(1);
  });
  test("zero, reflected and non-rigid camera placeholders split the trajectory and hide global hands", () => {
    const reflection = rigid();
    reflection[0] = -1;
    const scaled = rigid();
    scaled[0] = 2;
    const tracking = withPoses([
      rigid(),
      rigid(1),
      Array(16).fill(0),
      reflection,
      scaled,
      rigid(2),
    ]);
    expect(cameraPathRuns(tracking.frames, 5).map((run) => run.length)).toEqual(
      [2, 1],
    );
    for (const i of [2, 3, 4]) {
      expect(tracking.frames[i].cameraPose).toBeNull();
      expect(tracking.frames[i].recording).toEqual([null, null]);
    }
    expect(tracking.frames[5].recording[0]).not.toBeNull();
  });
  test("older native exports without saved camera transforms retain span-local 3D", () => {
    const tracking = readHandTracking(info(), numericFrames(), metadata)!;
    expect(tracking.coordinateFrame).toBe("segment");
    expect(tracking.frames[0].segment[0]).not.toBeNull();
    expect(cameraPathRuns(tracking.frames, 5)).toEqual([]);
  });
});

describe("episode-specific source camera binding", () => {
  test("an incomplete episode mapping cannot select an unindexed report entry", () => {
    const selected = handProjectionMetadata(info(), 0, {
      source_episode_map: [{ episode_index: 1, source_episode_index: 7 }],
      episodes: [{ hand_actions: { camera_intrinsics: calibration } }],
    });
    expect(selected.calibration).toBeNull();
    expect(selected.overlayIssue).toContain("No camera calibration");
  });
  test("uses the source episode map, not completion order or output index", () => {
    const report = {
      manifest: { camera: "observation.images.ego" },
      source_episode_map: [{ episode_index: 0, source_episode_index: 7 }],
      episodes: [
        {
          episode_index: 0,
          hand_actions: { camera_intrinsics: { ...calibration, fx: 100 } },
        },
        {
          episode_index: 7,
          hand_actions: {
            camera_intrinsics: { ...calibration, fx: 700, measured: false },
          },
        },
      ],
    };
    const selected = handProjectionMetadata(info(), 0, report);
    expect(selected.calibration?.fx).toBe(700);
    expect(selected.calibration?.estimated).toBe(true);
  });
  test("never projects source-camera coordinates onto another camera", () => {
    expect(
      handProjectionMetadata(info(), 0, {
        manifest: { camera: "missing.camera" },
      }).cameraKey,
    ).toBeNull();
    const data = info();
    data.features["observation.images.other"] =
      data.features["observation.images.ego"];
    expect(handProjectionMetadata(data, 0, null).cameraKey).toBeNull();
  });
  test("missing calibration keeps 3D available and explains why overlays are unavailable", () => {
    const selected = handProjectionMetadata(info(), 0, null);
    expect(selected.calibration).toBeNull();
    expect(selected.overlayIssue).toContain("No camera calibration");
    expect(
      readHandTracking(info(), numericFrames(), selected)?.frames[0].segment[0],
    ).not.toBeNull();
  });
  test("accepts measured calibration JSON stored on the video feature", () => {
    const data = info();
    data.features["observation.images.ego"].info = {
      "camera.intrinsics": JSON.stringify(calibration),
    };
    expect(handProjectionMetadata(data, 0, null).calibration?.fx).toBe(600);
    expect(parseHandCalibration({ ...calibration, fx: Infinity })).toBeNull();
  });
  test("rejects malformed calibration at the unknown-data boundary", () => {
    for (const value of [
      null,
      [],
      "invalid JSON",
      { ...calibration, width: 640.5 },
      { ...calibration, fx: "600" },
      { ...calibration, distortion: [0, 0, 0, "0"] },
    ]) {
      expect(parseHandCalibration(value)).toBeNull();
    }
  });
});

describe("source camera projection", () => {
  // Reference outputs generated with OpenCV projectPoints, not the implementation under test.
  const d = [
    0.1, -0.02, 0.003, -0.004, 0.01, 0.02, -0.01, 0.005, 0.001, -0.002, 0.003,
    -0.004, 0.02, -0.03,
  ];
  const expected = [
    [0, 360, 321.3333333333333],
    [4, 360.04582716049384, 321.57562633744857],
    [5, 360.04583155006856, 321.5756352629172],
    [8, 360.02821795025153, 321.53982094328916],
    [12, 360.0409586909922, 321.5792826716842],
    [14, 360.2472660915072, 322.00366115201376],
  ];
  for (const [count, x, y] of expected)
    test(`pinhole ${count}-coefficient projection matches OpenCV`, () => {
      const c = parseHandCalibration({
        ...calibration,
        distortion: d.slice(0, count),
      })!;
      const p = projectHandPoint([0.1, 0.2, 1.5], c)!;
      expect(p[0]).toBeCloseTo(x, 8);
      expect(p[1]).toBeCloseTo(y, 8);
    });
  test("fisheye projection matches OpenCV", () => {
    const c = parseHandCalibration({
      ...calibration,
      model: "opencv_fisheye",
      distortion: d.slice(0, 4),
    })!;
    const p = projectHandPoint([0.1, 0.2, 1.5], c)!;
    expect(p[0]).toBeCloseTo(359.7941667826154, 8);
    expect(p[1]).toBeCloseTo(320.9148057913179, 8);
  });
  test("points behind the image plane never appear", () => {
    expect(projectHandPoint([0, 0, -1], metadata.calibration!)).toBeNull();
    expect(projectHandPoint([0, 0, 0], metadata.calibration!)).toBeNull();
  });
});

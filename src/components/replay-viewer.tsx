"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  Html,
  Environment,
  Lightformer,
} from "@react-three/drei";
import * as THREE from "three";
import { loadUsd, type LoadResult } from "@huggingface/usd-web-viewer";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { loadEpisodeFlatChartData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import ReplayPlaybackBar from "@/components/replay-playback-bar";
import RobotLoader, { type LoaderRobot } from "@/components/robot-loader";
import { CHART_CONFIG } from "@/utils/constants";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";
import { useTheme } from "@/utils/theme";

const SERIES_DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER;
const DEG2RAD = Math.PI / 180;

/// USD models of the robots: each draws its robot and, through its joints, moves it.
const USD_BASE_URL =
  "https://huggingface.co/datasets/lerobot/robot-usds/resolve/main";

/// Kept for the session: the viewer remounts on every visit to the 3D Replay tab.
const usdBlobCache = new Map<string, Promise<Blob>>();

function loadUsdBlob(url: string): Promise<Blob> {
  let loading = usdBlobCache.get(url);
  if (!loading) {
    loading = fetch(url)
      .then((res) => {
        if (!res.ok)
          throw new Error(`Failed to load USD ${url} (HTTP ${res.status})`);
        return res.blob();
      })
      .catch((err) => {
        usdBlobCache.delete(url);
        throw err;
      });
    usdBlobCache.set(url, loading);
  }
  return loading;
}

/**
 * Starts downloading a robot's model into the cache. The viewer only mounts once the episode data has
 * loaded, and the model used to start downloading only then; calling this earlier overlaps the two.
 */
export function prefetchRobotModel(
  robotType: string | null,
  columns: string[],
) {
  /// A failed download leaves the cache, so the viewer tries again and reports it.
  loadUsdBlob(getRobotConfig(robotType, columns).usdUrl).catch(() => {});
}

/// Unitree's Dex1-1 grippers record `left_gripper | gripper_pos`, or `kLeftGripper`.
function hasDex1Grippers(columns: string[]): boolean {
  return columns.some((c) =>
    /\.(left|right)_gripper \||\| k(left|right)gripper$/i.test(c),
  );
}

/// `columns` as in the episode's chart data (`feature | name`), to tell the G1's hands apart.
function getRobotConfig(
  robotType: string | null,
  columns: string[],
): {
  robot: LoaderRobot;
  usdUrl: string;
  scale: number;
  /** Height of the model's root above the floor when the data has no base pose. */
  restHeight: number;
} {
  const lower = (robotType ?? "").toLowerCase();
  if (lower.includes("g1") || lower.includes("unitree")) {
    if (lower.includes("inspire")) {
      return {
        robot: "g1",
        usdUrl: `${USD_BASE_URL}/g1_body29_inspire/simready_usd/g1_body29_inspire.usd`,
        scale: 1,
        restHeight: 0.793,
      };
    }
    if (lower.includes("brainco")) {
      return {
        robot: "g1",
        usdUrl: `${USD_BASE_URL}/g1_body29_brainco/simready_usd/g1_body29_brainco.usd`,
        scale: 1,
        restHeight: 0.793,
      };
    }
    if (hasDex1Grippers(columns)) {
      return {
        robot: "g1",
        usdUrl: `${USD_BASE_URL}/g1_body29_dex1/simready_usd/g1_body29_dex1.usd`,
        scale: 1,
        restHeight: 0.793,
      };
    }
    return {
      robot: "g1",
      usdUrl: `${USD_BASE_URL}/g1_body29_hand14/simready_usd/g1_body29_hand14.usd`,
      scale: 1,
      /// The pelvis, standing on straight legs.
      restHeight: 0.793,
    };
  }
  if (lower.includes("openarm")) {
    return {
      robot: "openarm",
      usdUrl: `${USD_BASE_URL}/openarm_bimanual/simready_usd/openarm_bimanual.usd`,
      scale: 3,
      restHeight: 0,
    };
  }
  return {
    robot: "so101",
    usdUrl: `${USD_BASE_URL}/so101_new_calib/simready_usd/so101_new_calib.usd`,
    scale: 10,
    restHeight: 0,
  };
}

// Detect unit: servo ticks (0-4096), degrees (>6.28), or radians
function detectAndConvert(values: number[]): number[] {
  if (values.length === 0) return values;
  const max = Math.max(...values.map(Math.abs));
  if (max > 360) return values.map((v) => ((v - 2048) / 2048) * Math.PI); // servo ticks
  if (max > 6.3) return values.map((v) => v * DEG2RAD); // degrees
  return values; // already radians
}

function groupColumnsByPrefix(keys: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const key of keys) {
    if (key === "timestamp") continue;
    const parts = key.split(SERIES_DELIM);
    const feature = parts.length > 1 ? parts[0].trim() : "other";
    /// Features split under observation.state or action (Unitree's left_arm, lower_body...) are one
    /// source, so a robot's joints map from all of them.
    const prefix =
      feature.match(/^(observation\.state|action)\./)?.[1] ?? feature;
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(key);
  }
  return groups;
}

// Unitree G1 SDK column suffix → joint name. Unitree's own datasets leave out the `.q`.
const G1_SDK_TO_JOINT: Record<string, string> = {
  "klefthippitch.q": "left_hip_pitch_joint",
  "klefthiproll.q": "left_hip_roll_joint",
  "klefthipyaw.q": "left_hip_yaw_joint",
  "kleftknee.q": "left_knee_joint",
  "kleftanklepitch.q": "left_ankle_pitch_joint",
  "kleftankleroll.q": "left_ankle_roll_joint",
  "krighthippitch.q": "right_hip_pitch_joint",
  "krighthiproll.q": "right_hip_roll_joint",
  "krighthipyaw.q": "right_hip_yaw_joint",
  "krightknee.q": "right_knee_joint",
  "krightanklepitch.q": "right_ankle_pitch_joint",
  "krightankleroll.q": "right_ankle_roll_joint",
  "kwaistyaw.q": "waist_yaw_joint",
  "kwaistroll.q": "waist_roll_joint",
  "kwaistpitch.q": "waist_pitch_joint",
  "kleftshoulderpitch.q": "left_shoulder_pitch_joint",
  "kleftshoulderroll.q": "left_shoulder_roll_joint",
  "kleftshoulderyaw.q": "left_shoulder_yaw_joint",
  "kleftelbow.q": "left_elbow_joint",
  "kleftwristroll.q": "left_wrist_roll_joint",
  "kleftwristpitch.q": "left_wrist_pitch_joint",
  "kleftwristyaw.q": "left_wrist_yaw_joint",
  "krightshoulderpitch.q": "right_shoulder_pitch_joint",
  "krightshoulderroll.q": "right_shoulder_roll_joint",
  "krightshoulderyaw.q": "right_shoulder_yaw_joint",
  "krightelbow.q": "right_elbow_joint",
  "krightwristroll.q": "right_wrist_roll_joint",
  "krightwristpitch.q": "right_wrist_pitch_joint",
  "krightwristyaw.q": "right_wrist_yaw_joint",
  "klefthandthumb0.q": "left_hand_thumb_0_joint",
  "klefthandthumb1.q": "left_hand_thumb_1_joint",
  "klefthandthumb2.q": "left_hand_thumb_2_joint",
  "klefthandmiddle0.q": "left_hand_middle_0_joint",
  "klefthandmiddle1.q": "left_hand_middle_1_joint",
  "klefthandindex0.q": "left_hand_index_0_joint",
  "klefthandindex1.q": "left_hand_index_1_joint",
  "krighthandthumb0.q": "right_hand_thumb_0_joint",
  "krighthandthumb1.q": "right_hand_thumb_1_joint",
  "krighthandthumb2.q": "right_hand_thumb_2_joint",
  "krighthandmiddle0.q": "right_hand_middle_0_joint",
  "krighthandmiddle1.q": "right_hand_middle_1_joint",
  "krighthandindex0.q": "right_hand_index_0_joint",
  "krighthandindex1.q": "right_hand_index_1_joint",
};

function autoMatchJoints(
  jointNames: string[],
  columnKeys: string[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const suffixes = columnKeys.map((k) =>
    (k.split(SERIES_DELIM).pop()?.trim() ?? k).toLowerCase(),
  );

  /// A side named by the feature rather than the column (`left_arm | shoulder_pitch`) joins the name.
  const sided = columnKeys.map((k, i) => {
    const side = k.split(SERIES_DELIM)[0].match(/\.(left|right)_[^.]*$/)?.[1];
    return side && !suffixes[i].startsWith(`${side}_`)
      ? `${side}_${suffixes[i]}`
      : suffixes[i];
  });

  // Build reverse lookup: joint name → column key (for G1 SDK-style columns)
  const g1Reverse = new Map<string, string>();
  for (let i = 0; i < suffixes.length; i++) {
    const jointName =
      G1_SDK_TO_JOINT[suffixes[i]] ?? G1_SDK_TO_JOINT[`${suffixes[i]}.q`];
    if (jointName) g1Reverse.set(jointName, columnKeys[i]);
  }

  for (const jointName of jointNames) {
    const lower = jointName.toLowerCase();

    // Exact match on column suffix
    const exactIdx = suffixes.findIndex((s) => s === lower);
    if (exactIdx >= 0) {
      mapping[jointName] = columnKeys[exactIdx];
      continue;
    }

    // G1 / Unitree SDK name match
    const g1Col = g1Reverse.get(lower);
    if (g1Col) {
      mapping[jointName] = g1Col;
      continue;
    }

    // Without the `_joint` suffix: left_hip_pitch_joint → `left_hip_pitch`, or `hip_pitch` in left_leg
    const sidedIdx = sided.indexOf(lower.replace(/_joint$/, ""));
    if (sidedIdx >= 0) {
      mapping[jointName] = columnKeys[sidedIdx];
      continue;
    }

    // OpenArm: openarm_(left|right)_joint(\d+) → (left|right)_joint_(\d+) or (left|right)_joint(\d+),
    // whole words so joint1 doesn't take joint10
    const armMatch = lower.match(/^openarm_(left|right)_joint(\d+)$/);
    if (armMatch) {
      const pattern = new RegExp(
        `(^|_)${armMatch[1]}_joint_?${armMatch[2]}(\\D|$)`,
      );
      const idx = suffixes.findIndex((s) => pattern.test(s));
      if (idx >= 0) {
        mapping[jointName] = columnKeys[idx];
        continue;
      }
    }

    // OpenArm: openarm_(left|right)_finger_joint1 → (left|right)_gripper
    const fingerMatch = lower.match(/^openarm_(left|right)_finger_joint1$/);
    if (fingerMatch) {
      const pattern = `${fingerMatch[1]}_gripper`;
      const idx = suffixes.findIndex((s) => s.includes(pattern));
      if (idx >= 0) {
        mapping[jointName] = columnKeys[idx];
        continue;
      }
    }

    // Dex1: both fingers of (left|right)_dex1 → `left_gripper | gripper_pos` or `kLeftGripper`
    const dex1Match = lower.match(/^(left|right)_dex1_finger_joint_[12]$/);
    if (dex1Match) {
      const idx = sided.findIndex((s) =>
        s
          .replace(/^k/, "")
          .replace(/_/g, "")
          .startsWith(`${dex1Match[1]}gripper`),
      );
      if (idx >= 0) {
        mapping[jointName] = columnKeys[idx];
        continue;
      }
    }

    // Inspire: (L|R)_<finger>_proximal_joint and the thumb's yaw and pitch → `left_fig6d | index`,
    // `little`, `thumb_lat` and `thumb_oc`
    const inspireMatch = lower.match(INSPIRE_JOINT);
    if (inspireMatch) {
      const [, side, finger, thumbAxis] = inspireMatch;
      const name =
        finger === "pinky"
          ? "little"
          : thumbAxis === "yaw"
            ? "thumb_lat"
            : thumbAxis === "pitch"
              ? "thumb_oc"
              : finger;
      const idx = sided.indexOf(`${side === "l" ? "left" : "right"}_${name}`);
      if (idx >= 0) {
        mapping[jointName] = columnKeys[idx];
        continue;
      }
    }

    // BrainCo: <side>_<finger>_proximal_joint and the thumb's metacarpal (sideways) and proximal
    // (bending) joints → `left_fig6d | index`, `little`, `thumb_lat` and `thumb_oc`
    const braincoMatch = lower.match(BRAINCO_JOINT);
    if (braincoMatch) {
      const [, side, finger, thumbJoint] = braincoMatch;
      const name =
        finger === "pinky"
          ? "little"
          : thumbJoint === "metacarpal"
            ? "thumb_lat"
            : thumbJoint === "proximal"
              ? "thumb_oc"
              : finger;
      const idx = sided.indexOf(`${side}_${name}`);
      if (idx >= 0) {
        mapping[jointName] = columnKeys[idx];
        continue;
      }
    }

    // Generic fuzzy fallback
    const fuzzy = columnKeys.find((k) => k.toLowerCase().includes(lower));
    if (fuzzy) mapping[jointName] = fuzzy;
  }
  return mapping;
}

const BASE_POSE_NAMES = ["x", "y", "z", "qx", "qy", "qz", "qw"];
const Z_UP_TO_Y_UP = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

/// The columns of a floating base's pose in the world (x, y, z, qx, qy, qz, qw), such as Unitree's
/// `state_base_pose`.
function findBasePoseColumns(columnKeys: string[]): string[] | null {
  const feature = columnKeys
    .map((k) => k.split(SERIES_DELIM)[0])
    .find((f) => f.endsWith("base_pose"));
  if (!feature) return null;
  const columns = BASE_POSE_NAMES.map((n) => `${feature}${SERIES_DELIM}${n}`);
  return columns.every((c) => columnKeys.includes(c)) ? columns : null;
}

const SINGLE_ARM_TIP_NAMES = [
  "gripper_frame_link",
  "gripperframe",
  "gripper_link",
  "gripper",
];
const DUAL_ARM_TIP_NAMES = ["openarm_left_hand_tcp", "openarm_right_hand_tcp"];
/// The hands' palms (Dex3) or bases (Inspire, BrainCo), or the Dex1 grippers' bases: all on the
/// wrist's flange.
const G1_TIP_NAMES = [
  "left_hand_palm_link",
  "right_hand_palm_link",
  "left_dex1_base_link",
  "right_dex1_base_link",
  "L_hand_base_link",
  "R_hand_base_link",
  "left_base_link",
  "right_base_link",
];
/// Unitree's Dex1-1 gripper motor turns 5.4 rad from closed to open, each finger sliding from
/// -0.02 m to 0.0245 m.
const DEX1_MOTOR_TRAVEL = 5.4;
const DEX1_FINGER_CLOSED = -0.02;
const DEX1_FINGER_OPEN = 0.0245;
/// The Inspire hands' motors: a finger's proximal joint, or the thumb's yaw or pitch. The other
/// finger joints follow them (mimic joints).
const INSPIRE_JOINT =
  /^([lr])_(index|middle|ring|pinky|thumb)_proximal(?:_(yaw|pitch))?_joint$/i;

/**
 * An Inspire motor's joint angle from its recorded value, 1 open to 0 closed (Unitree's
 * xr_teleoperate): fingers curl to 1.7 rad, the thumb bends to 0.5 rad and turns from 1.3 to -0.1 rad.
 */
function inspireJointValue(joint: string, open: number): number {
  if (joint.endsWith("_yaw_joint")) return 1.3 - 1.4 * open;
  if (joint.endsWith("_pitch_joint")) return 0.5 * (1 - open);
  return 1.7 * (1 - open);
}

/// The BrainCo hands' motors: a finger's proximal joint, or the thumb's metacarpal or proximal
/// joint. The distal joints follow them (mimic joints).
const BRAINCO_JOINT =
  /^(left|right)_(?:(index|middle|ring|pinky)_proximal|thumb_(metacarpal|proximal))_joint$/i;

/**
 * A BrainCo motor's joint angle from its recorded value, 1 open to 0 closed: Unitree records one
 * minus the hand's closure, which spans each joint's range (1.52 rad for the thumb's metacarpal
 * joint, 1.05 for its proximal joint, 1.47 for the fingers).
 */
function braincoJointValue(joint: string, open: number): number {
  if (joint.endsWith("_thumb_metacarpal_joint")) return 1.5184 * (1 - open);
  if (joint.endsWith("_thumb_proximal_joint")) return 1.0472 * (1 - open);
  return 1.4661 * (1 - open);
}

/// A joint whose limits are equal, like the BrainCo fingertips', stays where they put it.
function isLocked(joint: LoadResult["joints"][number]): boolean {
  return (
    (joint.kind === "revolute" || joint.kind === "prismatic") &&
    joint.lower !== null &&
    joint.lower === joint.upper
  );
}
const TRAIL_DURATION = 1.0;
const TRAIL_COLORS = [new THREE.Color("#ff6600"), new THREE.Color("#00aaff")];
const MAX_TRAIL_POINTS = 300;

/**
 * Frames the robot's world-space bounding box. Models can have a world→base offset (SO-arm does) that
 * puts the robot far from origin, so a fixed camera pose crops the arm.
 */
function fitCameraToRobot(
  robot: THREE.Object3D,
  camera: THREE.Camera,
  controls: unknown,
) {
  const bbox = new THREE.Box3().setFromObject(robot);
  if (bbox.isEmpty()) return;
  const center = bbox.getCenter(new THREE.Vector3());
  const sizeVec = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
  const fov = ((camera as THREE.PerspectiveCamera).fov ?? 45) * (Math.PI / 180);
  const distance = (maxDim / 2 / Math.tan(fov / 2)) * 1.6;
  const dir = new THREE.Vector3(1, 0.85, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.lookAt(center);
  (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
  const orbit = controls as { target?: THREE.Vector3; update?: () => void };
  if (orbit?.target) {
    orbit.target.copy(center);
    orbit.update?.();
  }
}

/** Frames to wait for joint values before fitting anyway (a robot with no mapped joints). */
const MAX_FIT_WAIT_FRAMES = 30;

// ─── Robot scene (imperative, inside Canvas) ───
function RobotScene({
  robot,
  usdUrl,
  jointValues,
  basePose,
  onJointsLoaded,
  trailEnabled,
  trailResetKey,
  scale,
}: {
  robot: LoaderRobot;
  usdUrl: string;
  jointValues: Record<string, number>;
  basePose: number[];
  onJointsLoaded: (names: string[]) => void;
  trailEnabled: boolean;
  trailResetKey: number;
  scale: number;
}) {
  const { scene, size, invalidate } = useThree();
  const modelRef = useRef<LoadResult | null>(null);
  /// The joints the data drives, by name: a mimic joint follows its joint and a locked one doesn't
  /// move, so neither is one.
  const jointsRef = useRef(
    new Map<string, { path: string; revolute: boolean }>(),
  );
  /// Prim paths whose positions the trails follow.
  const tipPathsRef = useRef<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  type TrailState = {
    positions: Float32Array;
    colors: Float32Array;
    times: number[];
    count: number;
  };
  const trailsRef = useRef<TrailState[]>([]);
  const linesRef = useRef<Line2[]>([]);
  const trailMatsRef = useRef<LineMaterial[]>([]);
  const trailCountRef = useRef(0);
  /// Set once the model loads; the frame loop fits the camera on the first frame that has the
  /// episode's pose applied, since the joint values arrive a render later.
  const pendingFitRef = useRef(false);
  const pendingFitFramesRef = useRef(0);
  const framesSinceInputRef = useRef(0);

  // Reset trails when episode changes
  useEffect(() => {
    for (const t of trailsRef.current) {
      t.count = 0;
      t.times = [];
    }
    for (const l of linesRef.current) l.visible = false;
  }, [trailResetKey]);

  /// useFrame applies these, so R3F can't tell they changed: request a frame and restart the trail
  /// keep-alive in useFrame.
  useEffect(() => {
    framesSinceInputRef.current = 0;
    invalidate();
  }, [jointValues, basePose, trailEnabled, trailResetKey, invalidate]);

  // Create/destroy trail Line2 objects when tip count changes
  const ensureTrails = useCallback(
    (count: number) => {
      if (trailCountRef.current === count) return;
      // Remove old
      for (const l of linesRef.current) {
        scene.remove(l);
        l.geometry.dispose();
      }
      for (const m of trailMatsRef.current) m.dispose();
      // Create new
      const trails: TrailState[] = [];
      const lines: Line2[] = [];
      const mats: LineMaterial[] = [];
      for (let i = 0; i < count; i++) {
        trails.push({
          positions: new Float32Array(MAX_TRAIL_POINTS * 3),
          colors: new Float32Array(MAX_TRAIL_POINTS * 3),
          times: [],
          count: 0,
        });
        const mat = new LineMaterial({
          color: 0xffffff,
          linewidth: 4,
          vertexColors: true,
          transparent: true,
          worldUnits: false,
          // Like the background, so a faded point matches it.
          toneMapped: false,
        });
        mat.resolution.set(window.innerWidth, window.innerHeight);
        mats.push(mat);
        const line = new Line2(new LineGeometry(), mat);
        line.frustumCulled = false;
        line.visible = false;
        lines.push(line);
        scene.add(line);
      }
      trailsRef.current = trails;
      linesRef.current = lines;
      trailMatsRef.current = mats;
      trailCountRef.current = count;
    },
    [scene],
  );

  useEffect(() => {
    setError(null);
    let cancelled = false;
    let model: LoadResult | undefined;
    /// Loaded from memory, so the session cache spares a download on every visit to the tab.
    const name = usdUrl.slice(usdUrl.lastIndexOf("/") + 1);
    loadUsdBlob(usdUrl)
      .then((blob) => loadUsd(name, { files: new Map([[name, blob]]) }))
      .then((loaded) => {
        if (cancelled) return loaded.dispose();
        model = loaded;
        modelRef.current = loaded;
        const { root, info, joints } = loaded;
        /// On top of meters per unit, which the loader sets.
        root.scale.multiplyScalar(scale);
        root.traverse((c) => {
          c.castShadow = true;
          if (robot !== "openarm") c.receiveShadow = true;
        });
        scene.add(root);

        /// Frames are often meshless points, like a gripper's tip; the G1's palms are meshes.
        const prims = [
          ...info.physics.bodies.map((b) => b.path),
          ...info.physics.frames.map((f) => f.path),
          ...root.children.map((c) => c.name),
        ];
        const tips: string[] = [];
        for (const tipName of robot === "g1"
          ? G1_TIP_NAMES
          : robot === "openarm"
            ? DUAL_ARM_TIP_NAMES
            : SINGLE_ARM_TIP_NAMES) {
          const path = prims.find((p) => p.endsWith(`/${tipName}`));
          if (path) tips.push(path);
          if (robot === "so101" && tips.length === 1) break;
        }
        tipPathsRef.current = tips;
        ensureTrails(tips.length);

        jointsRef.current = new Map(
          joints
            .filter((j) => !j.mimic && !isLocked(j))
            .map((j) => [
              j.path.slice(j.path.lastIndexOf("/") + 1),
              { path: j.path, revolute: j.kind === "revolute" },
            ]),
        );
        onJointsLoaded([...jointsRef.current.keys()]);
        pendingFitRef.current = true;
        pendingFitFramesRef.current = 0;
        invalidate();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Error loading the robot model:", err);
        setError(String(err));
      });
    return () => {
      cancelled = true;
      if (model) {
        scene.remove(model.root);
        model.dispose();
      }
      modelRef.current = null;
      tipPathsRef.current = [];
    };
  }, [robot, usdUrl, scale, scene, onJointsLoaded, ensureTrails, invalidate]);

  const tipWorldPos = useMemo(() => new THREE.Vector3(), []);
  const fadeFrom = useMemo(() => new THREE.Color(), []);
  const fadeTo = useMemo(() => new THREE.Color(), []);
  const fadedColor = useMemo(() => new THREE.Color(), []);
  const baseQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame((state) => {
    const model = modelRef.current;
    if (!model) return;

    /// The robot stays above the origin, where the camera looks, and the floor moves under it. The
    /// robots' USDs are Z-up, like the base pose.
    const [, , z, qx, qy, qz, qw] = basePose;
    model.root.position.set(0, z * scale, 0);
    model.root.quaternion
      .copy(Z_UP_TO_Y_UP)
      .multiply(baseQuat.set(qx, qy, qz, qw));
    const positions: Record<string, number> = {};
    for (const [name, value] of Object.entries(jointValues)) {
      const joint = jointsRef.current.get(name);
      if (joint)
        positions[joint.path] = joint.revolute ? value / DEG2RAD : value;
    }
    model.setJointPositions(positions);

    if (pendingFitRef.current) {
      pendingFitFramesRef.current++;
      if (
        Object.keys(jointValues).length > 0 ||
        pendingFitFramesRef.current > MAX_FIT_WAIT_FRAMES
      ) {
        pendingFitRef.current = false;
        fitCameraToRobot(model.root, state.camera, state.controls);
      }
    }

    /// The fit wait counts rendered frames and the trail appends a point per rendered frame: keep
    /// rendering until the fit is done and for MAX_TRAIL_POINTS frames after the last change, so
    /// the trail fades and collapses as it did when every display frame rendered.
    if (
      pendingFitRef.current ||
      (trailEnabled && framesSinceInputRef.current++ < MAX_TRAIL_POINTS)
    )
      state.invalidate();

    const tips = tipPathsRef.current;
    if (!trailEnabled || tips.length === 0) {
      for (const l of linesRef.current) l.visible = false;
      return;
    }

    const now = performance.now() / 1000;
    for (let ti = 0; ti < tips.length; ti++) {
      const trail = trailsRef.current[ti];
      const line = linesRef.current[ti];
      const mat = trailMatsRef.current[ti];
      if (!trail || !line || !mat) continue;

      mat.resolution.set(size.width, size.height);
      tipWorldPos.setFromMatrixPosition(model.getWorldMatrix(tips[ti])!);
      const trailColor = TRAIL_COLORS[ti % TRAIL_COLORS.length];

      if (trail.count < MAX_TRAIL_POINTS) {
        trail.count++;
      } else {
        trail.positions.copyWithin(0, 3);
        trail.colors.copyWithin(0, 3);
        trail.times.shift();
      }
      const idx = trail.count - 1;
      trail.positions[idx * 3] = tipWorldPos.x;
      trail.positions[idx * 3 + 1] = tipWorldPos.y;
      trail.positions[idx * 3 + 2] = tipWorldPos.z;
      trail.times.push(now);

      /// Line2 has no per-vertex alpha: points fade into the background color, mixed in sRGB as
      /// alpha blending would, and are dropped once faded, so no dark tail is left behind the tip.
      const expired = trail.times.findIndex((t) => now - t < TRAIL_DURATION);
      if (expired > 0) {
        trail.positions.copyWithin(0, expired * 3, trail.count * 3);
        trail.times.splice(0, expired);
        trail.count -= expired;
      }
      fadeFrom
        .copy(state.scene.background as THREE.Color)
        .convertLinearToSRGB();
      fadeTo.copy(trailColor).convertLinearToSRGB();
      for (let i = 0; i < trail.count; i++) {
        fadedColor
          .lerpColors(
            fadeFrom,
            fadeTo,
            1 - (now - trail.times[i]) / TRAIL_DURATION,
          )
          .convertSRGBToLinear();
        trail.colors[i * 3] = fadedColor.r;
        trail.colors[i * 3 + 1] = fadedColor.g;
        trail.colors[i * 3 + 2] = fadedColor.b;
      }

      if (trail.count < 2) {
        line.visible = false;
        continue;
      }
      const geo = new LineGeometry();
      geo.setPositions(
        Array.from(trail.positions.subarray(0, trail.count * 3)),
      );
      geo.setColors(Array.from(trail.colors.subarray(0, trail.count * 3)));
      line.geometry.dispose();
      line.geometry = geo;
      line.computeLineDistances();
      line.visible = true;
    }
  });

  // Loading state is rendered by the outer overlay (via modelLoading) so we
  // don't show two stacked spinners. The error state still surfaces inline
  // since the overlay doesn't have an error path.
  if (error)
    return (
      <Html center>
        <span className="text-red-400">Failed to load the 3D model</span>
      </Html>
    );
  return null;
}

// ─── Playback ticker ───
function PlaybackDriver({
  playing,
  fps,
  totalFrames,
  frameRef,
  setFrame,
}: {
  playing: boolean;
  fps: number;
  totalFrames: number;
  frameRef: React.MutableRefObject<number>;
  setFrame: React.Dispatch<React.SetStateAction<number>>;
}) {
  const elapsed = useRef(0);
  const last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf: number;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - last.current) / 1000;
      last.current = now;
      if (dt > 0 && dt < 0.5) {
        elapsed.current += dt;
        const fd = Math.floor(elapsed.current * fps);
        if (fd > 0) {
          elapsed.current -= fd / fps;
          frameRef.current = (frameRef.current + fd) % totalFrames;
          setFrame(frameRef.current);
        }
      }
    };
    last.current = performance.now();
    elapsed.current = 0;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, totalFrames, frameRef, setFrame]);
  return null;
}

// IBL: procedural studio softboxes give mesh highlights somewhere to bounce.
// Not preset="studio": drei downloads that 1.6 MB HDR from raw.githack.com and
// suspends the canvas until it arrives. Module scope keeps the element's
// identity across ReplayViewer renders (one per playback frame): drei re-captures
// the cube map and three re-runs PMREM whenever Environment's children change.
const STUDIO_ENVIRONMENT = (
  <Environment resolution={256} background={false}>
    <Lightformer
      form="rect"
      intensity={5}
      position={[0, 5, 0]}
      rotation-x={Math.PI / 2}
      scale={[10, 10, 1]}
    />
    <Lightformer
      form="rect"
      intensity={3}
      position={[-5, 1.5, -1]}
      rotation-y={Math.PI / 2}
      scale={[10, 2, 1]}
    />
    <Lightformer
      form="rect"
      intensity={3}
      position={[5, 1.5, -1]}
      rotation-y={-Math.PI / 2}
      scale={[10, 2, 1]}
    />
    <Lightformer
      form="rect"
      intensity={2.5}
      position={[0, 1.5, 5]}
      rotation-y={Math.PI}
      scale={[10, 3, 1]}
    />
  </Environment>
);

// ═══════════════════════════════════════
// ─── Main 3D Replay viewer ───
// ═══════════════════════════════════════
export default function ReplayViewer({
  data,
  org,
  dataset,
  episodeChangerRef,
  playToggleRef,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
  episodeChangerRef?: React.RefObject<((ep: number) => void) | undefined>;
  playToggleRef?: React.RefObject<(() => void) | undefined>;
}) {
  const { datasetInfo } = data;
  const fps = datasetInfo.fps || 30;
  /// Three.js needs real colours, so the scene reads the theme instead of CSS variables.
  const dark = useTheme() === "dark";
  const robotConfig = useMemo(
    () =>
      getRobotConfig(
        datasetInfo.robot_type,
        Object.keys(data.flatChartData[0] ?? {}),
      ),
    [datasetInfo.robot_type, data.flatChartData],
  );
  const { robot, usdUrl, scale, restHeight } = robotConfig;
  const isG1 = robot === "g1";
  const isOpenArm = robot === "openarm";
  const repoId = useMemo(
    () =>
      org && dataset
        ? { repoId: `${org}/${dataset}`, path: datasetInfo.path }
        : null,
    [org, dataset, datasetInfo.path],
  );
  const datasetInfoRef = useRef<{
    version: string;
    info: DatasetMetadata;
  } | null>(null);

  const ensureDatasetInfo = useCallback(async () => {
    if (!repoId) return null;
    if (datasetInfoRef.current) return datasetInfoRef.current;
    const { version, info } = await getDatasetVersionAndInfo(repoId);
    const payload = { version, info: info as unknown as DatasetMetadata };
    datasetInfoRef.current = payload;
    return payload;
  }, [repoId]);

  // Episode selection & chart data
  const [selectedEpisode, setSelectedEpisode] = useState(data.episodeId);
  const [chartData, setChartData] = useState(data.flatChartData);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const chartDataCache = useRef<Record<number, Record<string, number>[]>>({
    [data.episodeId]: data.flatChartData,
  });
  /// A slower load for an earlier pick must not overwrite the episode picked since.
  const latestEpisodeRef = useRef(data.episodeId);

  const handleEpisodeChange = useCallback(
    (epId: number) => {
      latestEpisodeRef.current = epId;
      setSelectedEpisode(epId);
      setFrame(0);
      frameRef.current = 0;
      setPlaying(false);

      if (chartDataCache.current[epId]) {
        setChartData(chartDataCache.current[epId]);
        setEpisodeLoading(false);
        return;
      }

      if (!repoId) return;
      setEpisodeLoading(true);
      ensureDatasetInfo()
        .then((payload) => {
          if (!payload) return null;
          return loadEpisodeFlatChartData(
            repoId,
            payload.version,
            payload.info,
            epId,
          );
        })
        .then((result) => {
          if (!result) return;
          chartDataCache.current[epId] = result;
          if (latestEpisodeRef.current === epId) setChartData(result);
        })
        .catch((err) => console.error("Failed to load episode:", err))
        .finally(() => {
          if (latestEpisodeRef.current === epId) setEpisodeLoading(false);
        });
    },
    [ensureDatasetInfo, repoId],
  );

  useEffect(() => {
    if (episodeChangerRef) episodeChangerRef.current = handleEpisodeChange;
  }, [episodeChangerRef, handleEpisodeChange]);

  const totalFrames = chartData.length;

  // The model's joint names
  const [jointNames, setJointNames] = useState<string[]>([]);
  const onJointsLoaded = useCallback(
    (names: string[]) => setJointNames(names),
    [],
  );

  // Feature groups
  const columnGroups = useMemo(() => {
    if (totalFrames === 0) return {};
    return groupColumnsByPrefix(Object.keys(chartData[0]));
  }, [chartData, totalFrames]);

  const groupNames = useMemo(() => Object.keys(columnGroups), [columnGroups]);
  const defaultGroup = useMemo(
    () =>
      groupNames.find((g) => g.toLowerCase().includes("state")) ??
      groupNames.find((g) => g.toLowerCase().includes("action")) ??
      groupNames[0] ??
      "",
    [groupNames],
  );

  const [selectedGroup, setSelectedGroup] = useState(defaultGroup);
  useEffect(() => setSelectedGroup(defaultGroup), [defaultGroup]);
  const selectedColumns = useMemo(
    () => columnGroups[selectedGroup] ?? [],
    [columnGroups, selectedGroup],
  );

  // Joint mapping
  const autoMapping = useMemo(
    () => autoMatchJoints(jointNames, selectedColumns),
    [jointNames, selectedColumns],
  );
  const [mapping, setMapping] = useState<Record<string, string>>(autoMapping);
  useEffect(() => setMapping(autoMapping), [autoMapping]);
  const basePoseColumns = useMemo(
    () => findBasePoseColumns(selectedColumns),
    [selectedColumns],
  );

  // Trail
  const [trailEnabled, setTrailEnabled] = useState(true);
  const [showMapping, setShowMapping] = useState(false);

  // Playback
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef(0);

  const handleFrameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = parseInt(e.target.value);
      setFrame(f);
      frameRef.current = f;
    },
    [],
  );

  // The model downloads async from the Hub. Until its joints are reported
  // back, playback/scrub inputs would drive an empty scene, so we gate
  // interactions (and pause if already playing).
  const modelLoading = jointNames.length === 0;

  useEffect(() => {
    if (modelLoading) setPlaying(false);
  }, [modelLoading]);

  const handlePlayPause = useCallback(() => {
    if (modelLoading) return;
    setPlaying((prev) => {
      if (!prev) frameRef.current = frame;
      return !prev;
    });
  }, [frame, modelLoading]);

  useEffect(() => {
    if (playToggleRef) playToggleRef.current = handlePlayPause;
  }, [playToggleRef, handlePlayPause]);

  // Auto-detect gripper column range for linear mapping to 0-0.044m
  const gripperRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {};
    for (const jn of jointNames) {
      if (!jn.toLowerCase().includes("finger_joint1")) continue;
      const col = mapping[jn];
      if (!col) continue;
      let min = Infinity,
        max = -Infinity;
      for (const row of chartData) {
        const v = row[col];
        if (typeof v === "number") {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min < max) ranges[jn] = { min, max };
    }
    return ranges;
  }, [chartData, mapping, jointNames]);

  // Compute joint values for current frame
  const jointValues = useMemo(() => {
    if (totalFrames === 0 || jointNames.length === 0) return {};
    const row = chartData[Math.min(frame, totalFrames - 1)];
    const revoluteValues: number[] = [];
    const revoluteNames: string[] = [];
    const values: Record<string, number> = {};

    for (const jn of jointNames) {
      const col = mapping[jn];
      /// The model refuses a value that isn't a finite number.
      if (!col || !Number.isFinite(row[col])) continue;
      const raw = row[col];

      if (jn.toLowerCase().includes("finger_joint1")) {
        // Map gripper range → 0-0.044m using auto-detected min/max
        const range = gripperRanges[jn];
        if (range) {
          const t = (raw - range.min) / (range.max - range.min);
          values[jn] = t * 0.044;
        } else {
          values[jn] = (raw / 100) * 0.044; // fallback: assume 0-100
        }
      } else if (INSPIRE_JOINT.test(jn)) {
        values[jn] = inspireJointValue(jn, raw);
      } else if (BRAINCO_JOINT.test(jn)) {
        values[jn] = braincoJointValue(jn, raw);
      } else if (jn.includes("_dex1_finger_joint_")) {
        values[jn] =
          DEX1_FINGER_CLOSED +
          (raw / DEX1_MOTOR_TRAVEL) * (DEX1_FINGER_OPEN - DEX1_FINGER_CLOSED);
      } else {
        revoluteValues.push(raw);
        revoluteNames.push(jn);
      }
    }

    const converted = detectAndConvert(revoluteValues);
    revoluteNames.forEach((n, i) => {
      values[n] = converted[i];
    });
    return values;
  }, [chartData, frame, gripperRanges, mapping, totalFrames, jointNames]);

  const basePose = useMemo(() => {
    if (!basePoseColumns || totalFrames === 0)
      return [0, 0, restHeight, 0, 0, 0, 1];
    const row = chartData[Math.min(frame, totalFrames - 1)];
    return basePoseColumns.map((c) => row[c]);
  }, [basePoseColumns, chartData, frame, restHeight, totalFrames]);

  if (data.flatChartData.length === 0) {
    return (
      <div className="text-fg-muted p-8 text-center">
        No trajectory data available.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 3D Viewport */}
      <div className="flex-1 min-h-0 bg-[var(--surface-0)] rounded-lg overflow-hidden border border-line relative">
        {(episodeLoading || modelLoading) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/80">
            {modelLoading ? (
              <RobotLoader
                robot={robot}
                caption={datasetInfo.robot_type ?? undefined}
              />
            ) : (
              <span className="text-fg text-lg animate-pulse">
                Loading episode {selectedEpisode}…
              </span>
            )}
          </div>
        )}
        <Canvas
          shadows
          frameloop="demand"
          camera={{
            position: isG1
              ? [1.5, 1.0, 1.5]
              : isOpenArm
                ? [0.95 * scale, 0.8 * scale, 0.95 * scale]
                : [0.3 * scale, 0.25 * scale, 0.3 * scale],
            fov: 45,
            near: 0.01,
            far: 100,
          }}
          gl={{
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.9,
          }}
        >
          <color attach="background" args={[dark ? "#141c2e" : "#f3f4f6"]} />
          {STUDIO_ENVIRONMENT}
          {/* 3-point studio rig — key is the only shadow caster */}
          <ambientLight intensity={0.12} />
          <directionalLight
            color="#fff2e3"
            position={[3, 5, 3]}
            intensity={1.0}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-near={0.1}
            shadow-camera-far={15}
            shadow-camera-left={-3}
            shadow-camera-right={3}
            shadow-camera-top={3}
            shadow-camera-bottom={-3}
            shadow-bias={-0.0005}
          />
          <directionalLight
            color="#bfd9ff"
            position={[-4, 2, -2]}
            intensity={0.25}
          />
          <directionalLight
            color="#ffffff"
            position={[0, 3, -4]}
            intensity={0.4}
          />
          {/* Ground-shadow catcher — invisible plane receives key-light shadow */}
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.001, 0]}
            receiveShadow
          >
            <planeGeometry args={[10, 10]} />
            <shadowMaterial opacity={0.35} />
          </mesh>
          <RobotScene
            robot={robot}
            usdUrl={usdUrl}
            jointValues={jointValues}
            basePose={basePose}
            onJointsLoaded={onJointsLoaded}
            trailEnabled={trailEnabled}
            trailResetKey={selectedEpisode}
            scale={scale}
          />
          <Grid
            args={[10, 10]}
            cellSize={isG1 ? 0.5 : 0.2}
            cellThickness={0.5}
            cellColor={dark ? "#334155" : "#d1d5db"}
            sectionSize={isG1 ? 2 : 1}
            sectionThickness={1}
            sectionColor={dark ? "#475569" : "#9ca3af"}
            fadeDistance={isG1 ? 20 : 10}
            infiniteGrid={basePoseColumns !== null}
            position={[-basePose[0] * scale, 0, basePose[1] * scale]}
          />
          <OrbitControls
            makeDefault
            target={isG1 ? [0, 0.5, 0] : [0, 0.8, 0]}
          />
          <PlaybackDriver
            playing={playing}
            fps={fps}
            totalFrames={totalFrames}
            frameRef={frameRef}
            setFrame={setFrame}
          />
        </Canvas>
      </div>

      {/* Controls */}
      <div className="bg-[var(--surface-1)]/90 border-t border-line p-3 space-y-3 shrink-0">
        <ReplayPlaybackBar
          frame={frame}
          totalFrames={totalFrames}
          fps={fps}
          playing={playing}
          onPlayPause={handlePlayPause}
          trailEnabled={trailEnabled}
          onTrailToggle={() => setTrailEnabled((v) => !v)}
          onFrameChange={handleFrameChange}
          disabled={modelLoading}
        />

        {/* Collapsible joint mapping */}
        <button
          onClick={() => setShowMapping((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
        >
          <span
            className={`transition-transform ${showMapping ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          Joint Mapping
          <span className="text-fg-faint">
            ({Object.keys(mapping).filter((k) => mapping[k]).length}/
            {jointNames.length} mapped)
          </span>
        </button>

        {showMapping && (
          <div className="flex flex-col lg:flex-row gap-3 lg:gap-4 lg:items-start">
            <div className="space-y-1 shrink-0">
              <label className="text-xs text-fg-muted">Data source</label>
              <div className="flex gap-1 flex-wrap">
                {groupNames.map((name) => (
                  <button
                    key={name}
                    onClick={() => setSelectedGroup(name)}
                    className={`btn ${selectedGroup === name ? "btn-active" : ""}`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--surface-1)]">
                  <tr className="text-fg-faint">
                    <th className="text-left font-normal px-1">Joint</th>
                    <th className="text-left font-normal px-1">→</th>
                    <th className="text-left font-normal px-1">
                      Dataset Column
                    </th>
                    <th className="text-right font-normal px-1">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {jointNames.map((jointName) => (
                    <tr key={jointName} className="border-t border-line">
                      <td className="px-1 py-0.5 text-fg-soft font-mono">
                        {jointName}
                      </td>
                      <td className="px-1 text-fg-faint">→</td>
                      <td className="px-1 py-0.5">
                        <select
                          value={mapping[jointName] ?? ""}
                          onChange={(e) =>
                            setMapping((m) => ({
                              ...m,
                              [jointName]: e.target.value,
                            }))
                          }
                          className="bg-[var(--surface-0)] text-fg text-xs rounded px-1 py-0.5 border border-line w-full max-w-[200px]"
                        >
                          <option value="">-- unmapped --</option>
                          {selectedColumns.map((col) => {
                            const label = col.split(SERIES_DELIM).pop() ?? col;
                            return (
                              <option key={col} value={col}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                      <td className="px-1 py-0.5 text-right tabular-nums text-fg-muted font-mono">
                        {jointValues[jointName] !== undefined
                          ? jointValues[jointName].toFixed(3)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

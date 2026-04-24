"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Html, Environment } from "@react-three/drei";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { loadEpisodeFlatChartData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import UrdfPlaybackBar from "@/components/urdf-playback-bar";
import { CHART_CONFIG } from "@/utils/constants";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";

const SERIES_DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER;
const DEG2RAD = Math.PI / 180;

// Module-level geometry cache — survives component remounts (tab switches,
// episode navigations). Avoids re-fetching and re-parsing STL files.
const stlGeometryCache = new Map<string, THREE.BufferGeometry>();
// In-flight promise cache — prevents duplicate simultaneous fetches
const stlGeometryLoading = new Map<string, Promise<THREE.BufferGeometry>>();

// URDFs + meshes are hosted in the Hub bucket at
// https://huggingface.co/buckets/lerobot/robot-urdfs. URDFLoader resolves
// relative mesh paths against the URDF's own URL, so the bucket layout
// mirrors the upstream directory tree. Note: buckets don't have branches,
// so the resolve URL has no "/main" segment.
const URDF_BASE_URL =
  process.env.NEXT_PUBLIC_URDF_BASE_URL ??
  "https://huggingface.co/buckets/lerobot/robot-urdfs/resolve";

function getRobotConfig(robotType: string | null) {
  const lower = (robotType ?? "").toLowerCase();
  if (lower.includes("g1") || lower.includes("unitree")) {
    return { urdfUrl: `${URDF_BASE_URL}/g1/g1_body29_hand14.urdf`, scale: 1 };
  }
  if (lower.includes("openarm")) {
    return {
      urdfUrl: `${URDF_BASE_URL}/openarm/openarm_bimanual.urdf`,
      scale: 3,
    };
  }
  if (lower.includes("so100") && !lower.includes("so101")) {
    return { urdfUrl: `${URDF_BASE_URL}/so101/so100.urdf`, scale: 10 };
  }
  return {
    urdfUrl: `${URDF_BASE_URL}/so101/so101_new_calib.urdf`,
    scale: 10,
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
    const prefix = parts.length > 1 ? parts[0].trim() : "other";
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(key);
  }
  return groups;
}

// Unitree G1 SDK column suffix → URDF joint name
const G1_SDK_TO_URDF: Record<string, string> = {
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
};

function autoMatchJoints(
  urdfJointNames: string[],
  columnKeys: string[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const suffixes = columnKeys.map((k) =>
    (k.split(SERIES_DELIM).pop()?.trim() ?? k).toLowerCase(),
  );

  // Build reverse lookup: URDF joint name → column key (for G1 SDK-style columns)
  const g1Reverse = new Map<string, string>();
  for (let i = 0; i < suffixes.length; i++) {
    const urdfName = G1_SDK_TO_URDF[suffixes[i]];
    if (urdfName) g1Reverse.set(urdfName, columnKeys[i]);
  }

  for (const jointName of urdfJointNames) {
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

    // OpenArm: openarm_(left|right)_joint(\d+) → (left|right)_joint_(\d+)
    const armMatch = lower.match(/^openarm_(left|right)_joint(\d+)$/);
    if (armMatch) {
      const pattern = `${armMatch[1]}_joint_${armMatch[2]}`;
      const idx = suffixes.findIndex((s) => s.includes(pattern));
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

    // finger_joint2 is a mimic joint — skip
    if (lower.includes("finger_joint2")) continue;

    // Generic fuzzy fallback
    const fuzzy = columnKeys.find((k) => k.toLowerCase().includes(lower));
    if (fuzzy) mapping[jointName] = fuzzy;
  }
  return mapping;
}

const SINGLE_ARM_TIP_NAMES = [
  "gripper_frame_link",
  "gripperframe",
  "gripper_link",
  "gripper",
];
const DUAL_ARM_TIP_NAMES = ["openarm_left_hand_tcp", "openarm_right_hand_tcp"];
const G1_TIP_NAMES = ["left_hand_palm_link", "right_hand_palm_link"];
const TRAIL_DURATION = 1.0;
const TRAIL_COLORS = [new THREE.Color("#ff6600"), new THREE.Color("#00aaff")];
const MAX_TRAIL_POINTS = 300;

// ─── Robot scene (imperative, inside Canvas) ───
function RobotScene({
  urdfUrl,
  jointValues,
  onJointsLoaded,
  trailEnabled,
  trailResetKey,
  scale,
}: {
  urdfUrl: string;
  jointValues: Record<string, number>;
  onJointsLoaded: (names: string[]) => void;
  trailEnabled: boolean;
  trailResetKey: number;
  scale: number;
}) {
  const { scene, size } = useThree();
  const robotRef = useRef<URDFRobot | null>(null);
  const tipLinksRef = useRef<THREE.Object3D[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Reset trails when episode changes
  useEffect(() => {
    for (const t of trailsRef.current) {
      t.count = 0;
      t.times = [];
    }
    for (const l of linesRef.current) l.visible = false;
  }, [trailResetKey]);

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
    setLoading(true);
    setError(null);
    const isOpenArm = urdfUrl.includes("openarm");
    const isG1 = urdfUrl.includes("g1");
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.loadMeshCb = (url, mgr, onLoad) => {
      // DAE (Collada) files — ColladaLoader yields whatever the .dae author
      // baked in: flat MeshPhongMaterial/MeshBasicMaterial colors plus, in
      // OpenArm's case, ~23 per-file PointLight/SpotLight nodes. The stray
      // lights caused the scene to look pure-white everywhere regardless of
      // our own lighting, and the flat materials looked cartoonish. We strip
      // both and rebuild every mesh with a MeshStandardMaterial bucketed into
      // one of three archetypes (carbon-black, brushed metal, off-white paint)
      // based on the original base-color lightness.
      if (url.endsWith(".dae")) {
        const colladaLoader = new ColladaLoader(mgr);
        colladaLoader.load(
          url,
          (collada) => {
            if (isOpenArm) {
              const strayLights: THREE.Object3D[] = [];
              collada.scene.traverse((child) => {
                if (
                  (child as THREE.Light).isLight &&
                  !(child instanceof THREE.AmbientLight)
                ) {
                  strayLights.push(child);
                }
              });
              for (const l of strayLights) l.parent?.remove(l);

              collada.scene.traverse((child) => {
                if (!(child instanceof THREE.Mesh) || !child.material) return;

                const originals = Array.isArray(child.material)
                  ? child.material
                  : [child.material];

                const rebuilt = originals.map((orig) => {
                  const srcColor =
                    (orig as THREE.MeshStandardMaterial).color ??
                    new THREE.Color("#c0c4cc");
                  const hsl = { h: 0, s: 0, l: 0 };
                  srcColor.getHSL(hsl);

                  // Archetype classification by original lightness.
                  let color: THREE.Color;
                  let metalness: number;
                  let roughness: number;
                  let envMapIntensity: number;
                  if (hsl.l < 0.3) {
                    // Carbon / anodised structural parts
                    color = new THREE.Color().setHSL(hsl.h, 0.02, 0.09);
                    metalness = 0.15;
                    roughness = 0.75;
                    envMapIntensity = 0.6;
                  } else if (hsl.l < 0.7) {
                    // Brushed metal joint collars / accents
                    color = new THREE.Color().setHSL(hsl.h, 0.04, 0.42);
                    metalness = 0.75;
                    roughness = 0.35;
                    envMapIntensity = 1.1;
                  } else {
                    // Off-white painted plates
                    color = new THREE.Color().setHSL(hsl.h, 0.03, 0.6);
                    metalness = 0.1;
                    roughness = 0.5;
                    envMapIntensity = 0.9;
                  }

                  const mat = new THREE.MeshStandardMaterial({
                    color,
                    metalness,
                    roughness,
                    envMapIntensity,
                    side: THREE.DoubleSide,
                  });
                  orig.dispose?.();
                  return mat;
                });

                child.material = Array.isArray(child.material)
                  ? rebuilt
                  : rebuilt[0];
                child.castShadow = true;
                child.receiveShadow = true;
              });
            }
            onLoad(collada.scene);
          },
          undefined,
          (err) => onLoad(new THREE.Object3D(), err as Error),
        );
        return;
      }
      // STL files — apply custom materials, with module-level geometry cache
      const makeMesh = (geometry: THREE.BufferGeometry) => {
        let color = "#FFD700";
        let metalness = 0.1;
        let roughness = 0.6;
        if (isG1) {
          const lower = url.toLowerCase();
          const isWhitePart =
            lower.includes("contour") ||
            lower.includes("roll_link") ||
            lower.includes("logo") ||
            lower.includes("rubber") ||
            lower.includes("constraint") ||
            lower.includes("support");
          color = isWhitePart ? "#9ca3af" : "#1f2937";
          metalness = 0.25;
          roughness = 0.6;
        } else if (url.includes("sts3215")) {
          color = "#1a1a1a";
          metalness = 0.7;
          roughness = 0.3;
        } else if (isOpenArm) {
          color = url.includes("body_link0") ? "#3a3a4a" : "#f5f5f5";
          metalness = 0.15;
          roughness = 0.6;
        }
        return new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color,
            metalness,
            roughness,
            side: isOpenArm ? THREE.DoubleSide : THREE.FrontSide,
          }),
        );
      };

      const cached = stlGeometryCache.get(url);
      if (cached) {
        onLoad(makeMesh(cached));
        return;
      }

      // Deduplicate in-flight requests for the same URL
      let loading = stlGeometryLoading.get(url);
      if (!loading) {
        loading = new Promise<THREE.BufferGeometry>((resolve, reject) => {
          new STLLoader(mgr).load(url, resolve, undefined, reject);
        }).then((geometry) => {
          stlGeometryCache.set(url, geometry);
          stlGeometryLoading.delete(url);
          return geometry;
        });
        stlGeometryLoading.set(url, loading);
      }
      loading
        .then((geometry) => onLoad(makeMesh(geometry)))
        .catch((err) => onLoad(new THREE.Object3D(), err as Error));
    };
    loader.load(
      urdfUrl,
      (robot) => {
        robotRef.current = robot;
        robot.rotateOnAxis(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        robot.traverse((c) => {
          c.castShadow = true;
        });
        robot.updateMatrixWorld(true);
        robot.scale.set(scale, scale, scale);
        scene.add(robot);

        const tipNames = isG1
          ? G1_TIP_NAMES
          : isOpenArm
            ? DUAL_ARM_TIP_NAMES
            : SINGLE_ARM_TIP_NAMES;
        const tips: THREE.Object3D[] = [];
        for (const name of tipNames) {
          if (robot.frames[name]) tips.push(robot.frames[name]);
          if (!isOpenArm && !isG1 && tips.length === 1) break;
        }
        tipLinksRef.current = tips;
        ensureTrails(tips.length);

        const movable = Object.values(robot.joints)
          .filter(
            (j) =>
              j.jointType === "revolute" ||
              j.jointType === "continuous" ||
              j.jointType === "prismatic",
          )
          .map((j) => j.name);
        onJointsLoaded(movable);
        setLoading(false);
      },
      undefined,
      (err) => {
        console.error("Error loading URDF:", err);
        setError(String(err));
        setLoading(false);
      },
    );
    return () => {
      if (robotRef.current) {
        scene.remove(robotRef.current);
        robotRef.current = null;
      }
      tipLinksRef.current = [];
    };
  }, [urdfUrl, scale, scene, onJointsLoaded, ensureTrails]);

  const tipWorldPos = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const robot = robotRef.current;
    if (!robot) return;

    for (const [name, value] of Object.entries(jointValues)) {
      robot.setJointValue(name, value);
    }
    robot.updateMatrixWorld(true);

    const tips = tipLinksRef.current;
    if (!trailEnabled || tips.length === 0) {
      for (const l of linesRef.current) l.visible = false;
      return;
    }

    const now = performance.now() / 1000;
    for (let ti = 0; ti < tips.length; ti++) {
      const tip = tips[ti];
      const trail = trailsRef.current[ti];
      const line = linesRef.current[ti];
      const mat = trailMatsRef.current[ti];
      if (!trail || !line || !mat) continue;

      mat.resolution.set(size.width, size.height);
      tip.getWorldPosition(tipWorldPos);
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

      for (let i = 0; i < trail.count; i++) {
        const t = Math.max(0, 1 - (now - trail.times[i]) / TRAIL_DURATION);
        trail.colors[i * 3] = trailColor.r * t;
        trail.colors[i * 3 + 1] = trailColor.g * t;
        trail.colors[i * 3 + 2] = trailColor.b * t;
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

  if (loading)
    return (
      <Html center>
        <span className="text-white text-lg">Loading robot…</span>
      </Html>
    );
  if (error)
    return (
      <Html center>
        <span className="text-red-400">Failed to load URDF</span>
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

// ═══════════════════════════════════════
// ─── Main URDF Viewer ───
// ═══════════════════════════════════════
export default function URDFViewer({
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
  const robotConfig = useMemo(
    () => getRobotConfig(datasetInfo.robot_type),
    [datasetInfo.robot_type],
  );
  const { urdfUrl, scale } = robotConfig;
  const isG1 = urdfUrl.includes("g1");
  const repoId = org && dataset ? `${org}/${dataset}` : null;
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

  const handleEpisodeChange = useCallback(
    (epId: number) => {
      setSelectedEpisode(epId);
      setFrame(0);
      frameRef.current = 0;
      setPlaying(false);

      if (chartDataCache.current[epId]) {
        setChartData(chartDataCache.current[epId]);
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
          setChartData(result);
        })
        .catch((err) => console.error("Failed to load episode:", err))
        .finally(() => setEpisodeLoading(false));
    },
    [ensureDatasetInfo, repoId],
  );

  useEffect(() => {
    if (episodeChangerRef) episodeChangerRef.current = handleEpisodeChange;
  }, [episodeChangerRef, handleEpisodeChange]);

  const totalFrames = chartData.length;

  // URDF joint names
  const [urdfJointNames, setUrdfJointNames] = useState<string[]>([]);
  const onJointsLoaded = useCallback(
    (names: string[]) => setUrdfJointNames(names),
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
    () => autoMatchJoints(urdfJointNames, selectedColumns),
    [urdfJointNames, selectedColumns],
  );
  const [mapping, setMapping] = useState<Record<string, string>>(autoMapping);
  useEffect(() => setMapping(autoMapping), [autoMapping]);

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

  // URDF meshes download async from the Hub bucket. Until joints are reported
  // back from URDFLoader, playback/scrub inputs would drive an empty scene, so
  // we gate interactions (and pause if already playing).
  const urdfLoading = urdfJointNames.length === 0;

  useEffect(() => {
    if (urdfLoading) setPlaying(false);
  }, [urdfLoading]);

  const handlePlayPause = useCallback(() => {
    if (urdfLoading) return;
    setPlaying((prev) => {
      if (!prev) frameRef.current = frame;
      return !prev;
    });
  }, [frame, urdfLoading]);

  useEffect(() => {
    if (playToggleRef) playToggleRef.current = handlePlayPause;
  }, [playToggleRef, handlePlayPause]);

  // Filter out mimic joints (finger_joint2) from the UI list
  const displayJointNames = useMemo(
    () =>
      urdfJointNames.filter((n) => !n.toLowerCase().includes("finger_joint2")),
    [urdfJointNames],
  );

  // Auto-detect gripper column range for linear mapping to 0-0.044m
  const gripperRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {};
    for (const jn of urdfJointNames) {
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
  }, [chartData, mapping, urdfJointNames]);

  // Compute joint values for current frame
  const jointValues = useMemo(() => {
    if (totalFrames === 0 || urdfJointNames.length === 0) return {};
    const row = chartData[Math.min(frame, totalFrames - 1)];
    const revoluteValues: number[] = [];
    const revoluteNames: string[] = [];
    const values: Record<string, number> = {};

    for (const jn of urdfJointNames) {
      if (jn.toLowerCase().includes("finger_joint2")) continue;
      const col = mapping[jn];
      if (!col || typeof row[col] !== "number") continue;
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
      } else {
        revoluteValues.push(raw);
        revoluteNames.push(jn);
      }
    }

    const converted = detectAndConvert(revoluteValues);
    revoluteNames.forEach((n, i) => {
      values[n] = converted[i];
    });

    // Copy finger_joint1 → finger_joint2 (mimic joints)
    for (const jn of urdfJointNames) {
      if (jn.toLowerCase().includes("finger_joint2")) {
        const j1 = jn.replace(/finger_joint2/, "finger_joint1");
        if (values[j1] !== undefined) values[jn] = values[j1];
      }
    }
    return values;
  }, [chartData, frame, gripperRanges, mapping, totalFrames, urdfJointNames]);

  if (data.flatChartData.length === 0) {
    return (
      <div className="text-slate-400 p-8 text-center">
        No trajectory data available.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 3D Viewport */}
      <div className="flex-1 min-h-0 bg-slate-900 rounded-lg overflow-hidden border border-slate-700 relative">
        {(episodeLoading || urdfLoading) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/70">
            <span className="text-white text-lg animate-pulse">
              {urdfLoading
                ? "Loading 3D model…"
                : `Loading episode ${selectedEpisode}…`}
            </span>
          </div>
        )}
        <Canvas
          shadows
          camera={{
            position: isG1
              ? [1.5, 1.0, 1.5]
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
          <color attach="background" args={["#1a2433"]} />
          {/* IBL: PMREM studio env gives mesh highlights somewhere to bounce */}
          <Environment preset="studio" background={false} />
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
            urdfUrl={urdfUrl}
            jointValues={jointValues}
            onJointsLoaded={onJointsLoaded}
            trailEnabled={trailEnabled}
            trailResetKey={selectedEpisode}
            scale={scale}
          />
          <Grid
            args={[10, 10]}
            cellSize={isG1 ? 0.5 : 0.2}
            cellThickness={0.5}
            cellColor="#334155"
            sectionSize={isG1 ? 2 : 1}
            sectionThickness={1}
            sectionColor="#475569"
            fadeDistance={isG1 ? 20 : 10}
            position={[0, 0, 0]}
          />
          <OrbitControls target={isG1 ? [0, 0.5, 0] : [0, 0.8, 0]} />
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
      <div className="bg-slate-800/90 border-t border-slate-700 p-3 space-y-3 shrink-0">
        <UrdfPlaybackBar
          frame={frame}
          totalFrames={totalFrames}
          fps={fps}
          playing={playing}
          onPlayPause={handlePlayPause}
          trailEnabled={trailEnabled}
          onTrailToggle={() => setTrailEnabled((v) => !v)}
          onFrameChange={handleFrameChange}
          disabled={urdfLoading}
        />

        {/* Collapsible joint mapping */}
        <button
          onClick={() => setShowMapping((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <span
            className={`transition-transform ${showMapping ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          Joint Mapping
          <span className="text-slate-600">
            ({Object.keys(mapping).filter((k) => mapping[k]).length}/
            {displayJointNames.length} mapped)
          </span>
        </button>

        {showMapping && (
          <div className="flex gap-4 items-start">
            <div className="space-y-1 shrink-0">
              <label className="text-xs text-slate-400">Data source</label>
              <div className="flex gap-1 flex-wrap">
                {groupNames.map((name) => (
                  <button
                    key={name}
                    onClick={() => setSelectedGroup(name)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      selectedGroup === name
                        ? "bg-orange-600 text-white"
                        : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-800">
                  <tr className="text-slate-500">
                    <th className="text-left font-normal px-1">URDF Joint</th>
                    <th className="text-left font-normal px-1">→</th>
                    <th className="text-left font-normal px-1">
                      Dataset Column
                    </th>
                    <th className="text-right font-normal px-1">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {displayJointNames.map((jointName) => (
                    <tr
                      key={jointName}
                      className="border-t border-slate-700/50"
                    >
                      <td className="px-1 py-0.5 text-slate-300 font-mono">
                        {jointName}
                      </td>
                      <td className="px-1 text-slate-600">→</td>
                      <td className="px-1 py-0.5">
                        <select
                          value={mapping[jointName] ?? ""}
                          onChange={(e) =>
                            setMapping((m) => ({
                              ...m,
                              [jointName]: e.target.value,
                            }))
                          }
                          className="bg-slate-900 text-slate-200 text-xs rounded px-1 py-0.5 border border-slate-600 w-full max-w-[200px]"
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
                      <td className="px-1 py-0.5 text-right tabular-nums text-slate-400 font-mono">
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

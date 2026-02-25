"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Html } from "@react-three/drei";
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
import { CHART_CONFIG } from "@/utils/constants";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";

const SERIES_DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER;
const DEG2RAD = Math.PI / 180;

function getRobotConfig(robotType: string | null) {
  const lower = (robotType ?? "").toLowerCase();
  if (lower.includes("openarm")) {
    return { urdfUrl: "/urdf/openarm/openarm_bimanual.urdf", scale: 3 };
  }
  if (lower.includes("so100") && !lower.includes("so101")) {
    return { urdfUrl: "/urdf/so101/so100.urdf", scale: 10 };
  }
  return { urdfUrl: "/urdf/so101/so101_new_calib.urdf", scale: 10 };
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

function autoMatchJoints(
  urdfJointNames: string[],
  columnKeys: string[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const suffixes = columnKeys.map((k) =>
    (k.split(SERIES_DELIM).pop()?.trim() ?? k).toLowerCase(),
  );

  for (const jointName of urdfJointNames) {
    const lower = jointName.toLowerCase();

    // Exact match on column suffix
    const exactIdx = suffixes.findIndex((s) => s === lower);
    if (exactIdx >= 0) {
      mapping[jointName] = columnKeys[exactIdx];
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
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.loadMeshCb = (url, mgr, onLoad) => {
      // DAE (Collada) files — load with embedded materials
      if (url.endsWith(".dae")) {
        const colladaLoader = new ColladaLoader(mgr);
        colladaLoader.load(
          url,
          (collada) => {
            if (isOpenArm) {
              collada.scene.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material) {
                  const mat = child.material as THREE.MeshStandardMaterial;
                  if (mat.side !== undefined) mat.side = THREE.DoubleSide;
                  if (mat.color) {
                    const hsl = { h: 0, s: 0, l: 0 };
                    mat.color.getHSL(hsl);
                    if (hsl.l > 0.7) mat.color.setHSL(hsl.h, hsl.s, 0.55);
                  }
                }
              });
            }
            onLoad(collada.scene);
          },
          undefined,
          (err) => onLoad(new THREE.Object3D(), err as Error),
        );
        return;
      }
      // STL files — apply custom materials
      const stlLoader = new STLLoader(mgr);
      stlLoader.load(
        url,
        (geometry) => {
          let color = "#FFD700";
          let metalness = 0.1;
          let roughness = 0.6;
          if (url.includes("sts3215")) {
            color = "#1a1a1a";
            metalness = 0.7;
            roughness = 0.3;
          } else if (isOpenArm) {
            color = url.includes("body_link0") ? "#3a3a4a" : "#f5f5f5";
            metalness = 0.15;
            roughness = 0.6;
          }
          const material = new THREE.MeshStandardMaterial({
            color,
            metalness,
            roughness,
            side: isOpenArm ? THREE.DoubleSide : THREE.FrontSide,
          });
          onLoad(new THREE.Mesh(geometry, material));
        },
        undefined,
        (err) => onLoad(new THREE.Object3D(), err as Error),
      );
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

        const tipNames = isOpenArm ? DUAL_ARM_TIP_NAMES : SINGLE_ARM_TIP_NAMES;
        const tips: THREE.Object3D[] = [];
        for (const name of tipNames) {
          if (robot.frames[name]) tips.push(robot.frames[name]);
          if (!isOpenArm && tips.length === 1) break;
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
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
}) {
  const { datasetInfo, episodes } = data;
  const fps = datasetInfo.fps || 30;
  const robotConfig = useMemo(
    () => getRobotConfig(datasetInfo.robot_type),
    [datasetInfo.robot_type],
  );
  const { urdfUrl, scale } = robotConfig;
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

  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

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
      <div className="flex-1 min-h-0 bg-slate-950 rounded-lg overflow-hidden border border-slate-700 relative">
        {episodeLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/70">
            <span className="text-white text-lg animate-pulse">
              Loading episode {selectedEpisode}…
            </span>
          </div>
        )}
        <Canvas
          camera={{
            position: [0.3 * scale, 0.25 * scale, 0.3 * scale],
            fov: 45,
            near: 0.01,
            far: 100,
          }}
        >
          <ambientLight intensity={0.7} />
          <directionalLight position={[3, 5, 4]} intensity={1.5} />
          <directionalLight position={[-2, 3, -2]} intensity={0.6} />
          <hemisphereLight args={["#b1e1ff", "#666666", 0.5]} />
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
            cellSize={0.2}
            cellThickness={0.5}
            cellColor="#334155"
            sectionSize={1}
            sectionThickness={1}
            sectionColor="#475569"
            fadeDistance={10}
            position={[0, 0, 0]}
          />
          <OrbitControls target={[0, 0.8, 0]} />
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
        {/* Episode selector + Timeline */}
        <div className="flex items-center gap-3">
          {/* Episode selector */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => {
                if (selectedEpisode > episodes[0])
                  handleEpisodeChange(selectedEpisode - 1);
              }}
              disabled={selectedEpisode <= episodes[0]}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            >
              ◀
            </button>
            <select
              value={selectedEpisode}
              onChange={(e) => handleEpisodeChange(Number(e.target.value))}
              className="bg-slate-900 text-slate-200 text-xs rounded px-1.5 py-1 border border-slate-600 w-28"
            >
              {episodes.map((ep) => (
                <option key={ep} value={ep}>
                  Episode {ep}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (selectedEpisode < episodes[episodes.length - 1])
                  handleEpisodeChange(selectedEpisode + 1);
              }}
              disabled={selectedEpisode >= episodes[episodes.length - 1]}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            >
              ▶
            </button>
          </div>

          {/* Play/Pause */}
          <button
            onClick={() => {
              setPlaying(!playing);
              if (!playing) frameRef.current = frame;
            }}
            className="w-8 h-8 flex items-center justify-center rounded bg-orange-600 hover:bg-orange-500 text-white transition-colors shrink-0"
          >
            {playing ? (
              <svg width="12" height="14" viewBox="0 0 12 14">
                <rect x="1" y="1" width="3" height="12" fill="white" />
                <rect x="8" y="1" width="3" height="12" fill="white" />
              </svg>
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14">
                <polygon points="2,1 11,7 2,13" fill="white" />
              </svg>
            )}
          </button>

          {/* Trail toggle */}
          <button
            onClick={() => setTrailEnabled((v) => !v)}
            className={`px-2 h-8 text-xs rounded transition-colors shrink-0 ${
              trailEnabled
                ? "bg-orange-600/30 text-orange-400 border border-orange-500"
                : "bg-slate-700 text-slate-400 border border-slate-600"
            }`}
            title={trailEnabled ? "Hide trail" : "Show trail"}
          >
            Trail
          </button>

          {/* Scrubber */}
          <input
            type="range"
            min={0}
            max={Math.max(totalFrames - 1, 0)}
            value={frame}
            onChange={handleFrameChange}
            className="flex-1 h-1.5 accent-orange-500 cursor-pointer"
          />
          <span className="text-xs text-slate-400 tabular-nums w-28 text-right shrink-0">
            {currentTime}s / {totalTime}s
          </span>
          <span className="text-xs text-slate-500 tabular-nums w-20 text-right shrink-0">
            F {frame}/{Math.max(totalFrames - 1, 0)}
          </span>
        </div>

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

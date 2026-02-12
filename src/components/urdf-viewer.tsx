"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Html } from "@react-three/drei";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";

const SERIES_DELIM = " | ";
const SCALE = 10;

function getUrdfUrl(robotType: string | null): string {
  const lower = (robotType ?? "").toLowerCase();
  if (lower.includes("so100") && !lower.includes("so101")) return "/urdf/so101/so100.urdf";
  return "/urdf/so101/so101_new_calib.urdf";
}

// Detect raw servo values (0-4096) vs radians
function detectAndConvert(values: number[]): number[] {
  if (values.length === 0) return values;
  const max = Math.max(...values.map(Math.abs));
  if (max > 10) return values.map((v) => ((v - 2048) / 2048) * Math.PI);
  return values;
}

// Group flat chart columns by feature prefix
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

// Auto-match dataset columns to URDF joint names
function autoMatchJoints(urdfJointNames: string[], columnKeys: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const jointName of urdfJointNames) {
    const lower = jointName.toLowerCase();
    const exactMatch = columnKeys.find((k) => {
      const suffix = (k.split(SERIES_DELIM).pop()?.trim() ?? k).toLowerCase();
      return suffix === lower;
    });
    if (exactMatch) { mapping[jointName] = exactMatch; continue; }
    const fuzzy = columnKeys.find((k) => k.toLowerCase().includes(lower));
    if (fuzzy) mapping[jointName] = fuzzy;
  }
  return mapping;
}

// ─── Robot scene (imperative, inside Canvas) ───
function RobotScene({
  urdfUrl,
  jointValues,
  onJointsLoaded,
}: {
  urdfUrl: string;
  jointValues: Record<string, number>;
  onJointsLoaded: (names: string[]) => void;
}) {
  const { scene } = useThree();
  const robotRef = useRef<URDFRobot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);

    loader.loadMeshCb = (url, mgr, onLoad) => {
      const stlLoader = new STLLoader(mgr);
      stlLoader.load(
        url,
        (geometry) => {
          const isMotor = url.includes("sts3215");
          const material = new THREE.MeshStandardMaterial({
            color: isMotor ? "#1a1a1a" : "#FFD700",
            metalness: isMotor ? 0.7 : 0.1,
            roughness: isMotor ? 0.3 : 0.6,
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
        robot.traverse((c) => { c.castShadow = true; });
        robot.updateMatrixWorld(true);
        robot.scale.set(SCALE, SCALE, SCALE);
        scene.add(robot);

        const revolute = Object.values(robot.joints)
          .filter((j) => j.jointType === "revolute" || j.jointType === "continuous")
          .map((j) => j.name);
        onJointsLoaded(revolute);
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
    };
  }, [urdfUrl, scene, onJointsLoaded]);

  useFrame(() => {
    if (!robotRef.current) return;
    for (const [name, value] of Object.entries(jointValues)) {
      robotRef.current.setJointValue(name, value);
    }
  });

  if (loading) return <Html center><span className="text-white text-lg">Loading robot…</span></Html>;
  if (error) return <Html center><span className="text-red-400">Failed to load URDF</span></Html>;
  return null;
}

// ─── Playback ticker (inside Canvas) ───
function PlaybackDriver({
  playing, fps, totalFrames, frameRef, setFrame,
}: {
  playing: boolean; fps: number; totalFrames: number;
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
        const frameDelta = Math.floor(elapsed.current * fps);
        if (frameDelta > 0) {
          elapsed.current -= frameDelta / fps;
          frameRef.current = (frameRef.current + frameDelta) % totalFrames;
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
export default function URDFViewer({ data }: { data: EpisodeData }) {
  const { flatChartData, datasetInfo } = data;
  const totalFrames = flatChartData.length;
  const fps = datasetInfo.fps || 30;
  const urdfUrl = useMemo(() => getUrdfUrl(datasetInfo.robot_type), [datasetInfo.robot_type]);

  // URDF joint names (set after robot loads)
  const [urdfJointNames, setUrdfJointNames] = useState<string[]>([]);
  const onJointsLoaded = useCallback((names: string[]) => setUrdfJointNames(names), []);

  // Feature group selection
  const columnGroups = useMemo(() => {
    if (totalFrames === 0) return {};
    return groupColumnsByPrefix(Object.keys(flatChartData[0]));
  }, [flatChartData, totalFrames]);

  const groupNames = useMemo(() => Object.keys(columnGroups), [columnGroups]);

  const defaultGroup = useMemo(
    () =>
      groupNames.find((g) => g.toLowerCase().includes("state")) ??
      groupNames.find((g) => g.toLowerCase().includes("action")) ??
      groupNames[0] ?? "",
    [groupNames],
  );

  const [selectedGroup, setSelectedGroup] = useState(defaultGroup);
  useEffect(() => setSelectedGroup(defaultGroup), [defaultGroup]);

  const selectedColumns = columnGroups[selectedGroup] ?? [];

  // Joint mapping (re-compute when URDF joints or selected columns change)
  const autoMapping = useMemo(
    () => autoMatchJoints(urdfJointNames, selectedColumns),
    [urdfJointNames, selectedColumns],
  );
  const [mapping, setMapping] = useState<Record<string, string>>(autoMapping);
  useEffect(() => setMapping(autoMapping), [autoMapping]);

  // Playback
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef(0);

  const handleFrameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = parseInt(e.target.value);
    setFrame(f);
    frameRef.current = f;
  }, []);

  // Compute joint values for current frame
  const jointValues = useMemo(() => {
    if (totalFrames === 0 || urdfJointNames.length === 0) return {};
    const row = flatChartData[Math.min(frame, totalFrames - 1)];
    const rawValues: number[] = [];
    const names: string[] = [];

    for (const jn of urdfJointNames) {
      const col = mapping[jn];
      if (col && typeof row[col] === "number") {
        rawValues.push(row[col]);
        names.push(jn);
      }
    }

    const converted = detectAndConvert(rawValues);
    const values: Record<string, number> = {};
    names.forEach((n, i) => { values[n] = converted[i]; });
    return values;
  }, [flatChartData, frame, mapping, totalFrames, urdfJointNames]);

  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

  if (totalFrames === 0) {
    return <div className="text-slate-400 p-8 text-center">No trajectory data available for this episode.</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 3D Viewport */}
      <div className="flex-1 min-h-0 bg-slate-950 rounded-lg overflow-hidden border border-slate-700">
        <Canvas camera={{ position: [0.3 * SCALE, 0.25 * SCALE, 0.3 * SCALE], fov: 45, near: 0.01, far: 100 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 5, 4]} intensity={1.2} />
          <directionalLight position={[-2, 3, -2]} intensity={0.4} />
          <hemisphereLight args={["#b1e1ff", "#444444", 0.4]} />
          <RobotScene urdfUrl={urdfUrl} jointValues={jointValues} onJointsLoaded={onJointsLoaded} />
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
          <PlaybackDriver playing={playing} fps={fps} totalFrames={totalFrames} frameRef={frameRef} setFrame={setFrame} />
        </Canvas>
      </div>

      {/* Controls */}
      <div className="bg-slate-800/90 border-t border-slate-700 p-3 space-y-3 shrink-0">
        {/* Timeline */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setPlaying(!playing); if (!playing) frameRef.current = frame; }}
            className="w-8 h-8 flex items-center justify-center rounded bg-orange-600 hover:bg-orange-500 text-white transition-colors shrink-0"
          >
            {playing ? (
              <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="1" width="3" height="12" fill="white" /><rect x="8" y="1" width="3" height="12" fill="white" /></svg>
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14"><polygon points="2,1 11,7 2,13" fill="white" /></svg>
            )}
          </button>
          <input type="range" min={0} max={Math.max(totalFrames - 1, 0)} value={frame}
            onChange={handleFrameChange} className="flex-1 h-1.5 accent-orange-500 cursor-pointer" />
          <span className="text-xs text-slate-400 tabular-nums w-28 text-right shrink-0">{currentTime}s / {totalTime}s</span>
          <span className="text-xs text-slate-500 tabular-nums w-20 text-right shrink-0">F {frame}/{totalFrames - 1}</span>
        </div>

        {/* Data source + joint mapping */}
        <div className="flex gap-4 items-start">
          <div className="space-y-1 shrink-0">
            <label className="text-xs text-slate-400">Data source</label>
            <div className="flex gap-1 flex-wrap">
              {groupNames.map((name) => (
                <button key={name} onClick={() => setSelectedGroup(name)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    selectedGroup === name ? "bg-orange-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                  }`}>{name}</button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500">
                  <th className="text-left font-normal px-1">URDF Joint</th>
                  <th className="text-left font-normal px-1">→</th>
                  <th className="text-left font-normal px-1">Dataset Column</th>
                  <th className="text-right font-normal px-1">Value (rad)</th>
                </tr>
              </thead>
              <tbody>
                {urdfJointNames.map((jointName) => (
                  <tr key={jointName} className="border-t border-slate-700/50">
                    <td className="px-1 py-0.5 text-slate-300 font-mono">{jointName}</td>
                    <td className="px-1 text-slate-600">→</td>
                    <td className="px-1 py-0.5">
                      <select value={mapping[jointName] ?? ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [jointName]: e.target.value }))}
                        className="bg-slate-900 text-slate-200 text-xs rounded px-1 py-0.5 border border-slate-600 w-full max-w-[200px]">
                        <option value="">-- unmapped --</option>
                        {selectedColumns.map((col) => {
                          const label = col.split(SERIES_DELIM).pop() ?? col;
                          return <option key={col} value={col}>{label}</option>;
                        })}
                      </select>
                    </td>
                    <td className="px-1 py-0.5 text-right tabular-nums text-slate-400 font-mono">
                      {jointValues[jointName] !== undefined ? jointValues[jointName].toFixed(3) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

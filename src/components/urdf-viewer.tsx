"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Html } from "@react-three/drei";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { fetchEpisodeChartData } from "@/app/[org]/[dataset]/[episode]/actions";

const SERIES_DELIM = " | ";
const SCALE = 10;
const DEG2RAD = Math.PI / 180;

function getUrdfUrl(robotType: string | null): string {
  const lower = (robotType ?? "").toLowerCase();
  if (lower.includes("so100") && !lower.includes("so101")) return "/urdf/so101/so100.urdf";
  return "/urdf/so101/so101_new_calib.urdf";
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

// Tip link names to try (so101 then so100 naming)
const TIP_LINK_NAMES = ["gripper_frame_link", "gripperframe", "gripper_link", "gripper"];
const TRAIL_DURATION = 1.0; // seconds
const TRAIL_COLOR = new THREE.Color("#ff6600");
const MAX_TRAIL_POINTS = 300;

// ─── Robot scene (imperative, inside Canvas) ───
function RobotScene({
  urdfUrl, jointValues, onJointsLoaded, trailEnabled, trailResetKey,
}: {
  urdfUrl: string;
  jointValues: Record<string, number>;
  onJointsLoaded: (names: string[]) => void;
  trailEnabled: boolean;
  trailResetKey: number;
}) {
  const { scene, size } = useThree();
  const robotRef = useRef<URDFRobot | null>(null);
  const tipLinkRef = useRef<THREE.Object3D | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Trail state
  const trailRef = useRef<{ positions: Float32Array; colors: Float32Array; times: number[]; count: number }>({
    positions: new Float32Array(MAX_TRAIL_POINTS * 3),
    colors: new Float32Array(MAX_TRAIL_POINTS * 3), // RGB, no alpha
    times: [],
    count: 0,
  });
  const lineRef = useRef<Line2 | null>(null);
  const trailMatRef = useRef<LineMaterial | null>(null);

  // Reset trail when episode changes
  useEffect(() => {
    trailRef.current.count = 0;
    trailRef.current.times = [];
    if (lineRef.current) lineRef.current.visible = false;
  }, [trailResetKey]);

  // Create trail Line2 object
  useEffect(() => {
    const geometry = new LineGeometry();
    const material = new LineMaterial({
      color: 0xffffff,
      linewidth: 4, // pixels
      vertexColors: true,
      transparent: true,
      worldUnits: false,
    });
    material.resolution.set(window.innerWidth, window.innerHeight);
    trailMatRef.current = material;

    const line = new Line2(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    lineRef.current = line;
    scene.add(line);

    return () => { scene.remove(line); geometry.dispose(); material.dispose(); };
  }, [scene]);

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

        // Find the tip link for the trail
        for (const name of TIP_LINK_NAMES) {
          if (robot.frames[name]) { tipLinkRef.current = robot.frames[name]; break; }
        }

        const revolute = Object.values(robot.joints)
          .filter((j) => j.jointType === "revolute" || j.jointType === "continuous")
          .map((j) => j.name);
        onJointsLoaded(revolute);
        setLoading(false);
      },
      undefined,
      (err) => { console.error("Error loading URDF:", err); setError(String(err)); setLoading(false); },
    );
    return () => {
      if (robotRef.current) { scene.remove(robotRef.current); robotRef.current = null; }
      tipLinkRef.current = null;
    };
  }, [urdfUrl, scene, onJointsLoaded]);

  const tipWorldPos = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const robot = robotRef.current;
    if (!robot) return;

    // Apply joint values
    for (const [name, value] of Object.entries(jointValues)) {
      robot.setJointValue(name, value);
    }
    robot.updateMatrixWorld(true);

    // Update trail
    const line = lineRef.current;
    const tip = tipLinkRef.current;
    if (!line || !tip || !trailEnabled) {
      if (line) line.visible = false;
      return;
    }

    // Keep resolution in sync with viewport
    if (trailMatRef.current) trailMatRef.current.resolution.set(size.width, size.height);

    tip.getWorldPosition(tipWorldPos);
    const now = performance.now() / 1000;
    const trail = trailRef.current;

    // Add new point
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

    // Update colors: fade from orange → black based on age
    for (let i = 0; i < trail.count; i++) {
      const age = now - trail.times[i];
      const t = Math.max(0, 1 - age / TRAIL_DURATION);
      trail.colors[i * 3] = TRAIL_COLOR.r * t;
      trail.colors[i * 3 + 1] = TRAIL_COLOR.g * t;
      trail.colors[i * 3 + 2] = TRAIL_COLOR.b * t;
    }

    // Need at least 2 points for Line2
    if (trail.count < 2) { line.visible = false; return; }

    // Rebuild geometry (Line2 requires this)
    const geo = new LineGeometry();
    geo.setPositions(Array.from(trail.positions.subarray(0, trail.count * 3)));
    geo.setColors(Array.from(trail.colors.subarray(0, trail.count * 3)));
    line.geometry.dispose();
    line.geometry = geo;
    line.computeLineDistances();
    line.visible = true;
  });

  if (loading) return <Html center><span className="text-white text-lg">Loading robot…</span></Html>;
  if (error) return <Html center><span className="text-red-400">Failed to load URDF</span></Html>;
  return null;
}

// ─── Playback ticker ───
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
  const urdfUrl = useMemo(() => getUrdfUrl(datasetInfo.robot_type), [datasetInfo.robot_type]);

  // Episode selection & chart data
  const [selectedEpisode, setSelectedEpisode] = useState(data.episodeId);
  const [chartData, setChartData] = useState(data.flatChartData);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const chartDataCache = useRef<Record<number, Record<string, number>[]>>({
    [data.episodeId]: data.flatChartData,
  });

  const handleEpisodeChange = useCallback((epId: number) => {
    setSelectedEpisode(epId);
    setFrame(0);
    frameRef.current = 0;
    setPlaying(false);

    if (chartDataCache.current[epId]) {
      setChartData(chartDataCache.current[epId]);
      return;
    }

    if (!org || !dataset) return;
    setEpisodeLoading(true);
    fetchEpisodeChartData(org, dataset, epId)
      .then((result) => {
        chartDataCache.current[epId] = result;
        setChartData(result);
      })
      .catch((err) => console.error("Failed to load episode:", err))
      .finally(() => setEpisodeLoading(false));
  }, [org, dataset]);

  const totalFrames = chartData.length;

  // URDF joint names
  const [urdfJointNames, setUrdfJointNames] = useState<string[]>([]);
  const onJointsLoaded = useCallback((names: string[]) => setUrdfJointNames(names), []);

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
      groupNames[0] ?? "",
    [groupNames],
  );

  const [selectedGroup, setSelectedGroup] = useState(defaultGroup);
  useEffect(() => setSelectedGroup(defaultGroup), [defaultGroup]);
  const selectedColumns = columnGroups[selectedGroup] ?? [];

  // Joint mapping
  const autoMapping = useMemo(
    () => autoMatchJoints(urdfJointNames, selectedColumns),
    [urdfJointNames, selectedColumns],
  );
  const [mapping, setMapping] = useState<Record<string, string>>(autoMapping);
  useEffect(() => setMapping(autoMapping), [autoMapping]);

  // Trail
  const [trailEnabled, setTrailEnabled] = useState(true);

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
    const row = chartData[Math.min(frame, totalFrames - 1)];
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
  }, [chartData, frame, mapping, totalFrames, urdfJointNames]);

  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

  if (data.flatChartData.length === 0) {
    return <div className="text-slate-400 p-8 text-center">No trajectory data available.</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 3D Viewport */}
      <div className="flex-1 min-h-0 bg-slate-950 rounded-lg overflow-hidden border border-slate-700 relative">
        {episodeLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/70">
            <span className="text-white text-lg animate-pulse">Loading episode {selectedEpisode}…</span>
          </div>
        )}
        <Canvas camera={{ position: [0.3 * SCALE, 0.25 * SCALE, 0.3 * SCALE], fov: 45, near: 0.01, far: 100 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 5, 4]} intensity={1.2} />
          <directionalLight position={[-2, 3, -2]} intensity={0.4} />
          <hemisphereLight args={["#b1e1ff", "#444444", 0.4]} />
          <RobotScene urdfUrl={urdfUrl} jointValues={jointValues} onJointsLoaded={onJointsLoaded} trailEnabled={trailEnabled} trailResetKey={selectedEpisode} />
          <Grid
            args={[10, 10]} cellSize={0.2} cellThickness={0.5} cellColor="#334155"
            sectionSize={1} sectionThickness={1} sectionColor="#475569"
            fadeDistance={10} position={[0, 0, 0]}
          />
          <OrbitControls target={[0, 0.8, 0]} />
          <PlaybackDriver playing={playing} fps={fps} totalFrames={totalFrames} frameRef={frameRef} setFrame={setFrame} />
        </Canvas>
      </div>

      {/* Controls */}
      <div className="bg-slate-800/90 border-t border-slate-700 p-3 space-y-3 shrink-0">
        {/* Episode selector + Timeline */}
        <div className="flex items-center gap-3">
          {/* Episode selector */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => { if (selectedEpisode > episodes[0]) handleEpisodeChange(selectedEpisode - 1); }}
              disabled={selectedEpisode <= episodes[0]}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            >◀</button>
            <select
              value={selectedEpisode}
              onChange={(e) => handleEpisodeChange(Number(e.target.value))}
              className="bg-slate-900 text-slate-200 text-xs rounded px-1.5 py-1 border border-slate-600 w-28"
            >
              {episodes.map((ep) => (
                <option key={ep} value={ep}>Episode {ep}</option>
              ))}
            </select>
            <button
              onClick={() => { if (selectedEpisode < episodes[episodes.length - 1]) handleEpisodeChange(selectedEpisode + 1); }}
              disabled={selectedEpisode >= episodes[episodes.length - 1]}
              className="w-6 h-6 flex items-center justify-center rounded bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            >▶</button>
          </div>

          {/* Play/Pause */}
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

          {/* Trail toggle */}
          <button
            onClick={() => setTrailEnabled((v) => !v)}
            className={`px-2 h-8 text-xs rounded transition-colors shrink-0 ${
              trailEnabled ? "bg-orange-600/30 text-orange-400 border border-orange-500" : "bg-slate-700 text-slate-400 border border-slate-600"
            }`}
            title={trailEnabled ? "Hide trail" : "Show trail"}
          >Trail</button>

          {/* Scrubber */}
          <input type="range" min={0} max={Math.max(totalFrames - 1, 0)} value={frame}
            onChange={handleFrameChange} className="flex-1 h-1.5 accent-orange-500 cursor-pointer" />
          <span className="text-xs text-slate-400 tabular-nums w-28 text-right shrink-0">{currentTime}s / {totalTime}s</span>
          <span className="text-xs text-slate-500 tabular-nums w-20 text-right shrink-0">F {frame}/{Math.max(totalFrames - 1, 0)}</span>
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

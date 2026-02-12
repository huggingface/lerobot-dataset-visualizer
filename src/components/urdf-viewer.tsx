"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { OrbitControls, Grid, Environment } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import {
  SO101_JOINTS,
  SO101_LINKS,
  MATERIAL_COLORS,
  autoMatchJoints,
  type JointDef,
  type MeshDef,
} from "@/lib/so101-robot";
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";

const SERIES_DELIM = " | ";

// ─── STL Mesh component ───
function STLMesh({ mesh }: { mesh: MeshDef }) {
  const geometry = useLoader(STLLoader, mesh.file);
  const color = MATERIAL_COLORS[mesh.material];
  return (
    <mesh
      geometry={geometry}
      position={mesh.origin.xyz}
      rotation={new THREE.Euler(...mesh.origin.rpy, "XYZ")}
    >
      <meshStandardMaterial
        color={color}
        metalness={mesh.material === "motor" ? 0.7 : 0.1}
        roughness={mesh.material === "motor" ? 0.3 : 0.6}
      />
    </mesh>
  );
}

// ─── Link visual: renders all meshes for a link ───
function LinkVisual({ linkIndex }: { linkIndex: number }) {
  const link = SO101_LINKS[linkIndex];
  if (!link) return null;
  return (
    <>
      {link.meshes.map((mesh, i) => (
        <STLMesh key={i} mesh={mesh} />
      ))}
    </>
  );
}

// ─── Joint group: applies origin transform + joint rotation ───
function JointGroup({
  joint,
  angle,
  linkIndex,
  children,
}: {
  joint: JointDef;
  angle: number;
  linkIndex: number;
  children?: React.ReactNode;
}) {
  const rotRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (rotRef.current) {
      rotRef.current.quaternion.setFromAxisAngle(new THREE.Vector3(...joint.axis), angle);
    }
  }, [angle, joint.axis]);

  return (
    <group position={joint.origin.xyz} rotation={new THREE.Euler(...joint.origin.rpy, "XYZ")}>
      <group ref={rotRef}>
        <LinkVisual linkIndex={linkIndex} />
        {children}
      </group>
    </group>
  );
}

// ─── Full robot arm ───
function RobotArm({ angles }: { angles: Record<string, number> }) {
  return (
    <group>
      {/* Base link (no parent joint) */}
      <LinkVisual linkIndex={0} />

      {/* shoulder_pan → shoulder_link (1) */}
      <JointGroup joint={SO101_JOINTS[0]} angle={angles.shoulder_pan ?? 0} linkIndex={1}>
        {/* shoulder_lift → upper_arm_link (2) */}
        <JointGroup joint={SO101_JOINTS[1]} angle={angles.shoulder_lift ?? 0} linkIndex={2}>
          {/* elbow_flex → lower_arm_link (3) */}
          <JointGroup joint={SO101_JOINTS[2]} angle={angles.elbow_flex ?? 0} linkIndex={3}>
            {/* wrist_flex → wrist_link (4) */}
            <JointGroup joint={SO101_JOINTS[3]} angle={angles.wrist_flex ?? 0} linkIndex={4}>
              {/* wrist_roll → gripper_link (5) */}
              <JointGroup joint={SO101_JOINTS[4]} angle={angles.wrist_roll ?? 0} linkIndex={5}>
                {/* gripper → moving_jaw (6) */}
                <JointGroup joint={SO101_JOINTS[5]} angle={angles.gripper ?? 0} linkIndex={6} />
              </JointGroup>
            </JointGroup>
          </JointGroup>
        </JointGroup>
      </JointGroup>
    </group>
  );
}

// ─── Playback driver (advances frame inside Canvas render loop) ───
function PlaybackDriver({
  playing,
  fps,
  totalFrames,
  frameRef,
}: {
  playing: boolean;
  fps: number;
  totalFrames: number;
  frameRef: React.MutableRefObject<number>;
}) {
  const elapsed = useRef(0);
  useFrame((_, delta) => {
    if (!playing) {
      elapsed.current = 0;
      return;
    }
    elapsed.current += delta;
    const frameDelta = Math.floor(elapsed.current * fps);
    if (frameDelta > 0) {
      elapsed.current -= frameDelta / fps;
      frameRef.current = (frameRef.current + frameDelta) % totalFrames;
    }
  });
  return null;
}

// ─── Detect raw servo values (0-4096) vs radians ───
function detectAndConvert(values: number[]): number[] {
  if (values.length === 0) return values;
  const max = Math.max(...values.map(Math.abs));
  if (max > 10) return values.map((v) => ((v - 2048) / 2048) * Math.PI);
  return values;
}

// ─── Group columns by feature prefix ───
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

// ═══════════════════════════════════════
// ─── Main URDF Viewer ───
// ═══════════════════════════════════════
export default function URDFViewer({ data }: { data: EpisodeData }) {
  const { flatChartData, datasetInfo } = data;
  const totalFrames = flatChartData.length;
  const fps = datasetInfo.fps || 30;

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
  const autoMapping = useMemo(() => autoMatchJoints(selectedColumns), [selectedColumns]);
  const [mapping, setMapping] = useState<Record<string, string>>(autoMapping);
  useEffect(() => setMapping(autoMapping), [autoMapping]);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => setFrame(frameRef.current), 33);
    return () => clearInterval(interval);
  }, [playing]);

  const handleFrameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = parseInt(e.target.value);
    setFrame(f);
    frameRef.current = f;
  }, []);

  const jointAngles = useMemo(() => {
    if (totalFrames === 0) return {};
    const row = flatChartData[Math.min(frame, totalFrames - 1)];
    const rawValues: number[] = [];
    const jointNames: string[] = [];

    for (const joint of SO101_JOINTS) {
      const col = mapping[joint.name];
      if (col && typeof row[col] === "number") {
        rawValues.push(row[col]);
        jointNames.push(joint.name);
      }
    }

    const converted = detectAndConvert(rawValues);
    const angles: Record<string, number> = {};
    jointNames.forEach((name, i) => {
      angles[name] = converted[i];
    });
    return angles;
  }, [flatChartData, frame, mapping, totalFrames]);

  const currentTime = totalFrames > 0 ? (frame / fps).toFixed(2) : "0.00";
  const totalTime = (totalFrames / fps).toFixed(2);

  if (totalFrames === 0) {
    return <div className="text-slate-400 p-8 text-center">No trajectory data available for this episode.</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 3D Viewport */}
      <div className="flex-1 min-h-0 bg-slate-950 rounded-lg overflow-hidden border border-slate-700">
        <Canvas camera={{ position: [0.35, 0.25, 0.3], fov: 45, near: 0.001, far: 10 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 5, 4]} intensity={1.2} castShadow />
          <directionalLight position={[-2, 3, -2]} intensity={0.4} />
          <hemisphereLight args={["#b1e1ff", "#444444", 0.4]} />
          <Suspense fallback={null}>
            <RobotArm angles={jointAngles} />
          </Suspense>
          <Grid
            args={[1, 1]}
            cellSize={0.02}
            cellThickness={0.5}
            cellColor="#334155"
            sectionSize={0.1}
            sectionThickness={1}
            sectionColor="#475569"
            fadeDistance={1}
            position={[0, 0, 0]}
          />
          <OrbitControls target={[0, 0.1, 0]} />
          <PlaybackDriver playing={playing} fps={fps} totalFrames={totalFrames} frameRef={frameRef} />
        </Canvas>
      </div>

      {/* Controls Panel */}
      <div className="bg-slate-800/90 border-t border-slate-700 p-3 space-y-3 shrink-0">
        {/* Playback bar */}
        <div className="flex items-center gap-3">
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
            F {frame}/{totalFrames - 1}
          </span>
        </div>

        {/* Data source + joint mapping */}
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
                {SO101_JOINTS.map((joint) => (
                  <tr key={joint.name} className="border-t border-slate-700/50">
                    <td className="px-1 py-0.5 text-slate-300 font-mono">{joint.name}</td>
                    <td className="px-1 text-slate-600">→</td>
                    <td className="px-1 py-0.5">
                      <select
                        value={mapping[joint.name] ?? ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [joint.name]: e.target.value }))}
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
                      {jointAngles[joint.name] !== undefined ? jointAngles[joint.name].toFixed(3) : "—"}
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

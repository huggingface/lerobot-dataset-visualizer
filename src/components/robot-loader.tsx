"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import "./robot-loader.css";
import {
  G1_LINKS,
  OPENARM_LINKS,
  SO101_LINKS,
  type LoaderLink,
} from "@/components/robot-loader-shapes";

export type LoaderRobot = "so101" | "openarm" | "g1";

interface Motion {
  from: string;
  to: string;
  duration: number;
  delay: number;
}

const LINKS: Record<LoaderRobot, LoaderLink[]> = {
  so101: SO101_LINKS,
  openarm: OPENARM_LINKS,
  g1: G1_LINKS,
};

/// The joints that turn (or slide) within the drawing's plane, so they can move about their pivots.
const MOTIONS: Record<LoaderRobot, Record<string, Motion>> = {
  so101: {
    upper_arm_link: {
      from: "rotate(-4deg)",
      to: "rotate(10deg)",
      duration: 3.6,
      delay: 0,
    },
    lower_arm_link: {
      from: "rotate(6deg)",
      to: "rotate(-14deg)",
      duration: 3.6,
      delay: -1.2,
    },
    wrist_link: {
      from: "rotate(-10deg)",
      to: "rotate(18deg)",
      duration: 2.8,
      delay: -0.6,
    },
    moving_jaw_so101_v1_link: {
      from: "rotate(0deg)",
      to: "rotate(-22deg)",
      duration: 1.6,
      delay: 0,
    },
  },
  openarm: {
    openarm_left_link2: {
      from: "rotate(0deg)",
      to: "rotate(14deg)",
      duration: 3.4,
      delay: 0,
    },
    openarm_right_link2: {
      from: "rotate(0deg)",
      to: "rotate(-14deg)",
      duration: 3.4,
      delay: -1.7,
    },
    openarm_left_link6: {
      from: "rotate(-8deg)",
      to: "rotate(8deg)",
      duration: 2.6,
      delay: -0.4,
    },
    openarm_right_link6: {
      from: "rotate(8deg)",
      to: "rotate(-8deg)",
      duration: 2.6,
      delay: -1.6,
    },
    openarm_left_right_finger: {
      from: "translateX(0px)",
      to: "translateX(-1.6px)",
      duration: 1.4,
      delay: 0,
    },
    openarm_left_left_finger: {
      from: "translateX(0px)",
      to: "translateX(1.6px)",
      duration: 1.4,
      delay: 0,
    },
    openarm_right_right_finger: {
      from: "translateX(0px)",
      to: "translateX(-1.6px)",
      duration: 1.4,
      delay: -0.7,
    },
    openarm_right_left_finger: {
      from: "translateX(0px)",
      to: "translateX(1.6px)",
      duration: 1.4,
      delay: -0.7,
    },
  },
  g1: {
    waist_roll_link: {
      from: "rotate(-4deg)",
      to: "rotate(4deg)",
      duration: 3.2,
      delay: 0,
    },
    left_shoulder_roll_link: {
      from: "rotate(-4deg)",
      to: "rotate(-40deg)",
      duration: 3.2,
      delay: 0,
    },
    right_shoulder_roll_link: {
      from: "rotate(40deg)",
      to: "rotate(4deg)",
      duration: 3.2,
      delay: 0,
    },
    left_hip_roll_link: {
      from: "rotate(0deg)",
      to: "rotate(-5deg)",
      duration: 3.2,
      delay: 0,
    },
    right_hip_roll_link: {
      from: "rotate(5deg)",
      to: "rotate(0deg)",
      duration: 3.2,
      delay: 0,
    },
    left_ankle_roll_link: {
      from: "rotate(0deg)",
      to: "rotate(5deg)",
      duration: 3.2,
      delay: 0,
    },
    right_ankle_roll_link: {
      from: "rotate(-5deg)",
      to: "rotate(0deg)",
      duration: 3.2,
      delay: 0,
    },
  },
};

/** A wireframe illustration of the robot, drawing itself in and moving its joints, while its 3D model loads. */
export default function RobotLoader({
  robot,
  caption,
}: {
  robot: LoaderRobot;
  /** Shown above the loading text, like the dataset's robot type. */
  caption?: string;
}) {
  /// SVG ids are document-wide; useId's own characters aren't valid in url(#…).
  const uid = `rl${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const links = LINKS[robot];
  const motions = MOTIONS[robot];
  const names = new Set(links.map((l) => l.name));
  const childrenOf = new Map<string | null, LoaderLink[]>();
  for (const link of links) {
    const parent = link.parent && names.has(link.parent) ? link.parent : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), link]);
  }

  let drawn = 0;
  const renderLink = (link: LoaderLink): ReactNode => {
    const motion = motions[link.name];
    const style =
      motion && link.pivot
        ? ({
            transformOrigin: `${link.pivot[0]}px ${link.pivot[1]}px`,
            "--rl-from": motion.from,
            "--rl-to": motion.to,
            "--rl-duration": `${motion.duration}s`,
            "--rl-delay": `${motion.delay}s`,
          } as CSSProperties)
        : undefined;
    return (
      <g
        key={link.name}
        className={style ? "rl-joint" : undefined}
        style={style}
      >
        {link.paths.map((d, i) => (
          <path
            key={i}
            d={d}
            pathLength={1}
            className="rl-part"
            style={{ "--rl-i": drawn++ } as CSSProperties}
          />
        ))}
        {style && motion.from.startsWith("rotate") && link.pivot && (
          <>
            <circle
              className="rl-node"
              cx={link.pivot[0]}
              cy={link.pivot[1]}
              r={1.6}
            />
            <circle
              className="rl-ping"
              cx={link.pivot[0]}
              cy={link.pivot[1]}
              r={1.6}
            />
          </>
        )}
        {(childrenOf.get(link.name) ?? []).map(renderLink)}
      </g>
    );
  };

  return (
    <div
      className="robot-loader flex flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      <svg
        viewBox="0 0 240 240"
        className="w-[min(55vmin,300px)] h-auto"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id={`${uid}-grid`}
            width="12"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <path d="M12 0H0V12" className="rl-grid" />
          </pattern>
          <radialGradient id={`${uid}-fade`}>
            <stop offset="0.35" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={`${uid}-mask`}>
            <rect width="240" height="240" fill={`url(#${uid}-fade)`} />
          </mask>
          <linearGradient id={`${uid}-scan`} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0"
              style={{ stopColor: "var(--accent)", stopOpacity: 0 }}
            />
            <stop
              offset="0.9"
              style={{ stopColor: "var(--accent)", stopOpacity: 0.16 }}
            />
            <stop
              offset="1"
              style={{ stopColor: "var(--accent)", stopOpacity: 0.5 }}
            />
          </linearGradient>
          <filter
            id={`${uid}-glow`}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
          >
            <feGaussianBlur stdDeviation="1.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect
          width="240"
          height="240"
          fill={`url(#${uid}-grid)`}
          mask={`url(#${uid}-mask)`}
        />
        <g className="rl-robot" filter={`url(#${uid}-glow)`}>
          {(childrenOf.get(null) ?? []).map(renderLink)}
        </g>
        <rect
          className="rl-scan"
          width="240"
          height="40"
          fill={`url(#${uid}-scan)`}
        />
        <path
          className="rl-hud"
          d="M6 22V6H22M218 6H234V22M234 218V234H218M22 234H6V218"
        />
      </svg>
      {caption && (
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-fg-muted">
          {caption}
        </div>
      )}
      <div className="text-fg text-sm">
        Loading 3D model
        <span className="rl-dots" />
      </div>
    </div>
  );
}

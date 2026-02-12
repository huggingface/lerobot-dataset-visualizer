export type JointDef = {
  name: string;
  origin: { xyz: [number, number, number]; rpy: [number, number, number] };
  axis: [number, number, number];
  limits: [number, number];
};

export type MeshDef = {
  file: string;
  origin: { xyz: [number, number, number]; rpy: [number, number, number] };
  material: "3d_printed" | "motor";
};

export type LinkDef = {
  name: string;
  meshes: MeshDef[];
};

const ASSET_BASE = "/urdf/so101/assets";
const P = Math.PI;

// ─── Visual meshes per link (from URDF) ───
export const SO101_LINKS: LinkDef[] = [
  {
    name: "base_link",
    meshes: [
      { file: `${ASSET_BASE}/base_motor_holder_so101_v1.stl`, origin: { xyz: [-0.00636471, -9.94414e-05, -0.0024], rpy: [P / 2, 0, P / 2] }, material: "3d_printed" },
      { file: `${ASSET_BASE}/base_so101_v2.stl`, origin: { xyz: [-0.00636471, 0, -0.0024], rpy: [P / 2, 0, P / 2] }, material: "3d_printed" },
      { file: `${ASSET_BASE}/sts3215_03a_v1.stl`, origin: { xyz: [0.0263353, 0, 0.0437], rpy: [0, 0, 0] }, material: "motor" },
      { file: `${ASSET_BASE}/waveshare_mounting_plate_so101_v2.stl`, origin: { xyz: [-0.0309827, -0.000199441, 0.0474], rpy: [P / 2, 0, P / 2] }, material: "3d_printed" },
    ],
  },
  {
    name: "shoulder_link",
    meshes: [
      { file: `${ASSET_BASE}/sts3215_03a_v1.stl`, origin: { xyz: [-0.0303992, 0.000422241, -0.0417], rpy: [P / 2, P / 2, 0] }, material: "motor" },
      { file: `${ASSET_BASE}/motor_holder_so101_base_v1.stl`, origin: { xyz: [-0.0675992, -0.000177759, 0.0158499], rpy: [P / 2, -P / 2, 0] }, material: "3d_printed" },
      { file: `${ASSET_BASE}/rotation_pitch_so101_v1.stl`, origin: { xyz: [0.0122008, 2.22413e-05, 0.0464], rpy: [-P / 2, 0, 0] }, material: "3d_printed" },
    ],
  },
  {
    name: "upper_arm_link",
    meshes: [
      { file: `${ASSET_BASE}/sts3215_03a_v1.stl`, origin: { xyz: [-0.11257, -0.0155, 0.0187], rpy: [-P, 0, -P / 2] }, material: "motor" },
      { file: `${ASSET_BASE}/upper_arm_so101_v1.stl`, origin: { xyz: [-0.065085, 0.012, 0.0182], rpy: [P, 0, 0] }, material: "3d_printed" },
    ],
  },
  {
    name: "lower_arm_link",
    meshes: [
      { file: `${ASSET_BASE}/under_arm_so101_v1.stl`, origin: { xyz: [-0.0648499, -0.032, 0.0182], rpy: [P, 0, 0] }, material: "3d_printed" },
      { file: `${ASSET_BASE}/motor_holder_so101_wrist_v1.stl`, origin: { xyz: [-0.0648499, -0.032, 0.018], rpy: [-P, 0, 0] }, material: "3d_printed" },
      { file: `${ASSET_BASE}/sts3215_03a_v1.stl`, origin: { xyz: [-0.1224, 0.0052, 0.0187], rpy: [-P, 0, -P] }, material: "motor" },
    ],
  },
  {
    name: "wrist_link",
    meshes: [
      { file: `${ASSET_BASE}/sts3215_03a_no_horn_v1.stl`, origin: { xyz: [0, -0.0424, 0.0306], rpy: [P / 2, P / 2, 0] }, material: "motor" },
      { file: `${ASSET_BASE}/wrist_roll_pitch_so101_v2.stl`, origin: { xyz: [0, -0.028, 0.0181], rpy: [-P / 2, -P / 2, 0] }, material: "3d_printed" },
    ],
  },
  {
    name: "gripper_link",
    meshes: [
      { file: `${ASSET_BASE}/sts3215_03a_v1.stl`, origin: { xyz: [0.0077, 0.0001, -0.0234], rpy: [-P / 2, 0, 0] }, material: "motor" },
      { file: `${ASSET_BASE}/wrist_roll_follower_so101_v1.stl`, origin: { xyz: [0, -0.000218214, 0.000949706], rpy: [-P, 0, 0] }, material: "3d_printed" },
    ],
  },
  {
    name: "moving_jaw_link",
    meshes: [
      { file: `${ASSET_BASE}/moving_jaw_so101_v1.stl`, origin: { xyz: [0, 0, 0.0189], rpy: [0, 0, 0] }, material: "3d_printed" },
    ],
  },
];

// Kinematic chain: each joint connects a parent link to a child link
// Index in SO101_LINKS: base=0, shoulder=1, upper_arm=2, lower_arm=3, wrist=4, gripper=5, jaw=6
export const SO101_JOINTS: JointDef[] = [
  {
    name: "shoulder_pan",
    origin: { xyz: [0.0388353, -8.97657e-09, 0.0624], rpy: [P, 4.18253e-17, -P] },
    axis: [0, 0, 1],
    limits: [-1.91986, 1.91986],
  },
  {
    name: "shoulder_lift",
    origin: { xyz: [-0.0303992, -0.0182778, -0.0542], rpy: [-P / 2, -P / 2, 0] },
    axis: [0, 0, 1],
    limits: [-1.74533, 1.74533],
  },
  {
    name: "elbow_flex",
    origin: { xyz: [-0.11257, -0.028, 1.73763e-16], rpy: [0, 0, P / 2] },
    axis: [0, 0, 1],
    limits: [-1.69, 1.69],
  },
  {
    name: "wrist_flex",
    origin: { xyz: [-0.1349, 0.0052, 0], rpy: [0, 0, -P / 2] },
    axis: [0, 0, 1],
    limits: [-1.65806, 1.65806],
  },
  {
    name: "wrist_roll",
    origin: { xyz: [0, -0.0611, 0.0181], rpy: [P / 2, 0.0486795, P] },
    axis: [0, 0, 1],
    limits: [-2.74385, 2.84121],
  },
  {
    name: "gripper",
    origin: { xyz: [0.0202, 0.0188, -0.0234], rpy: [P / 2, 0, 0] },
    axis: [0, 0, 1],
    limits: [-0.174533, 1.74533],
  },
];

export const MATERIAL_COLORS = {
  "3d_printed": "#FFD700",
  motor: "#1a1a1a",
} as const;

export function isSO101Robot(robotType: string | null): boolean {
  if (!robotType) return false;
  const lower = robotType.toLowerCase();
  return lower.includes("so100") || lower.includes("so101") || lower === "so_follower";
}

// Collect all unique STL file paths for preloading
export function getAllSTLPaths(): string[] {
  const paths = new Set<string>();
  for (const link of SO101_LINKS) {
    for (const mesh of link.meshes) {
      paths.add(mesh.file);
    }
  }
  return [...paths];
}

// Auto-match dataset columns to URDF joint names
export function autoMatchJoints(columnKeys: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const joint of SO101_JOINTS) {
    const exactMatch = columnKeys.find((k) => {
      const suffix = k.split(" | ").pop()?.trim() ?? k;
      return suffix === joint.name;
    });
    if (exactMatch) { mapping[joint.name] = exactMatch; continue; }
    const fuzzy = columnKeys.find((k) => k.toLowerCase().includes(joint.name));
    if (fuzzy) mapping[joint.name] = fuzzy;
  }
  return mapping;
}

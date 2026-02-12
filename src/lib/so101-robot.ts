export function isSO101Robot(robotType: string | null): boolean {
  if (!robotType) return false;
  const lower = robotType.toLowerCase();
  return lower.includes("so100") || lower.includes("so101") || lower === "so_follower";
}

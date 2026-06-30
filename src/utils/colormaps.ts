// Matplotlib "viridis" colormap as 256 RGB triples (perceptually uniform).
// Generated from matplotlib.cm.get_cmap("viridis", 256). Shared by the WebGL
// LUT texture and the 2D-canvas fallback in ColormappedVideo, and used to
// recolor single-channel (grayscale) camera feeds.

// prettier-ignore
export const VIRIDIS_LUT = new Uint8Array([
  68, 1, 84, 68, 2, 86, 69, 4, 87, 69, 5, 89, 70, 7, 90, 70, 8, 92, 70, 10, 93, 70, 11, 94,
  71, 13, 96, 71, 14, 97, 71, 16, 99, 71, 17, 100, 71, 19, 101, 72, 20, 103, 72, 22, 104, 72, 23, 105,
  72, 24, 106, 72, 26, 108, 72, 27, 109, 72, 28, 110, 72, 29, 111, 72, 31, 112, 72, 32, 113, 72, 33, 115,
  72, 35, 116, 72, 36, 117, 72, 37, 118, 72, 38, 119, 72, 40, 120, 72, 41, 121, 71, 42, 122, 71, 44, 122,
  71, 45, 123, 71, 46, 124, 71, 47, 125, 70, 48, 126, 70, 50, 126, 70, 51, 127, 70, 52, 128, 69, 53, 129,
  69, 55, 129, 69, 56, 130, 68, 57, 131, 68, 58, 131, 68, 59, 132, 67, 61, 132, 67, 62, 133, 66, 63, 133,
  66, 64, 134, 66, 65, 134, 65, 66, 135, 65, 68, 135, 64, 69, 136, 64, 70, 136, 63, 71, 136, 63, 72, 137,
  62, 73, 137, 62, 74, 137, 62, 76, 138, 61, 77, 138, 61, 78, 138, 60, 79, 138, 60, 80, 139, 59, 81, 139,
  59, 82, 139, 58, 83, 139, 58, 84, 140, 57, 85, 140, 57, 86, 140, 56, 88, 140, 56, 89, 140, 55, 90, 140,
  55, 91, 141, 54, 92, 141, 54, 93, 141, 53, 94, 141, 53, 95, 141, 52, 96, 141, 52, 97, 141, 51, 98, 141,
  51, 99, 141, 50, 100, 142, 50, 101, 142, 49, 102, 142, 49, 103, 142, 49, 104, 142, 48, 105, 142, 48, 106, 142,
  47, 107, 142, 47, 108, 142, 46, 109, 142, 46, 110, 142, 46, 111, 142, 45, 112, 142, 45, 113, 142, 44, 113, 142,
  44, 114, 142, 44, 115, 142, 43, 116, 142, 43, 117, 142, 42, 118, 142, 42, 119, 142, 42, 120, 142, 41, 121, 142,
  41, 122, 142, 41, 123, 142, 40, 124, 142, 40, 125, 142, 39, 126, 142, 39, 127, 142, 39, 128, 142, 38, 129, 142,
  38, 130, 142, 38, 130, 142, 37, 131, 142, 37, 132, 142, 37, 133, 142, 36, 134, 142, 36, 135, 142, 35, 136, 142,
  35, 137, 142, 35, 138, 141, 34, 139, 141, 34, 140, 141, 34, 141, 141, 33, 142, 141, 33, 143, 141, 33, 144, 141,
  33, 145, 140, 32, 146, 140, 32, 146, 140, 32, 147, 140, 31, 148, 140, 31, 149, 139, 31, 150, 139, 31, 151, 139,
  31, 152, 139, 31, 153, 138, 31, 154, 138, 30, 155, 138, 30, 156, 137, 30, 157, 137, 31, 158, 137, 31, 159, 136,
  31, 160, 136, 31, 161, 136, 31, 161, 135, 31, 162, 135, 32, 163, 134, 32, 164, 134, 33, 165, 133, 33, 166, 133,
  34, 167, 133, 34, 168, 132, 35, 169, 131, 36, 170, 131, 37, 171, 130, 37, 172, 130, 38, 173, 129, 39, 173, 129,
  40, 174, 128, 41, 175, 127, 42, 176, 127, 44, 177, 126, 45, 178, 125, 46, 179, 124, 47, 180, 124, 49, 181, 123,
  50, 182, 122, 52, 182, 121, 53, 183, 121, 55, 184, 120, 56, 185, 119, 58, 186, 118, 59, 187, 117, 61, 188, 116,
  63, 188, 115, 64, 189, 114, 66, 190, 113, 68, 191, 112, 70, 192, 111, 72, 193, 110, 74, 193, 109, 76, 194, 108,
  78, 195, 107, 80, 196, 106, 82, 197, 105, 84, 197, 104, 86, 198, 103, 88, 199, 101, 90, 200, 100, 92, 200, 99,
  94, 201, 98, 96, 202, 96, 99, 203, 95, 101, 203, 94, 103, 204, 92, 105, 205, 91, 108, 205, 90, 110, 206, 88,
  112, 207, 87, 115, 208, 86, 117, 208, 84, 119, 209, 83, 122, 209, 81, 124, 210, 80, 127, 211, 78, 129, 211, 77,
  132, 212, 75, 134, 213, 73, 137, 213, 72, 139, 214, 70, 142, 214, 69, 144, 215, 67, 147, 215, 65, 149, 216, 64,
  152, 216, 62, 155, 217, 60, 157, 217, 59, 160, 218, 57, 162, 218, 55, 165, 219, 54, 168, 219, 52, 170, 220, 50,
  173, 220, 48, 176, 221, 47, 178, 221, 45, 181, 222, 43, 184, 222, 41, 186, 222, 40, 189, 223, 38, 192, 223, 37,
  194, 223, 35, 197, 224, 33, 200, 224, 32, 202, 225, 31, 205, 225, 29, 208, 225, 28, 210, 226, 27, 213, 226, 26,
  216, 226, 25, 218, 227, 25, 221, 227, 24, 223, 227, 24, 226, 228, 24, 229, 228, 25, 231, 228, 25, 234, 229, 26,
  236, 229, 27, 239, 229, 28, 241, 229, 29, 244, 230, 30, 246, 230, 32, 248, 230, 33, 251, 231, 35, 253, 231, 37,
]);

// Maps a normalized luminance t in [0, 1] to its viridis RGB triple. Inputs
// are clamped, so out-of-range values resolve to the colormap endpoints.
export function viridisColor(t: number): [number, number, number] {
  const idx = Math.min(255, Math.max(0, Math.round(t * 255)));
  const o = idx * 3;
  return [VIRIDIS_LUT[o], VIRIDIS_LUT[o + 1], VIRIDIS_LUT[o + 2]];
}

// A video feature is grayscale when its shape's channel dimension
// ([height, width, channels]) is 1.
export function isGrayscaleShape(
  shape: readonly number[] | undefined,
): boolean {
  return shape?.[2] === 1;
}

// Unwraps lerobot's nested per-channel image-stat shape (e.g. [[[v]]] for a
// single-channel depth feature) down to its first scalar.
function firstScalar(value: unknown): number | undefined {
  let v: unknown = value;
  while (Array.isArray(v)) v = v[0];
  return typeof v === "number" ? v : undefined;
}

// Log/linear depth-video encoding params from an info.json feature's `info`
// block (lerobot.datasets.depth_utils.quantize_depth). depthMin/Max/shift are
// in metres; unitToMetres scales the stored depth stats into metres.
export interface DepthEncoding {
  depthMin: number;
  depthMax: number;
  shift: number;
  useLog: boolean;
  unitToMetres: number;
}

// Reads the depth-quantization params from an info.json feature. Returns
// undefined unless the feature is flagged `is_depth_map` and carries valid
// tuning params — callers then treat the feed as plain (already [0,1]) data.
export function depthEncodingFromFeature(
  feature: unknown,
): DepthEncoding | undefined {
  if (feature == null || typeof feature !== "object") return undefined;
  const info = (feature as Record<string, unknown>).info;
  if (info == null || typeof info !== "object") return undefined;
  const i = info as Record<string, unknown>;
  if (i.is_depth_map !== true) return undefined;
  const depthMin = i["video.depth_min"];
  const depthMax = i["video.depth_max"];
  const shift = i["video.shift"];
  const useLog = i["video.use_log"];
  if (
    typeof depthMin !== "number" ||
    typeof depthMax !== "number" ||
    typeof shift !== "number" ||
    typeof useLog !== "boolean" ||
    !(depthMax > depthMin) ||
    (useLog && depthMin + shift <= 0)
  ) {
    return undefined;
  }
  // depth_unit names the unit of the stored depth stats. Without it we don't
  // rescale — the stats are used as-is. "mm" scales down to metres; "m" is a
  // no-op.
  if (i.depth_unit == null) {
    console.warn(
      '[depth] feature is missing `info["depth_unit"]` in info.json — using the stats as-is (no rescaling). Set depth_unit to "mm" or "m" to silence this.',
    );
  }
  const unitToMetres = i.depth_unit === "mm" ? 1 / 1000 : 1;
  return { depthMin, depthMax, shift, useLog, unitToMetres };
}

// Derives the [low, high] luminance band the colormap should span from a
// meta/stats.json feature entry's q01/q99 quantiles, stretching the feed so
// outliers don't wash out the colormap. Returns undefined when the quantiles
// are missing, non-finite, or don't form a valid increasing range — callers
// then fall back to 0..1.
//
// For a plain (already 0..1) grayscale feed the q01/q99 band is used directly.
// For a depth map, q01/q99 live in the feed's stored depth units, so they're
// mapped through the same forward quantization the video used: the browser's
// decoded luminance equals that normalized code, so the quantized q01/q99
// become the luminance window to stretch across the colormap. depth_min/max/
// shift are in metres, so the quantiles are first scaled to metres via the
// encoding's unitToMetres factor (derived from the feature's depth_unit).
export function depthColormapRange(
  statsEntry: unknown,
  encoding?: DepthEncoding,
): [number, number] | undefined {
  if (statsEntry == null || typeof statsEntry !== "object") return undefined;
  const entry = statsEntry as Record<string, unknown>;
  const low = firstScalar(entry.q01) ?? firstScalar(entry.min);
  const high = firstScalar(entry.q99) ?? firstScalar(entry.max);
  if (low === undefined || high === undefined) return undefined;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
  if (high <= low) return undefined;
  if (!encoding) return [low, high];

  const { depthMin, depthMax, shift, useLog, unitToMetres } = encoding;
  const normCode = (depth: number): number => {
    const d = depth * unitToMetres;
    const norm = useLog
      ? (Math.log(d + shift) - Math.log(depthMin + shift)) /
        (Math.log(depthMax + shift) - Math.log(depthMin + shift))
      : (d - depthMin) / (depthMax - depthMin);
    return Math.min(1, Math.max(0, norm));
  };
  const normLow = normCode(low);
  const normHigh = normCode(high);
  if (normHigh <= normLow) return undefined;
  return [normLow, normHigh];
}

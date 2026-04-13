import {
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  parquetRead,
  parquetReadObjects,
  type AsyncBuffer,
} from "hyparquet";
import { parseLocalDatasetUrl } from "@/utils/datasetSource";

export interface DatasetMetadata {
  codebase_version: string;
  robot_type: string;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  total_videos: number;
  total_chunks: number;
  chunks_size: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<
    string,
    {
      dtype: string;
      shape: number[];
      names: string[] | Record<string, unknown> | null;
      info?: Record<string, unknown>;
    }
  >;
}

function expandHomeDir(inputPath: string): string {
  if (inputPath === "~") {
    return process.env.HOME ?? inputPath;
  }
  if (inputPath.startsWith("~/")) {
    return `${process.env.HOME ?? "~"}/${inputPath.slice(2)}`;
  }
  return inputPath;
}

async function runtimeImport<T>(specifier: string): Promise<T> {
  const importer = Function("moduleName", "return import(moduleName)") as (
    moduleName: string,
  ) => Promise<unknown>;
  return (await importer(specifier)) as T;
}

async function getServerPathModule(): Promise<typeof import("path")> {
  return runtimeImport<typeof import("path")>("path");
}

async function getServerFsPromises(): Promise<typeof import("fs/promises")> {
  return runtimeImport<typeof import("fs/promises")>("fs/promises");
}

async function resolveLocalDatasetFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const path = await getServerPathModule();
  const normalizedRoot = path.resolve(
    expandHomeDir(root.replace(/^file:\/\//, "")),
  );
  const targetPath = path.resolve(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the dataset directory");
  }
  return targetPath;
}

async function readLocalDatasetFile(url: string): Promise<ArrayBuffer> {
  const parsed = parseLocalDatasetUrl(url);
  if (!parsed) {
    throw new Error(`Invalid local dataset URL: ${url}`);
  }

  const filePath = await resolveLocalDatasetFile(parsed.root, parsed.path);
  const fs = await getServerFsPromises();
  const file = await fs.readFile(filePath);
  return file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const localDataset = parseLocalDatasetUrl(url);
  if (localDataset) {
    const fs = await getServerFsPromises();
    const raw = await fs.readFile(
      await resolveLocalDatasetFile(localDataset.root, localDataset.path),
      "utf8",
    );
    return JSON.parse(raw) as T;
  }

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch JSON ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export function formatStringWithVars(
  format: string,
  vars: Record<string, string | number>,
): string {
  return format.replace(/{(\w+)(?::\d+d)?}/g, (_, key) => String(vars[key]));
}

// Fetch and parse the Parquet file
type ParquetFile = ArrayBuffer | AsyncBuffer;

const parquetFileCache = new Map<string, AsyncBuffer>();

export async function fetchParquetFile(url: string): Promise<ParquetFile> {
  const localDataset = parseLocalDatasetUrl(url);
  if (localDataset) {
    return readLocalDatasetFile(url);
  }

  const cached = parquetFileCache.get(url);
  if (cached) return cached;

  const file = await asyncBufferFromUrl({
    url,
    requestInit: { cache: "no-store" },
  });
  const wrapped = cachedAsyncBuffer(file);
  parquetFileCache.set(url, wrapped);
  return wrapped;
}

// Read specific columns from the Parquet file
export async function readParquetColumn(
  fileBuffer: ParquetFile,
  columns: string[],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    try {
      parquetRead({
        file: fileBuffer,
        columns: columns.length > 0 ? columns : undefined,
        rowStart: options?.rowStart,
        rowEnd: options?.rowEnd,
        onComplete: (data: unknown[][]) => {
          resolve(data);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function readParquetAsObjects(
  fileBuffer: ParquetFile,
  columns: string[] = [],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({
    file: fileBuffer,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: options?.rowStart,
    rowEnd: options?.rowEnd,
  }) as Promise<Record<string, unknown>[]>;
}

export async function fetchText(url: string): Promise<string> {
  const localDataset = parseLocalDatasetUrl(url);
  if (localDataset) {
    const fs = await getServerFsPromises();
    return fs.readFile(
      await resolveLocalDatasetFile(localDataset.root, localDataset.path),
      "utf8",
    );
  }

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch text ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}

// Convert a 2D array to a CSV string
export function arrayToCSV(data: (number | string)[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

type ColumnInfo = { key: string; value: string[] };

export function getRows(currentFrameData: unknown[], columns: ColumnInfo[]) {
  if (!currentFrameData || currentFrameData.length === 0) {
    return [];
  }

  const rows: Array<Array<{ isNull: true } | unknown>> = [];
  const nRows = Math.max(...columns.map((column) => column.value.length));
  let rowIndex = 0;

  while (rowIndex < nRows) {
    const row: Array<{ isNull: true } | unknown> = [];
    // number of states may NOT match number of actions. In this case, we null-pad the 2D array
    const nullCell = { isNull: true };
    // row consists of [state value, action value]
    let idx = rowIndex;

    for (const column of columns) {
      const nColumn = column.value.length;
      row.push(rowIndex < nColumn ? currentFrameData[idx] : nullCell);
      idx += nColumn; // because currentFrameData = [state0, state1, ..., stateN, action0, action1, ..., actionN]
    }

    rowIndex += 1;
    rows.push(row);
  }

  return rows;
}

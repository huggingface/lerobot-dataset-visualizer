import { parquetRead, parquetReadObjects } from "hyparquet";

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
      shape: any[];
      names: any[] | Record<string, any> | null;
      info?: Record<string, any>;
    }
  >;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch JSON ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export function formatStringWithVars(
  format: string,
  vars: Record<string, any>,
): string {
  return format.replace(/{(\w+)(?::\d+d)?}/g, (_, key) => vars[key]);
}

// Fetch and parse the Parquet file
export async function fetchParquetFile(url: string): Promise<ArrayBuffer> {
  console.log(`[DEBUG] Fetching parquet file: ${url}`);
  
  try {
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    
    const arrayBuffer = await res.arrayBuffer();
    console.log(`[DEBUG] Fetched ${arrayBuffer.byteLength} bytes from ${url}`);
    
    // Check if this looks like a parquet file
    const view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 8) {
      throw new Error(`File too small to be a parquet file: ${arrayBuffer.byteLength} bytes`);
    }
    
    // Check magic bytes at start and end
    const startMagic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const endMagic = String.fromCharCode(
      view.getUint8(arrayBuffer.byteLength - 4),
      view.getUint8(arrayBuffer.byteLength - 3),
      view.getUint8(arrayBuffer.byteLength - 2),
      view.getUint8(arrayBuffer.byteLength - 1)
    );
    
    console.log(`[DEBUG] File magic bytes - Start: '${startMagic}', End: '${endMagic}'`);
    
    if (endMagic !== 'PAR1') {
      console.error(`[ERROR] Invalid parquet file from ${url}`);
      console.error(`[ERROR] Expected end magic 'PAR1', got '${endMagic}'`);
      console.error(`[ERROR] First 100 chars of response: ${new TextDecoder().decode(arrayBuffer.slice(0, 100)).replace(/\n/g, '\\n')}`);
    }
    
    return arrayBuffer;
  } catch (error) {
    console.error(`[ERROR] Failed to fetch parquet file from ${url}:`, error);
    throw error;
  }
}

// Read specific columns from the Parquet file
export async function readParquetColumn(
  fileBuffer: ArrayBuffer,
  columns: string[],
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    try {
      parquetRead({
        file: fileBuffer,
        columns: columns.length > 0 ? columns : undefined, // Let hyparquet read all columns if empty array
        onComplete: (data: any[]) => {
          resolve(data);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Read parquet file and return objects with column names as keys
export async function readParquetAsObjects(
  fileBuffer: ArrayBuffer,
  columns: string[] = [],
): Promise<Record<string, any>[]> {
  try {
    console.log(`[DEBUG] Reading parquet as objects`);
    const result = await parquetReadObjects({
      file: fileBuffer,
      columns: columns.length > 0 ? columns : undefined,
    });
    console.log(`[DEBUG] Successfully read ${result.length} rows as objects`);
    return result;
  } catch (error) {
    console.error(`[ERROR] Failed to read parquet as objects:`, error);
    throw error;
  }
}

// Convert a 2D array to a CSV string
export function arrayToCSV(data: (number | string)[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

// Get rows from the current frame data
export function getRows(currentFrameData: any[], columns: any[]) {
  if (!currentFrameData || currentFrameData.length === 0) {
    return [];
  }

  const rows = [];
  const nRows = Math.max(...columns.map((column) => column.value.length));
  let rowIndex = 0;

  while (rowIndex < nRows) {
    const row = [];
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

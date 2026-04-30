/**
 * Client for the FastAPI annotation backend in `backend/`.
 *
 * The backend URL is configured via the `NEXT_PUBLIC_ANNOTATE_BACKEND_URL`
 * env var so it can be statically substituted by Next.js. When unset, all
 * annotation write paths are disabled and the UI falls back to sessionStorage
 * for read/edit only.
 */

import type { LanguageAtom } from "../types/language.types";

const ENV_URL = (() => {
  const v =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_ANNOTATE_BACKEND_URL
      : undefined;
  return (v || "").trim() || null;
})();

export function isAnnotateBackendEnabled(): boolean {
  return !!ENV_URL;
}

export function getAnnotateBackendUrl(): string | null {
  return ENV_URL;
}

interface DatasetIdent {
  repoId?: string | null;
  localPath?: string | null;
  revision?: string | null;
}

function buildUrl(path: string, ident: DatasetIdent): string {
  if (!ENV_URL) throw new Error("Annotate backend not configured");
  const url = new URL(path, ENV_URL);
  if (ident.repoId) url.searchParams.set("repo_id", ident.repoId);
  if (ident.revision) url.searchParams.set("revision", ident.revision);
  if (ident.localPath) url.searchParams.set("local_path", ident.localPath);
  return url.toString();
}

export async function pingBackend(): Promise<boolean> {
  if (!ENV_URL) return false;
  try {
    const res = await fetch(new URL("/api/health", ENV_URL).toString());
    return res.ok;
  } catch {
    return false;
  }
}

export async function loadDataset(
  ident: DatasetIdent,
): Promise<{ ok: boolean }> {
  if (!ENV_URL) return { ok: false };
  const res = await fetch(new URL("/api/dataset/load", ENV_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: ident.repoId || null,
      revision: ident.revision || null,
      local_path: ident.localPath || null,
    }),
  });
  return { ok: res.ok };
}

export async function fetchEpisodeAtoms(
  episodeId: number,
  ident: DatasetIdent,
): Promise<LanguageAtom[]> {
  if (!ENV_URL) return [];
  await loadDataset(ident);
  const res = await fetch(buildUrl(`/api/episodes/${episodeId}/atoms`, ident));
  if (!res.ok) {
    throw new Error(`fetch atoms: ${res.status}`);
  }
  const data = (await res.json()) as { atoms?: LanguageAtom[] };
  return data.atoms || [];
}

export async function saveEpisodeAtoms(
  episodeId: number,
  ident: DatasetIdent,
  atoms: LanguageAtom[],
): Promise<void> {
  if (!ENV_URL) return;
  const res = await fetch(
    new URL(`/api/episodes/${episodeId}/atoms`, ENV_URL).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode_index: episodeId,
        repo_id: ident.repoId || null,
        local_path: ident.localPath || null,
        atoms,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => `${res.status}`);
    throw new Error(text || `save atoms: ${res.status}`);
  }
}

export async function fetchFrameTimestamps(
  episodeId: number,
  ident: DatasetIdent,
): Promise<number[]> {
  if (!ENV_URL) return [];
  const res = await fetch(
    buildUrl(`/api/episodes/${episodeId}/frame_timestamps`, ident),
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { timestamps?: number[] };
  return data.timestamps || [];
}

export async function exportDataset(
  ident: DatasetIdent,
  outputDir?: string | null,
  copyVideos = false,
): Promise<{
  output_dir: string;
  persistent_rows: number;
  event_rows: number;
}> {
  if (!ENV_URL) throw new Error("Annotate backend not configured");
  const res = await fetch(new URL("/api/export", ENV_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: ident.repoId || null,
      revision: ident.revision || null,
      local_path: ident.localPath || null,
      output_dir: outputDir || null,
      copy_videos: !!copyVideos,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `${res.status}`);
    throw new Error(text || `export: ${res.status}`);
  }
  return res.json();
}

export interface PushToHubResult {
  ok: boolean;
  repo_id: string;
  url: string;
  message: string;
}

export async function pushToHub(
  ident: DatasetIdent,
  hfToken: string,
  pushInPlace: boolean,
  newRepoId: string | null,
  privateRepo: boolean,
  commitMessage: string,
): Promise<PushToHubResult> {
  if (!ENV_URL) throw new Error("Annotate backend not configured");
  const res = await fetch(new URL("/api/push_to_hub", ENV_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: ident.repoId || null,
      revision: ident.revision || null,
      local_path: ident.localPath || null,
      hf_token: hfToken,
      push_in_place: pushInPlace,
      new_repo_id: newRepoId || null,
      private: privateRepo,
      commit_message: commitMessage,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `${res.status}`);
    throw new Error(text || `push: ${res.status}`);
  }
  return res.json();
}

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

export interface BackendHealth {
  ok: boolean;
  service: string;
  has_hf_token?: boolean;
  hf_user?: string;
  hf_token_preview?: string;
}

export async function fetchHealth(): Promise<BackendHealth | null> {
  if (!ENV_URL) return null;
  try {
    const res = await fetch(new URL("/api/health", ENV_URL).toString());
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pingBackend(): Promise<boolean> {
  const health = await fetchHealth();
  return !!health?.ok;
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
): Promise<{ path: string | null }> {
  if (!ENV_URL) return { path: null };
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
  const data = (await res.json().catch(() => ({}))) as { path?: string | null };
  return { path: data.path ?? null };
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
  commit_url?: string | null;
  pr_url?: string | null;
  commit_oid?: string | null;
  message: string;
}

export interface PushToHubParams {
  ident: DatasetIdent;
  hfToken?: string;
  pushInPlace?: boolean;
  newRepoId?: string | null;
  privateRepo?: boolean;
  commitMessage?: string;
  commitDescription?: string;
  branch?: string;
  createPr?: boolean;
}

export async function pushToHub(
  paramsOrIdent: PushToHubParams | DatasetIdent,
  legacyHfToken?: string,
  legacyPushInPlace?: boolean,
  legacyNewRepoId?: string | null,
  legacyPrivateRepo?: boolean,
  legacyCommitMessage?: string,
): Promise<PushToHubResult> {
  if (!ENV_URL) throw new Error("Annotate backend not configured");

  const isParamsObject = "ident" in paramsOrIdent;
  const ident = isParamsObject ? paramsOrIdent.ident : paramsOrIdent;
  const hfToken = isParamsObject ? paramsOrIdent.hfToken : legacyHfToken;
  const pushInPlace = isParamsObject
    ? (paramsOrIdent.pushInPlace ?? true)
    : (legacyPushInPlace ?? true);
  const newRepoId = isParamsObject ? paramsOrIdent.newRepoId : legacyNewRepoId;
  const privateRepo = isParamsObject
    ? !!paramsOrIdent.privateRepo
    : !!legacyPrivateRepo;
  const commitMessage = isParamsObject
    ? (paramsOrIdent.commitMessage ?? "Add language annotations")
    : (legacyCommitMessage ?? "Add language annotations");
  const commitDescription = isParamsObject
    ? paramsOrIdent.commitDescription
    : undefined;
  const branch = isParamsObject ? paramsOrIdent.branch : undefined;
  const createPr = isParamsObject ? !!paramsOrIdent.createPr : false;

  const res = await fetch(new URL("/api/push_to_hub", ENV_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: ident.repoId || null,
      revision: ident.revision || null,
      local_path: ident.localPath || null,
      hf_token: hfToken || null,
      push_in_place: pushInPlace,
      new_repo_id: newRepoId || null,
      private: privateRepo,
      commit_message: commitMessage,
      commit_description: commitDescription || null,
      branch: branch || null,
      create_pr: createPr,
    }),
  });

  if (!res.ok) {
    let errorDetail: string;
    try {
      const data = await res.json();
      errorDetail =
        typeof data === "object" && data !== null
          ? data.detail || data.message || JSON.stringify(data)
          : String(data);
    } catch {
      errorDetail = await res.text().catch(() => `HTTP ${res.status}`);
    }
    throw new Error(errorDetail || `push: ${res.status}`);
  }
  return res.json();
}

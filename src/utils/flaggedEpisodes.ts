/**
 * Where flagged episodes are kept. One entry per dataset: an episode index means nothing without its
 * dataset, and a single shared list showed dataset A's flags on dataset B.
 */
const KEY_PREFIX = "lerobot-viz-flagged:";

export function flaggedStorageKey(repoId: string): string {
  return `${KEY_PREFIX}${repoId}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The stored flags, dropping anything that is not an episode index. */
export function parseFlagged(raw: string | null): Set<number> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (id): id is number =>
          typeof id === "number" && Number.isInteger(id) && id >= 0,
      ),
    );
  } catch {
    return new Set();
  }
}

export function readFlagged(
  storage: StorageLike | undefined,
  repoId: string,
): Set<number> {
  if (!storage) return new Set();
  try {
    return parseFlagged(storage.getItem(flaggedStorageKey(repoId)));
  } catch {
    // Storage blocked (private mode, embedded iframe): start empty.
    return new Set();
  }
}

export function writeFlagged(
  storage: StorageLike | undefined,
  repoId: string,
  flagged: ReadonlySet<number>,
): void {
  if (!storage) return;
  try {
    const key = flaggedStorageKey(repoId);
    if (flagged.size === 0) storage.removeItem(key);
    else
      storage.setItem(key, JSON.stringify([...flagged].sort((a, b) => a - b)));
  } catch {
    // Storage blocked or full: the flags last for this page only.
  }
}

"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import {
  flaggedStorageKey,
  parseFlagged,
  readFlagged,
  writeFlagged,
} from "@/utils/flaggedEpisodes";

type FlaggedEpisodesContextType = {
  flagged: Set<number>;
  count: number;
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  addMany: (ids: number[]) => void;
  removeMany: (ids: number[]) => void;
  clear: () => void;
};

const FlaggedEpisodesContext = createContext<
  FlaggedEpisodesContextType | undefined
>(undefined);

export function useFlaggedEpisodes() {
  const ctx = useContext(FlaggedEpisodesContext);
  if (!ctx)
    throw new Error(
      "useFlaggedEpisodes must be used within FlaggedEpisodesProvider",
    );
  return ctx;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Flags for one dataset, kept in localStorage so a review spread over several sittings survives.
 * Mount it with `key={repoId}`: the flags are read once, when the provider mounts. It only ever
 * mounts in the browser (behind the episode loading gate), so reading storage up front is safe.
 */
export const FlaggedEpisodesProvider: React.FC<{
  repoId: string;
  children: React.ReactNode;
}> = ({ repoId, children }) => {
  const [flagged, setFlagged] = useState<Set<number>>(() =>
    readFlagged(browserStorage(), repoId),
  );

  useEffect(() => {
    writeFlagged(browserStorage(), repoId, flagged);
  }, [flagged, repoId]);

  // Another tab on the same dataset changed the flags: follow it.
  useEffect(() => {
    const key = flaggedStorageKey(repoId);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      const next = parseFlagged(e.newValue);
      setFlagged((prev) =>
        prev.size === next.size && [...prev].every((id) => next.has(id))
          ? prev
          : next,
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [repoId]);

  const toggle = useCallback((id: number) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addMany = useCallback((ids: number[]) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const removeMany = useCallback((ids: number[]) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const clear = useCallback(
    () => setFlagged((prev) => (prev.size === 0 ? prev : new Set())),
    [],
  );

  const has = useCallback((id: number) => flagged.has(id), [flagged]);

  const value = useMemo(
    () => ({
      flagged,
      count: flagged.size,
      has,
      toggle,
      addMany,
      removeMany,
      clear,
    }),
    [flagged, has, toggle, addMany, removeMany, clear],
  );

  return (
    <FlaggedEpisodesContext.Provider value={value}>
      {children}
    </FlaggedEpisodesContext.Provider>
  );
};

"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from "react";

const STORAGE_KEY = "flagged-episodes";

function saveToStorage(s: Set<number>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

type FlaggedEpisodesContextType = {
  flagged: Set<number>;
  count: number;
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  addMany: (ids: number[]) => void;
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

export const FlaggedEpisodesProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [flagged, setFlagged] = useState<Set<number>>(new Set());

  // Hydrate from sessionStorage after mount (avoids SSR/client mismatch)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) setFlagged(new Set(JSON.parse(raw) as number[]));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    saveToStorage(flagged);
  }, [flagged]);

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
      return next;
    });
  }, []);

  const clear = useCallback(() => setFlagged(new Set()), []);

  const has = useCallback((id: number) => flagged.has(id), [flagged]);

  const value = useMemo(
    () => ({
      flagged,
      count: flagged.size,
      has,
      toggle,
      addMany,
      clear,
    }),
    [flagged, has, toggle, addMany, clear],
  );

  return (
    <FlaggedEpisodesContext.Provider value={value}>
      {children}
    </FlaggedEpisodesContext.Provider>
  );
};

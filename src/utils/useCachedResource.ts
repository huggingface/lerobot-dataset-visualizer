"use client";

import { useEffect, useRef, useState } from "react";
import type { AsyncCache } from "@/utils/asyncCache";

export type LoadProgress = { done: number; total: number };

/**
 * A value loaded once per `key` and kept in `cache`, so a component that remounts (the viewer does,
 * on every episode change) has it on its first render instead of loading it again.
 *
 * Nothing is loaded until `enabled` is first true; after that the value stays, whatever `enabled`
 * does, so leaving and re-entering a tab keeps it.
 */
export function useCachedResource<T>(
  cache: AsyncCache<T>,
  key: string,
  enabled: boolean,
  load: (onProgress: (progress: LoadProgress) => void) => Promise<T>,
): {
  data: T | null;
  loading: boolean;
  /** The load threw. It is not cached, so the next mount tries again. */
  failed: boolean;
  progress: LoadProgress | null;
} {
  const [state, setState] = useState(() => {
    const hit = cache.peek(key);
    return {
      key,
      settled: !!hit,
      failed: false,
      data: hit ? hit.value : null,
    };
  });
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [wanted, setWanted] = useState(enabled);
  if (enabled && !wanted) setWanted(true);

  // The latest `load` without making it a dependency: callers pass a fresh closure every render.
  const loadRef = useRef(load);
  loadRef.current = load;
  // Which key is on screen, for progress reports: they come from whichever mount started the
  // load, which under React's development double-mount is not the one still listening.
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    const hit = cache.peek(key);
    if (hit) {
      setState((prev) =>
        prev.key === key && prev.settled
          ? prev
          : { key, settled: true, failed: false, data: hit.value },
      );
      return;
    }
    let live = true;
    shownKey.current = key;
    setState({ key, settled: false, failed: false, data: null });
    setProgress(null);
    cache
      .get(key, () =>
        loadRef.current((next) => {
          if (shownKey.current === key) setProgress(next);
        }),
      )
      .then(
        (data) => {
          if (live) setState({ key, settled: true, failed: false, data });
        },
        () => {
          if (live) setState({ key, settled: true, failed: true, data: null });
        },
      );
    return () => {
      live = false;
    };
  }, [cache, key, wanted]);

  useEffect(
    () => () => {
      shownKey.current = null;
    },
    [],
  );

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    loading: wanted && !(current && state.settled),
    failed: current && state.failed,
    progress: current && !state.settled ? progress : null,
  };
}

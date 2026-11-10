/**
 * Remembers the results of slow loads, by key, for the life of the page. The dataset-wide analyses
 * (episode lengths, the Frames listing, the cross-episode statistics) depend on the dataset, not on
 * the episode on screen, but the viewer remounts on every episode change and used to compute them
 * again each time.
 */
export class AsyncCache<T> {
  private readonly entries = new Map<
    string,
    { promise: Promise<T>; settled: boolean; value?: T }
  >();

  /** `maxEntries` keys are kept, least recently used out first. */
  constructor(private readonly maxEntries: number) {}

  /** The cached load for `key`, starting `load` if there is none. A failed load is not kept. */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }
    const entry: { promise: Promise<T>; settled: boolean; value?: T } = {
      // Started on the next microtask, so a `load` that throws rejects rather than escaping.
      promise: Promise.resolve().then(load),
      settled: false,
    };
    entry.promise.then(
      (value) => {
        entry.settled = true;
        entry.value = value;
      },
      () => {
        // Only drop it if it is still this load: a retry may have replaced it.
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  /** The value for `key` if its load has finished; wrapped, since the value itself may be null. */
  peek(key: string): { value: T } | undefined {
    const hit = this.entries.get(key);
    return hit?.settled ? { value: hit.value as T } : undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}

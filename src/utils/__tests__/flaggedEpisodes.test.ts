import { describe, expect, test } from "bun:test";
import {
  flaggedStorageKey,
  parseFlagged,
  readFlagged,
  writeFlagged,
} from "@/utils/flaggedEpisodes";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("flagged episodes storage", () => {
  test("each dataset has its own entry", () => {
    const storage = memoryStorage();
    writeFlagged(storage, "org/a", new Set([5, 1]));
    writeFlagged(storage, "org/b", new Set([9]));

    expect([...readFlagged(storage, "org/a")]).toEqual([1, 5]);
    expect([...readFlagged(storage, "org/b")]).toEqual([9]);
    expect(readFlagged(storage, "org/c").size).toBe(0);
    expect(flaggedStorageKey("org/a")).not.toBe(flaggedStorageKey("org/b"));
  });

  test("clearing the flags removes the entry", () => {
    const storage = memoryStorage();
    writeFlagged(storage, "org/a", new Set([2]));
    writeFlagged(storage, "org/a", new Set());

    expect(storage.data.size).toBe(0);
  });

  test("ignores stored values that are not episode indexes", () => {
    expect([...parseFlagged('[3, "4", -1, 2.5, null, 7]')]).toEqual([3, 7]);
    expect(parseFlagged("not json").size).toBe(0);
    expect(parseFlagged('{"0": 1}').size).toBe(0);
    expect(parseFlagged(null).size).toBe(0);
  });

  test("a blocked storage reads as empty and writes nothing", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };

    expect(readFlagged(blocked, "org/a").size).toBe(0);
    expect(() => writeFlagged(blocked, "org/a", new Set([1]))).not.toThrow();
    expect(readFlagged(undefined, "org/a").size).toBe(0);
  });
});

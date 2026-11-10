import { describe, expect, test } from "bun:test";
import { AsyncCache } from "@/utils/asyncCache";

describe("AsyncCache", () => {
  test("loads a key once and shares the result", async () => {
    const cache = new AsyncCache<number>(4);
    let loads = 0;
    const load = async () => ++loads;

    const [first, second] = await Promise.all([
      cache.get("a", load),
      cache.get("a", load),
    ]);

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(await cache.get("a", load)).toBe(1);
    expect(loads).toBe(1);
  });

  test("peek gives a finished value, and nothing while it loads", async () => {
    const cache = new AsyncCache<string | null>(4);
    let finish!: (value: string | null) => void;
    const pending = cache.get(
      "a",
      () => new Promise<string | null>((resolve) => (finish = resolve)),
    );

    expect(cache.peek("a")).toBeUndefined();
    await Promise.resolve();
    finish(null);
    await pending;

    // A null result is a result: wrapped, so it is not mistaken for "not loaded".
    expect(cache.peek("a")).toEqual({ value: null });
    expect(cache.peek("missing")).toBeUndefined();
  });

  test("a failed load is not kept, so the next call retries", async () => {
    const cache = new AsyncCache<number>(4);
    let attempts = 0;
    const load = async () => {
      attempts++;
      if (attempts === 1) throw new Error("network");
      return 42;
    };

    await expect(cache.get("a", load)).rejects.toThrow("network");
    expect(cache.peek("a")).toBeUndefined();
    expect(await cache.get("a", load)).toBe(42);
    expect(attempts).toBe(2);
  });

  test("a load that throws synchronously rejects instead of escaping", async () => {
    const cache = new AsyncCache<number>(4);
    const promise = cache.get("a", () => {
      throw new Error("boom");
    });

    await expect(promise).rejects.toThrow("boom");
  });

  test("drops the least recently used key past its size", async () => {
    const cache = new AsyncCache<string>(2);
    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    // Touch "a", so "b" is the one to go.
    await cache.get("a", async () => "a again");
    await cache.get("c", async () => "c");

    expect(cache.peek("a")).toEqual({ value: "a" });
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")).toEqual({ value: "c" });
  });
});

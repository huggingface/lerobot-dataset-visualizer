import { describe, expect, test } from "bun:test";
import {
  FrameCancelled,
  FrameThumbnails,
  type FrameDecoder,
} from "@/utils/frameThumbnails";

/** Decoders that record what they were asked for and answer on demand. */
function fakeDecoders(durations: Record<string, number> = {}) {
  const log: string[] = [];
  const decoders: { url: string | null; closed: boolean }[] = [];
  let active = 0;
  let peak = 0;
  const failing = new Set<string>();

  const create = (): FrameDecoder<string> => {
    const state = { url: null as string | null, closed: false };
    decoders.push(state);
    return {
      async open(url) {
        log.push(`open ${url}`);
        await Promise.resolve();
        if (failing.has(url)) throw new Error(`cannot open ${url}`);
        state.url = url;
        return durations[url] ?? 100;
      },
      async grab(time) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        log.push(`grab ${state.url}@${time}`);
        return `${state.url}@${time}`;
      },
      close() {
        state.closed = true;
      },
    };
  };
  return { create, log, decoders, failing, peak: () => peak };
}

const options = { maxDecoders: 2, cacheSize: 3, idleCloseMs: 0 };

describe("FrameThumbnails", () => {
  test("opens a file once for every frame asked of it", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    const results = await Promise.all(
      [0.5, 7.5, 14.5].map(
        (time) => frames.request({ url: "a", time }).promise,
      ),
    );

    expect(results).toEqual(["a@0.5", "a@7.5", "a@14.5"]);
    expect(fake.log).toEqual([
      "open a",
      "grab a@0.5",
      "grab a@7.5",
      "grab a@14.5",
    ]);
    expect(fake.decoders.length).toBe(1);
  });

  test("never runs more decoders than allowed", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    await Promise.all(
      ["a", "b", "c", "d", "e"].map(
        (url) => frames.request({ url, time: 1 }).promise,
      ),
    );

    expect(fake.decoders.length).toBe(2);
    expect(fake.peak()).toBeLessThanOrEqual(2);
    expect(fake.log.filter((l) => l.startsWith("grab")).length).toBe(5);
  });

  test("serves a repeated frame from the cache", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    await frames.request({ url: "a", time: 1 }).promise;
    const again = await frames.request({ url: "a", time: 1 }).promise;

    expect(again).toBe("a@1");
    expect(fake.log.filter((l) => l.startsWith("grab")).length).toBe(1);
  });

  test("evicts the least recently used frame past the cache size", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    for (const time of [1, 2, 3]) {
      await frames.request({ url: "a", time }).promise;
    }
    // Touch frame 1, so frame 2 is now the oldest, then push one more in.
    await frames.request({ url: "a", time: 1 }).promise;
    await frames.request({ url: "a", time: 4 }).promise;
    fake.log.length = 0;

    await frames.request({ url: "a", time: 1 }).promise;
    await frames.request({ url: "a", time: 2 }).promise;

    expect(fake.log).toEqual(["grab a@2"]);
  });

  test("two requests for one frame share one grab", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    const [first, second] = await Promise.all([
      frames.request({ url: "a", time: 1 }).promise,
      frames.request({ url: "a", time: 1 }).promise,
    ]);

    expect(first).toBe(second);
    expect(fake.log.filter((l) => l.startsWith("grab")).length).toBe(1);
  });

  test("a cancelled request is never grabbed", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    const kept = frames.request({ url: "a", time: 1 });
    const dropped = frames.request({ url: "a", time: 2 });
    dropped.cancel();

    await kept.promise;
    await expect(dropped.promise).rejects.toBeInstanceOf(FrameCancelled);
    expect(fake.log).toEqual(["open a", "grab a@1"]);
  });

  test("cancelling one of two requesters keeps the frame for the other", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, options);

    const first = frames.request({ url: "a", time: 1 });
    const second = frames.request({ url: "a", time: 1 });
    first.cancel();

    expect(await second.promise).toBe("a@1");
  });

  test("the last frame is sought from the file's duration", async () => {
    const fake = fakeDecoders({ a: 12 });
    const frames = new FrameThumbnails(fake.create, options);

    const frame = await frames.request({ url: "a", time: null, endOffset: 0.5 })
      .promise;

    expect(frame).toBe("a@11.5");
  });

  test("a file that will not open fails its frames and frees the decoder", async () => {
    const fake = fakeDecoders();
    fake.failing.add("bad");
    const frames = new FrameThumbnails(fake.create, {
      ...options,
      maxDecoders: 1,
    });

    const bad = frames.request({ url: "bad", time: 1 });
    const good = frames.request({ url: "good", time: 1 });

    await expect(bad.promise).rejects.toThrow("cannot open bad");
    expect(await good.promise).toBe("good@1");
  });

  test("close() stops the decoders and drops queued frames", async () => {
    const fake = fakeDecoders();
    const frames = new FrameThumbnails(fake.create, {
      ...options,
      maxDecoders: 1,
    });

    const queued = frames.request({ url: "a", time: 1 });
    const waiting = frames.request({ url: "b", time: 1 });
    frames.close();

    await expect(waiting.promise).rejects.toBeInstanceOf(FrameCancelled);
    expect(fake.decoders.every((d) => d.closed)).toBe(true);
    // The one in flight settles one way or the other; it must not hang.
    await queued.promise.catch(() => {});

    // And the queue still works afterwards.
    expect(await frames.request({ url: "c", time: 2 }).promise).toBe("c@2");
  });
});

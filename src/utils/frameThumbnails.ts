/**
 * Still frames out of video files, for the Frames tab.
 *
 * The tab used to mount one <video> per thumbnail. In a v3.0 dataset dozens of episodes share a
 * file, so a page of 48 thumbnails opened the same file 48 times: 48 decoders, 48 copies of its
 * index, 48 sets of range requests. Here a file is opened once by one decoder, which seeks from
 * frame to frame and hands each back as a small image; a few decoders run side by side for
 * datasets that spread a page over several files (v2.x has one file per episode).
 */

/** Opens one video at a time and grabs frames from it. `T` is whatever a frame is kept as. */
export interface FrameDecoder<T> {
  /** Loads `url`; resolves with the video's duration in seconds. */
  open(url: string): Promise<number>;
  /** The frame displayed at `time` seconds. */
  grab(time: number): Promise<T>;
  close(): void;
}

export interface FrameRequest {
  url: string;
  /** Seconds into the file, or `null` for the file's last frame. */
  time: number | null;
  /** With `time: null`, how far before the end to seek: half a frame lands inside the last one. */
  endOffset?: number;
}

export interface FrameHandle<T> {
  promise: Promise<T>;
  /** Gives the request up. The frame is still grabbed if someone else asked for it too. */
  cancel(): void;
}

/** A request given up before its frame was grabbed. */
export class FrameCancelled extends Error {
  constructor() {
    super("Frame request cancelled");
    this.name = "FrameCancelled";
  }
}

export interface FrameThumbnailOptions {
  /** Videos decoded at once. */
  maxDecoders: number;
  /** Frames kept, least recently used out first. */
  cacheSize: number;
  /** Close the decoders after this long without a request; `0` keeps them. */
  idleCloseMs: number;
}

type Job<T> = {
  key: string;
  time: number | null;
  endOffset: number;
  waiters: number;
  promise: Promise<T>;
  resolve: (frame: T) => void;
  reject: (error: unknown) => void;
};

type Slot<T> = {
  decoder: FrameDecoder<T>;
  url: string | null;
  duration: number;
  busy: boolean;
};

export class FrameThumbnails<T> {
  private readonly cache = new Map<string, T>();
  /** Jobs not yet grabbed, by file; a file's jobs run in the order they were asked for. */
  private readonly queues = new Map<string, Job<T>[]>();
  private readonly jobs = new Map<string, Job<T>>();
  private readonly slots: Slot<T>[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly createDecoder: () => FrameDecoder<T>,
    private readonly options: FrameThumbnailOptions,
  ) {}

  request({ url, time, endOffset = 0 }: FrameRequest): FrameHandle<T> {
    const key = `${url}#${time ?? "end"}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Refresh its place in the LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { promise: Promise.resolve(cached), cancel: () => {} };
    }

    let job = this.jobs.get(key);
    if (!job) {
      let resolve!: (frame: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A cancelled job rejects with nobody listening.
      promise.catch(() => {});
      job = { key, time, endOffset, waiters: 0, promise, resolve, reject };
      this.jobs.set(key, job);
      const queue = this.queues.get(url) ?? [];
      queue.push(job);
      this.queues.set(url, queue);
    }
    job.waiters++;
    const requested = job;

    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      requested.waiters--;
      if (requested.waiters > 0) return;
      const queue = this.queues.get(url);
      const index = queue?.indexOf(requested) ?? -1;
      // Already taken off the queue: its decoder is on it, let it finish and be cached.
      if (!queue || index < 0) return;
      queue.splice(index, 1);
      if (queue.length === 0) this.queues.delete(url);
      this.jobs.delete(key);
      requested.reject(new FrameCancelled());
    };

    this.pump();
    return { promise: job.promise, cancel };
  }

  /** Closes every decoder and drops what is queued. Cached frames are kept. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const queue of this.queues.values()) {
      for (const job of queue) {
        this.jobs.delete(job.key);
        job.reject(new FrameCancelled());
      }
    }
    this.queues.clear();
    for (const slot of this.slots) {
      // A busy decoder is closed under its feet; its job rejects and the slot is dropped.
      slot.decoder.close();
      slot.url = null;
    }
    this.slots.length = 0;
  }

  private pump(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const url of this.queues.keys()) {
      if (this.slots.some((slot) => slot.busy && slot.url === url)) continue;
      const slot = this.takeSlot(url);
      if (!slot) break;
      void this.run(slot, url);
    }
    if (this.options.idleCloseMs > 0 && !this.slots.some((s) => s.busy)) {
      this.idleTimer = setTimeout(() => this.close(), this.options.idleCloseMs);
    }
  }

  /** A free decoder for `url`: one already on that file, else a new one, else an idle one. */
  private takeSlot(url: string): Slot<T> | undefined {
    const idle = this.slots.filter((slot) => !slot.busy);
    const open = idle.find((slot) => slot.url === url);
    if (open) return open;
    if (this.slots.length < this.options.maxDecoders) {
      const slot: Slot<T> = {
        decoder: this.createDecoder(),
        url: null,
        duration: 0,
        busy: false,
      };
      this.slots.push(slot);
      return slot;
    }
    return idle[0];
  }

  private async run(slot: Slot<T>, url: string): Promise<void> {
    slot.busy = true;
    try {
      if (slot.url !== url) {
        slot.url = url;
        slot.duration = await slot.decoder.open(url);
      }
      for (;;) {
        // close() dropped this decoder: frames asked for since belong to a new one.
        if (!this.slots.includes(slot)) break;
        const job = this.queues.get(url)?.shift();
        if (!job) break;
        if (this.queues.get(url)?.length === 0) this.queues.delete(url);
        try {
          const time = job.time ?? Math.max(0, slot.duration - job.endOffset);
          const frame = await slot.decoder.grab(time);
          this.remember(job.key, frame);
          job.resolve(frame);
        } catch (error) {
          job.reject(error);
        } finally {
          this.jobs.delete(job.key);
        }
      }
    } catch (error) {
      // The file would not open: nothing queued on it can be grabbed.
      slot.url = null;
      for (const job of this.queues.get(url) ?? []) {
        this.jobs.delete(job.key);
        job.reject(error);
      }
      this.queues.delete(url);
    } finally {
      slot.busy = false;
      // close() empties the slots: a decoder closed mid-run must not schedule more work.
      if (this.slots.includes(slot)) this.pump();
    }
  }

  private remember(key: string, frame: T): void {
    this.cache.set(key, frame);
    while (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

const SEEK_TIMEOUT_MS = 20_000;

/**
 * A decoder on a hidden <video>, grabbing frames as canvases at most `maxWidth` wide. The video is
 * loaded without CORS: its frames are only ever drawn, never read back, so a tainted canvas is fine
 * and no host can refuse it.
 */
export function createVideoFrameDecoder(
  maxWidth: number,
): FrameDecoder<HTMLCanvasElement> {
  let video: HTMLVideoElement | null = null;
  /** Rejects whatever the decoder is waiting on; close() calls it. */
  let abandon: ((error: Error) => void) | null = null;

  const element = () => {
    if (video) return video;
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    // In the document but out of sight: some browsers only decode a video that is attached.
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    video.setAttribute("aria-hidden", "true");
    document.body.appendChild(video);
    return video;
  };

  /**
   * Resolves on `event`; rejects on the video's `error`, after `SEEK_TIMEOUT_MS`, or when the
   * decoder is closed. Not on `emptied`: pointing a used decoder at its next file fires that too.
   */
  const waitFor = (el: HTMLVideoElement, event: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        el.removeEventListener(event, onEvent);
        el.removeEventListener("error", onError);
        abandon = null;
        if (error) reject(error);
        else resolve();
      };
      const onEvent = () => done();
      const onError = () =>
        done(new Error(el.error?.message || "The video could not be read"));
      const timer = setTimeout(
        () => done(new Error(`Timed out waiting for the video (${event})`)),
        SEEK_TIMEOUT_MS,
      );
      el.addEventListener(event, onEvent);
      el.addEventListener("error", onError);
      abandon = done;
    });

  return {
    async open(url) {
      const el = element();
      const loaded = waitFor(el, "loadedmetadata");
      el.src = url;
      await loaded;
      return Number.isFinite(el.duration) ? el.duration : 0;
    },
    async grab(time) {
      const el = element();
      if (Math.abs(el.currentTime - time) > 1e-4 || el.readyState < 2) {
        const seeked = waitFor(el, "seeked");
        el.currentTime = time;
        await seeked;
      }
      if (el.readyState < 2) await waitFor(el, "loadeddata");
      const scale = Math.min(1, maxWidth / (el.videoWidth || maxWidth));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
      return canvas;
    },
    close() {
      abandon?.(new FrameCancelled());
      if (!video) return;
      video.removeAttribute("src");
      video.load();
      video.remove();
      video = null;
    },
  };
}

let shared: FrameThumbnails<HTMLCanvasElement> | null = null;

/** The page's one set of thumbnail decoders. */
export function frameThumbnails(): FrameThumbnails<HTMLCanvasElement> {
  shared ??= new FrameThumbnails(() => createVideoFrameDecoder(320), {
    // v2.x has a file per episode, so a page is as many files as thumbnails; six is a browser's
    // connections per host on HTTP/1.1, and still an eighth of the decoders the tab used to open.
    maxDecoders: 6,
    // Four pages of 48. A 320x240 frame is 300 KB, so about 60 MB at most.
    cacheSize: 192,
    idleCloseMs: 15_000,
  });
  return shared;
}

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnnotationsProvider } from "@/context/annotations-context";
import { TimeProvider, useTime } from "@/context/time-context";
import type { VideoInfo } from "@/types";
import type { HandTracking } from "@/lib/hand-tracking";
import { SimpleVideosPlayer } from "../simple-videos-player";

const dom = new Window({ url: "http://localhost" });
const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let container: HTMLDivElement;
let time: ReturnType<typeof useTime>;

beforeAll(() => {
  const globals = {
    window: dom,
    document: dom.document,
    HTMLVideoElement: dom.HTMLVideoElement,
    HTMLMediaElement: dom.HTMLMediaElement,
    Event: dom.Event,
    ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const videos: VideoInfo[] = [
  {
    filename: "ego",
    url: "http://localhost/ego.mp4",
    isSegmented: true,
    segmentStart: 12.5,
    segmentEnd: 22.5,
  },
  {
    filename: "other",
    url: "http://localhost/other.mp4",
    isSegmented: true,
    segmentStart: 30,
    segmentEnd: 40,
  },
];

async function mount(initialTime = 0, handTracking?: HandTracking) {
  let showPlayer: () => void;
  function Controls() {
    time = useTime();
    const { seek } = time;
    useEffect(() => seek(initialTime), [seek]);
    return null;
  }
  function DeferredPlayer() {
    const [visible, setVisible] = useState(false);
    showPlayer = () => setVisible(true);
    return visible ? (
      <SimpleVideosPlayer videosInfo={videos} handTracking={handTracking} />
    ) : null;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <TimeProvider duration={10}>
        <AnnotationsProvider>
          <Controls />
          <DeferredPlayer />
        </AnnotationsProvider>
      </TimeProvider>,
    );
  });
  // The lazy hands panel can mount after the page has already applied ?t=.
  await act(async () => showPlayer());
  return Array.from(container.querySelectorAll("video"));
}

async function ready(elements: HTMLVideoElement[]) {
  await act(async () => {
    for (const video of elements) video.dispatchEvent(new Event("loadeddata"));
  });
  await act(async () => time.setIsPlaying(false));
}

describe("hand replay video synchronization", () => {
  test("restores the URL timestamp on every camera after media loads", async () => {
    const elements = await mount(3.25);
    await ready(elements);
    expect(time.currentTime).toBe(3.25);
    expect(elements.map((video) => video.currentTime)).toEqual([15.75, 33.25]);
  });

  test("uses a seek made during loading instead of the mount timestamp", async () => {
    const elements = await mount(3);
    await act(async () => time.seek(5));
    await ready(elements);
    expect(time.currentTime).toBe(5);
    expect(elements.map((video) => video.currentTime)).toEqual([17.5, 35]);
  });

  test("paused single-frame seeks update both source videos", async () => {
    const elements = await mount(1);
    await ready(elements);
    await act(async () => time.seek(2));
    await act(async () => time.seek(2 + 1 / 30));
    expect(elements[0].currentTime).toBeCloseTo(14.5 + 1 / 30, 8);
    expect(elements[1].currentTime).toBeCloseTo(32 + 1 / 30, 8);
    expect(time.isPlaying).toBe(false);
  });

  test("labels estimated calibration beside the overlay controls", async () => {
    await mount(0, {
      frames: [],
      fps: 30,
      cameraKey: "ego",
      coordinateFrame: "segment",
      overlayIssue: null,
      calibration: {
        model: "pinhole",
        width: 640,
        height: 480,
        fx: 600,
        fy: 600,
        cx: 320,
        cy: 240,
        distortion: [],
        estimated: true,
      },
    });
    expect(container.textContent).toContain("Estimated camera calibration");
  });
});

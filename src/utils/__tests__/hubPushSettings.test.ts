import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HUB_PUSH_SETTINGS,
  readPersistedHubSettings,
  writePersistedHubSettings,
} from "@/utils/hubPushSettings";

describe("hub push settings", () => {
  test("persists the token and private flag while leaving commit name unremembered", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };

    Object.defineProperty(globalThis, "window", {
      value: { localStorage: mockStorage },
      configurable: true,
      writable: true,
    });

    const next = {
      ...DEFAULT_HUB_PUSH_SETTINGS,
      hfToken: "hf_abc123",
      privateRepo: true,
    };

    writePersistedHubSettings(next);
    const restored = readPersistedHubSettings();

    expect(restored).toEqual({
      hfToken: "hf_abc123",
      commitMessage: DEFAULT_HUB_PUSH_SETTINGS.commitMessage,
      privateRepo: true,
    });
    expect(restored.commitMessage).toBe(DEFAULT_HUB_PUSH_SETTINGS.commitMessage);
  });
});

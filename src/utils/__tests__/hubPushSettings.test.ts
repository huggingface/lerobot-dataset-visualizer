import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HUB_PUSH_SETTINGS,
  readPersistedHubSettings,
  sanitizeHfToken,
  writePersistedHubSettings,
} from "@/utils/hubPushSettings";

describe("hub push settings", () => {
  test("persists token, private flag, branch, repo ID, and PR flag while leaving commit message/description unremembered", () => {
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
      pushInPlace: true,
      targetRepoId: "user/custom-dataset",
      privateRepo: true,
      commitMessage: "Temporary commit title",
      commitDescription: "Temporary commit notes",
      branch: "experiment-v1",
      createPr: true,
    };

    writePersistedHubSettings(next);
    const restored = readPersistedHubSettings();

    expect(restored).toEqual({
      hfToken: "hf_abc123",
      pushInPlace: true,
      targetRepoId: "user/custom-dataset",
      privateRepo: true,
      commitMessage: DEFAULT_HUB_PUSH_SETTINGS.commitMessage,
      commitDescription: DEFAULT_HUB_PUSH_SETTINGS.commitDescription,
      branch: "experiment-v1",
      createPr: true,
    });
    expect(restored.commitMessage).toBe(
      DEFAULT_HUB_PUSH_SETTINGS.commitMessage,
    );
    expect(restored.commitDescription).toBe(
      DEFAULT_HUB_PUSH_SETTINGS.commitDescription,
    );
  });

  test("falls back to default settings when storage is empty or malformed", () => {
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

    expect(readPersistedHubSettings()).toEqual(DEFAULT_HUB_PUSH_SETTINGS);

    mockStorage.setItem("lerobot_hub_push_settings", "{ bad json ");
    expect(readPersistedHubSettings()).toEqual(DEFAULT_HUB_PUSH_SETTINGS);
  });

  describe("sanitizeHfToken", () => {
    test("cleans shell export declarations with double or single quotes", () => {
      expect(
        sanitizeHfToken('export HF_TOKEN="hf_testTokenDummy1234567890abcdef"'),
      ).toBe("hf_testTokenDummy1234567890abcdef");
      expect(
        sanitizeHfToken("export HF_TOKEN='hf_testTokenDummy1234567890abcdef'"),
      ).toBe("hf_testTokenDummy1234567890abcdef");
      expect(
        sanitizeHfToken('HF_TOKEN="hf_testTokenDummy1234567890abcdef";'),
      ).toBe("hf_testTokenDummy1234567890abcdef");
    });

    test("cleans wrapping quotes, whitespace, and invisible unicode characters", () => {
      expect(sanitizeHfToken('"hf_testTokenDummy1234567890abcdef"')).toBe(
        "hf_testTokenDummy1234567890abcdef",
      );
      expect(sanitizeHfToken("'hf_testTokenDummy1234567890abcdef'")).toBe(
        "hf_testTokenDummy1234567890abcdef",
      );
      expect(
        sanitizeHfToken("  \nhf_testTokenDummy1234567890abcdef\t\r\n "),
      ).toBe("hf_testTokenDummy1234567890abcdef");
      expect(
        sanitizeHfToken("hf_testTokenDummy1234567890abcdef\u200B\uFEFF"),
      ).toBe("hf_testTokenDummy1234567890abcdef");
      expect(sanitizeHfToken("hf_testTokenDummy1234567890abcdef\u00A0")).toBe(
        "hf_testTokenDummy1234567890abcdef",
      );
    });

    test("handles Bearer prefix and extracts embedded hf token", () => {
      expect(sanitizeHfToken("Bearer hf_testTokenDummy1234567890abcdef")).toBe(
        "hf_testTokenDummy1234567890abcdef",
      );
    });

    test("returns empty string for empty inputs and variable placeholders", () => {
      expect(sanitizeHfToken("")).toBe("");
      expect(sanitizeHfToken(null)).toBe("");
      expect(sanitizeHfToken(undefined)).toBe("");
      expect(sanitizeHfToken("$HF_TOKEN")).toBe("");
      expect(sanitizeHfToken("${HF_TOKEN}")).toBe("");
    });

    test("preserves non-hf custom tokens", () => {
      expect(sanitizeHfToken("api_org_sample_key_12345")).toBe(
        "api_org_sample_key_12345",
      );
    });
  });
});

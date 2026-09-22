export interface HubPushSettings {
  hfToken: string;
  commitMessage: string;
  privateRepo: boolean;
}

export const HUB_PUSH_SETTINGS_STORAGE_KEY = "lerobot_hub_push_settings";

export const DEFAULT_HUB_PUSH_SETTINGS: HubPushSettings = {
  hfToken: "",
  commitMessage: "Add language annotations",
  privateRepo: false,
};

export function readPersistedHubSettings(): HubPushSettings {
  if (typeof window === "undefined") {
    return DEFAULT_HUB_PUSH_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(HUB_PUSH_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_HUB_PUSH_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<HubPushSettings>;
    return {
      hfToken: typeof parsed.hfToken === "string" ? parsed.hfToken : "",
      commitMessage: DEFAULT_HUB_PUSH_SETTINGS.commitMessage,
      privateRepo: !!parsed.privateRepo,
    };
  } catch {
    return DEFAULT_HUB_PUSH_SETTINGS;
  }
}

export function writePersistedHubSettings(
  settings: Partial<HubPushSettings>,
): void {
  if (typeof window === "undefined") return;

  const current = readPersistedHubSettings();
  const next = {
    hfToken:
      typeof settings.hfToken === "string"
        ? settings.hfToken
        : current.hfToken,
    privateRepo:
      typeof settings.privateRepo === "boolean"
        ? settings.privateRepo
        : current.privateRepo,
  };

  window.localStorage.setItem(
    HUB_PUSH_SETTINGS_STORAGE_KEY,
    JSON.stringify(next),
  );
}

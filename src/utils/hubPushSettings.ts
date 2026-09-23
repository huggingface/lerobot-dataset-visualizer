export interface HubPushSettings {
  hfToken: string;
  pushInPlace: boolean;
  targetRepoId: string;
  privateRepo: boolean;
  commitMessage: string;
  commitDescription: string;
  branch: string;
  createPr: boolean;
}

export const HUB_PUSH_SETTINGS_STORAGE_KEY = "lerobot_hub_push_settings";

export const DEFAULT_HUB_PUSH_SETTINGS: HubPushSettings = {
  hfToken: "",
  pushInPlace: false,
  targetRepoId: "",
  privateRepo: false,
  commitMessage: "Add language annotations",
  commitDescription: "",
  branch: "main",
  createPr: false,
};

export function sanitizeHfToken(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = String(raw).trim();
  // Strip BOM, zero-width spaces, and non-breaking spaces
  t = t.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");
  // Strip bash export and env assignment prefixes: export HF_TOKEN=, HF_TOKEN=, etc.
  t = t.replace(
    /^(?:export\s+)?(?:HF_TOKEN|HUGGING_FACE_HUB_TOKEN)\s*=\s*/i,
    "",
  );
  // Strip Bearer prefix if copied from HTTP Authorization header
  t = t.replace(/^Bearer\s+/i, "");
  // Strip wrapping single or double quotes
  t = t.replace(/^["'`]+|["'`]+$/g, "");
  // Strip internal/trailing whitespace
  t = t.replace(/\s+/g, "");
  // Strip trailing punctuation/semicolon/quotes
  t = t.replace(/[;"'`]+$/g, "");

  if (t === "$HF_TOKEN" || t === "${HF_TOKEN}") {
    return "";
  }

  // If a standard Hugging Face token pattern is contained within, extract it cleanly
  const hfMatch = t.match(/(hf_[A-Za-z0-9_]+)/);
  if (hfMatch) {
    return hfMatch[1];
  }

  return t;
}

export function readPersistedHubSettings(): HubPushSettings {
  if (typeof window === "undefined") {
    return DEFAULT_HUB_PUSH_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(HUB_PUSH_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_HUB_PUSH_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<HubPushSettings>;
    return {
      hfToken:
        typeof parsed.hfToken === "string"
          ? sanitizeHfToken(parsed.hfToken)
          : "",
      pushInPlace:
        typeof parsed.pushInPlace === "boolean"
          ? parsed.pushInPlace
          : DEFAULT_HUB_PUSH_SETTINGS.pushInPlace,
      targetRepoId:
        typeof parsed.targetRepoId === "string" ? parsed.targetRepoId : "",
      privateRepo: !!parsed.privateRepo,
      commitMessage: DEFAULT_HUB_PUSH_SETTINGS.commitMessage,
      commitDescription: DEFAULT_HUB_PUSH_SETTINGS.commitDescription,
      branch:
        typeof parsed.branch === "string" && parsed.branch.trim()
          ? parsed.branch.trim()
          : DEFAULT_HUB_PUSH_SETTINGS.branch,
      createPr: !!parsed.createPr,
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
        ? sanitizeHfToken(settings.hfToken)
        : current.hfToken,
    pushInPlace:
      typeof settings.pushInPlace === "boolean"
        ? settings.pushInPlace
        : current.pushInPlace,
    targetRepoId:
      typeof settings.targetRepoId === "string"
        ? settings.targetRepoId
        : current.targetRepoId,
    privateRepo:
      typeof settings.privateRepo === "boolean"
        ? settings.privateRepo
        : current.privateRepo,
    branch:
      typeof settings.branch === "string" ? settings.branch : current.branch,
    createPr:
      typeof settings.createPr === "boolean"
        ? settings.createPr
        : current.createPr,
  };

  window.localStorage.setItem(
    HUB_PUSH_SETTINGS_STORAGE_KEY,
    JSON.stringify(next),
  );
}

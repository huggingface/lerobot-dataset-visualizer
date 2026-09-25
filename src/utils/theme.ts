"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-init";

export type Theme = "light" | "dark";

function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

export function setTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode, embedded iframe): the choice lasts for this page only.
  }
}

/** The current theme, for code that needs actual colours (Three.js) rather than CSS variables. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "dark");
}

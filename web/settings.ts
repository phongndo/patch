//! The reviewer's settings. patchr keeps them in ~/.config/patch/settings.json
//! and writes them into the page, so they hold across reviews, ports and devices
//! and the first paint already uses them.

import { createEffect, createRoot, createStore, snapshot } from "solid-js";

export interface Settings {
  colorScheme: "system" | "light" | "dark";
  /** Pierre's diff palette: "" is the default, else a variant suffix. */
  palette: "" | "soft" | "vibrant" | "protanopia-deuteranopia" | "tritanopia";
  font: "geist" | "system";
  codeFont: "geist" | "system";
  textSize: 12 | 13 | 14;
  codeSize: 12 | 13 | 14;
  sidebarSide: "left" | "right";
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** "auto" picks split on wide windows and unified on narrow ones. */
  layout: "auto" | "split" | "unified";
  wrap: boolean;
  indicators: "bars" | "classic";
  wordDiff: boolean;
  foldGenerated: boolean;
}

export const defaults: Settings = {
  colorScheme: "system",
  palette: "",
  font: "geist",
  codeFont: "geist",
  textSize: 13,
  codeSize: 13,
  sidebarSide: "left",
  sidebarOpen: true,
  sidebarWidth: 280,
  layout: "auto",
  wrap: true,
  indicators: "bars",
  wordDiff: true,
  foldGenerated: true,
};

declare global {
  interface Window {
    __PATCH_SETTINGS__?: Partial<Settings>;
  }
}

/** Keeps only known keys whose value has the default's type, so a hand-edited file cannot break the page. */
function sanitize(saved: unknown): Settings {
  const out = { ...defaults } as Record<string, unknown>;
  if (saved && typeof saved === "object")
    for (const [key, value] of Object.entries(saved))
      if (key in defaults && typeof value === typeof (defaults as unknown as Record<string, unknown>)[key])
        out[key] = value;
  return out as unknown as Settings;
}

const fonts = {
  geist: '"Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif',
  system: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};
const codeFonts = {
  geist: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  system: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
};

function createSettings() {
  const [settings, setSettings] = createStore<Settings>(sanitize(window.__PATCH_SETTINGS__));
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Appearance applies to the document at once; Pierre reads the variables through its shadow roots.
  createEffect(
    () => ({ ...settings }),
    (current) => {
      const root = document.documentElement;
      if (current.colorScheme === "system") delete root.dataset.theme;
      else root.dataset.theme = current.colorScheme;
      root.style.setProperty("--font", fonts[current.font]);
      root.style.setProperty("--mono", codeFonts[current.codeFont]);
      root.style.setProperty("--text", `${current.textSize}px`);
      root.style.setProperty("--text-meta", `${current.textSize - 1}px`);
      root.style.setProperty("--diffs-font-size", `${current.codeSize}px`);
      root.style.setProperty("--sidebar", `${current.sidebarWidth}px`);
    },
  );

  function update(patch: Partial<Settings>) {
    setSettings((s) => {
      Object.assign(s, patch);
    });
    clearTimeout(timer);
    timer = setTimeout(() => {
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot(settings)),
      });
    }, 300);
  }

  return { settings, update, reset: () => update({ ...defaults }) };
}

export const preferences = createRoot(createSettings);

/** Pierre theme names for the chosen palette. */
export const diffTheme = (palette: Settings["palette"]) => ({
  dark: palette ? `pierre-dark-${palette}` : "pierre-dark",
  light: palette ? `pierre-light-${palette}` : "pierre-light",
});

//! The reviewer's settings. patchr keeps them in ~/.config/patch/settings.json
//! and writes them into the page, so they hold across reviews, ports and devices
//! and the first paint already uses them.

import { createEffect, createMemo, createRoot, createSignal, createStore, snapshot } from "solid-js";
import { formatForDisplay, type Hotkey } from "@tanstack/hotkeys";
import { definitionOf, type Action } from "./commands.ts";
import type { Theme } from "./themes.gen.ts";
import { defaultDark, defaultLight } from "./themes.defaults.gen.ts";

export const fontPresets = {
  ui: [
    { label: "Geist", value: '"Geist", ui-sans-serif, sans-serif' },
    { label: "System", value: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    { label: "Inter", value: '"Inter", "Inter Variable", ui-sans-serif, sans-serif' },
    { label: "Helvetica", value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  ],
  code: [
    { label: "Geist Mono", value: '"Geist Mono", ui-monospace, monospace' },
    { label: "System", value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
    { label: "JetBrains Mono", value: '"JetBrains Mono", ui-monospace, monospace' },
    { label: "Fira Code", value: '"Fira Code", ui-monospace, monospace' },
    { label: "Berkeley Mono", value: '"Berkeley Mono", ui-monospace, monospace' },
    { label: "Cascadia Code", value: '"Cascadia Code", ui-monospace, monospace' },
  ],
} as const;

export interface Settings {
  colorScheme: "system" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
  /** The chosen themes' colors, kept so the page paints without loading the theme catalog. */
  lightColors: Theme["colors"];
  darkColors: Theme["colors"];
  /** A CSS font-family list: a preset's value, or whatever the reviewer typed. */
  uiFont: string;
  codeFont: string;
  textSize: number;
  codeSize: number;
  uiWeight: number;
  codeWeight: number;
  /** Code line height in pixels. */
  lineHeight: number;
  ligatures: boolean;
  sidebarSide: "left" | "right";
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** "auto" picks split on wide windows and unified on narrow ones. */
  layout: "auto" | "split" | "unified";
  wrap: boolean;
  indicators: "bars" | "classic";
  /** How strongly changed lines and words are tinted. */
  contrast: "low" | "medium" | "high";
  wordDiff: boolean;
  foldGenerated: boolean;
  /** Bindings that differ from the defaults; an empty one has no key. */
  keys: Partial<Record<Action, string>>;
}

export const defaults: Settings = {
  colorScheme: "system",
  lightTheme: defaultLight.id,
  darkTheme: defaultDark.id,
  lightColors: defaultLight.colors,
  darkColors: defaultDark.colors,
  uiFont: fontPresets.ui[0].value,
  codeFont: fontPresets.code[0].value,
  textSize: 13,
  codeSize: 13,
  uiWeight: 400,
  codeWeight: 400,
  lineHeight: 20,
  ligatures: true,
  sidebarSide: "left",
  sidebarOpen: true,
  sidebarWidth: 280,
  layout: "auto",
  wrap: true,
  indicators: "bars",
  contrast: "medium",
  wordDiff: true,
  foldGenerated: true,
  keys: {},
};

declare global {
  interface Window {
    __PATCH_SETTINGS__?: Record<string, unknown>;
  }
}

/** What each number may be, and how far one press moves it. */
export const ranges = {
  textSize: { min: 11, max: 17, step: 1 },
  codeSize: { min: 10, max: 20, step: 1 },
  lineHeight: { min: 14, max: 32, step: 1 },
  uiWeight: { min: 100, max: 900, step: 100 },
  codeWeight: { min: 100, max: 900, step: 100 },
} as const;
export type Numeric = keyof typeof ranges;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/** Keeps only known keys with the default's type, so a hand-edited file cannot break the page. */
function sanitize(saved: unknown): Settings {
  const out = structuredClone(defaults) as unknown as Record<string, unknown>;
  if (saved && typeof saved === "object")
    for (const [key, value] of Object.entries(saved))
      if (key in defaults && typeof value === typeof (defaults as unknown as Record<string, unknown>)[key])
        out[key] = value;
  const settings = out as unknown as Settings;
  for (const name of Object.keys(ranges) as Numeric[]) {
    const { min, max, step } = ranges[name];
    settings[name] = clamp(Math.round(settings[name] / step) * step, min, max);
  }
  if (!["low", "medium", "high"].includes(settings.contrast)) settings.contrast = defaults.contrast;
  return settings;
}

/** A theme's color, hex or Display P3; anything else in a hand-edited file is dropped. */
const color = (value: string | null | undefined) =>
  value && /^(#[0-9a-f]{3,8}|color\(display-p3( [\d.]+){3}( \/ [\d.]+)?\))$/i.test(value) ? value : undefined;

/** Paints Patch's own chrome from a theme: its surfaces, text and change colors, mixed for the rest. */
function paint(root: HTMLElement, c: Theme["colors"], isDark: boolean) {
  const theme = { dark: isDark };
  const editor = color(c.editor) ?? (theme.dark ? "#0e0e10" : "#ffffff");
  const chrome = color(c.chrome) ?? editor;
  const text = color(c.text) ?? (theme.dark ? "#ececef" : "#18181b");
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set("--bg", editor);
  set("--panel", chrome);
  // Behind the file cards: lifted from the chrome so the cards stand apart.
  set("--page", `color-mix(in srgb, ${text} ${theme.dark ? 4 : 3}%, ${chrome})`);
  set("--fg", text);
  set("--muted", `color-mix(in srgb, ${text} 58%, ${chrome})`);
  set("--line", `color-mix(in srgb, ${text} 12%, ${chrome})`);
  set("--line-strong", `color-mix(in srgb, ${text} 20%, ${chrome})`);
  set("--hover", `color-mix(in srgb, ${text} 8%, ${chrome})`);
  set("--note", `color-mix(in srgb, ${text} 4%, ${chrome})`);
  set("--accent", text);
  set("--accent-fg", chrome);
  set("--add", color(c.add) ?? (theme.dark ? "#4ade80" : "#16a34a"));
  set("--del", color(c.del) ?? (theme.dark ? "#f87171" : "#dc2626"));
  set("--info", color(c.accent) ?? "#3b9ee0");
  root.style.colorScheme = theme.dark ? "dark" : "light";
}

// Percent of the change color mixed into a changed line and into its line
// number, and the alpha of a changed word's highlight, per contrast level.
// "low" is Pierre's own look.
const tints = {
  dark: { low: [20, 15, 0.2], medium: [28, 40, 0.34], high: [38, 55, 0.48] },
  light: { low: [12, 9, 0.15], medium: [18, 28, 0.26], high: [26, 40, 0.38] },
} as const;

/**
 * Sets how strongly changes are tinted. The diff's own CSS (diff.ts) reads the
 * mix variables, which inherit into its shadow roots; a changed word's
 * highlight is a final color, so Pierre's override is set directly.
 */
function tint(root: HTMLElement, contrast: Settings["contrast"], isDark: boolean) {
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  for (const mode of ["dark", "light"] as const) {
    const [line, number] = tints[mode][contrast];
    set(`--patch-line-${mode}`, `${100 - line}%`);
    set(`--patch-number-${mode}`, `${100 - number}%`);
  }
  const word = tints[isDark ? "dark" : "light"][contrast][2];
  for (const [kind, color] of [
    ["addition", "var(--add)"],
    ["deletion", "var(--del)"],
  ] as const)
    set(
      `--diffs-bg-${kind}-emphasis-override`,
      `color-mix(in srgb, ${color} ${Math.round(word * 100)}%, transparent)`,
    );
}

export const displayKey = (key: string) => {
  if (!key) return "";
  try {
    return formatForDisplay(key as Hotkey);
  } catch {
    return key;
  }
};

function createSettings() {
  const [settings, setSettings] = createStore<Settings>(sanitize(window.__PATCH_SETTINGS__));
  const media = matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(media.matches);
  media.addEventListener("change", (event) => setSystemDark(event.matches));
  let timer: ReturnType<typeof setTimeout> | undefined;

  const dark = createMemo(() =>
    settings.colorScheme === "system" ? systemDark() : settings.colorScheme === "dark",
  );
  const colors = createMemo(() => (dark() ? settings.darkColors : settings.lightColors));

  createEffect(
    () => ({ ...settings, colors: colors(), isDark: dark() }),
    (current) => {
      const root = document.documentElement;
      paint(root, current.colors, current.isDark);
      tint(root, current.contrast, current.isDark);
      const set = (name: string, value: string) => root.style.setProperty(name, value);
      set("--font", current.uiFont);
      set("--mono", current.codeFont);
      set("--text", `${current.textSize}px`);
      set("--text-meta", `${current.textSize - 1}px`);
      set("--diffs-font-size", `${current.codeSize}px`);
      set("--diffs-line-height", `${current.lineHeight}px`);
      set("--ui-weight", String(current.uiWeight));
      set("--code-weight", String(current.codeWeight));
      set("--diffs-font-features", current.ligatures ? "normal" : '"liga" 0, "calt" 0');
      set("--sidebar", `${current.sidebarWidth}px`);
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

  /** The action's key, or an empty string when it has none. */
  const keyFor = (action: Action): string => settings.keys[action] ?? definitionOf(action).key ?? "";
  /** The action's key as this platform writes it. */
  const keyText = (action: Action) => displayKey(keyFor(action));
  /** A button's tooltip with the action's current shortcut, as in "Refresh (⌘R)". */
  const hint = (text: string, action: Action) => (keyText(action) ? `${text} (${keyText(action)})` : text);

  const step = (name: Numeric, direction: 1 | -1) => {
    const { min, max, step: by } = ranges[name];
    update({ [name]: clamp(settings[name] + direction * by, min, max) });
  };

  function bind(action: Action, key: string | undefined) {
    const keys = { ...snapshot(settings).keys };
    if (key === undefined || key === (definitionOf(action).key ?? "")) delete keys[action];
    else keys[action] = key;
    update({ keys });
  }

  /** Picks a theme for one mode, keeping its colors for the next first paint. */
  const chooseTheme = (theme: Theme) =>
    update(
      theme.dark
        ? { darkTheme: theme.id, darkColors: theme.colors }
        : { lightTheme: theme.id, lightColors: theme.colors },
    );

  return {
    settings,
    update,
    reset: () => update(structuredClone(defaults)),
    dark,
    keyFor,
    keyText,
    hint,
    step,
    bind,
    chooseTheme,
  };
}

export const preferences = createRoot(createSettings);

// Settings saved before themes carried their colors, or naming a theme that is
// gone, are repaired from the catalog; it loads only in that case.
{
  const saved = window.__PATCH_SETTINGS__ ?? {};
  const s = preferences.settings;
  const stale =
    (s.lightTheme !== defaults.lightTheme && !saved.lightColors) ||
    (s.darkTheme !== defaults.darkTheme && !saved.darkColors);
  if (stale)
    void import("./themes.gen.ts").then(({ themes }) => {
      const find = (id: string) => themes.find((theme) => theme.id === id);
      const light = find(s.lightTheme) ?? defaultLight;
      const dark = find(s.darkTheme) ?? defaultDark;
      preferences.update({
        lightTheme: light.id,
        lightColors: light.colors,
        darkTheme: dark.id,
        darkColors: dark.colors,
      });
    });
}

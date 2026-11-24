//! The reviewer's settings. patchr keeps them in ~/.config/patch/settings.json
//! and writes them into the page, so they hold across reviews, ports and devices
//! and the first paint already uses them.

import { createEffect, createMemo, createRoot, createSignal, createStore, snapshot } from "solid-js";
import { themes, type Theme } from "./themes.gen.ts";

/** Every rebindable action, in the order Settings lists them. */
export const actions = {
  nextFile: { label: "Next file", key: "J" },
  previousFile: { label: "Previous file", key: "K" },
  comment: { label: "Comment on the selected lines", key: "C" },
  viewed: { label: "Mark the file viewed", key: "V" },
  layout: { label: "Split or unified", key: "S" },
  sidebar: { label: "Show or hide the sidebar", key: "B" },
  refresh: { label: "Refresh the diff", key: "R" },
  search: { label: "Search files and comments", key: "/" },
  finish: { label: "Finish, then send", key: "Mod+Enter" },
  settings: { label: "Open Settings", key: "Mod+," },
} as const;
export type Action = keyof typeof actions;

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
  /** A CSS font-family list: a preset's value, or whatever the reviewer typed. */
  uiFont: string;
  codeFont: string;
  textSize: number;
  codeSize: number;
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
  wordDiff: boolean;
  foldGenerated: boolean;
  /** Bindings that differ from the defaults. */
  keys: Partial<Record<Action, string>>;
}

export const defaults: Settings = {
  colorScheme: "system",
  lightTheme: "pierre-light",
  darkTheme: "pierre-dark",
  uiFont: fontPresets.ui[0].value,
  codeFont: fontPresets.code[0].value,
  textSize: 13,
  codeSize: 13,
  lineHeight: 20,
  ligatures: true,
  sidebarSide: "left",
  sidebarOpen: true,
  sidebarWidth: 280,
  layout: "auto",
  wrap: true,
  indicators: "bars",
  wordDiff: true,
  foldGenerated: true,
  keys: {},
};

declare global {
  interface Window {
    __PATCH_SETTINGS__?: Record<string, unknown>;
  }
}

const themeById = new Map(themes.map((theme) => [theme.id, theme]));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/** Keeps only known keys with the default's type, so a hand-edited file cannot break the page. */
function sanitize(saved: unknown): Settings {
  const out = structuredClone(defaults) as unknown as Record<string, unknown>;
  if (saved && typeof saved === "object")
    for (const [key, value] of Object.entries(saved))
      if (key in defaults && typeof value === typeof (defaults as unknown as Record<string, unknown>)[key])
        out[key] = value;
  const settings = out as unknown as Settings;
  if (!themeById.get(settings.lightTheme)) settings.lightTheme = defaults.lightTheme;
  if (!themeById.get(settings.darkTheme)) settings.darkTheme = defaults.darkTheme;
  settings.textSize = clamp(settings.textSize, 11, 17);
  settings.codeSize = clamp(settings.codeSize, 10, 20);
  settings.lineHeight = clamp(settings.lineHeight, 14, 32);
  return settings;
}

const hex = (value: string | null | undefined) =>
  value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;

/** Paints Patch's own chrome from a theme: its surfaces, text and change colors, mixed for the rest. */
function paint(root: HTMLElement, theme: Theme) {
  const c = theme.colors;
  const editor = hex(c.editor) ?? (theme.dark ? "#0e0e10" : "#ffffff");
  const chrome = hex(c.chrome) ?? editor;
  const text = hex(c.text) ?? (theme.dark ? "#ececef" : "#18181b");
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set("--bg", editor);
  set("--panel", chrome);
  set("--fg", text);
  set("--muted", `color-mix(in srgb, ${text} 58%, ${chrome})`);
  set("--line", `color-mix(in srgb, ${text} 12%, ${chrome})`);
  set("--line-strong", `color-mix(in srgb, ${text} 20%, ${chrome})`);
  set("--hover", hex(c.line) ?? `color-mix(in srgb, ${text} 8%, ${chrome})`);
  set("--note", `color-mix(in srgb, ${text} 4%, ${chrome})`);
  set("--accent", text);
  set("--accent-fg", chrome);
  set("--add", hex(c.add) ?? (theme.dark ? "#4ade80" : "#16a34a"));
  set("--del", hex(c.del) ?? (theme.dark ? "#f87171" : "#dc2626"));
  set("--info", hex(c.accent) ?? "#3b9ee0");
  root.style.colorScheme = theme.dark ? "dark" : "light";
}

function createSettings() {
  const [settings, setSettings] = createStore<Settings>(sanitize(window.__PATCH_SETTINGS__));
  const media = matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(media.matches);
  media.addEventListener("change", (event) => setSystemDark(event.matches));
  let timer: ReturnType<typeof setTimeout> | undefined;

  const dark = createMemo(() =>
    settings.colorScheme === "system" ? systemDark() : settings.colorScheme === "dark",
  );
  const theme = createMemo(() => themeById.get(dark() ? settings.darkTheme : settings.lightTheme)!);

  createEffect(
    () => ({ ...settings, theme: theme() }),
    (current) => {
      const root = document.documentElement;
      paint(root, current.theme);
      const set = (name: string, value: string) => root.style.setProperty(name, value);
      set("--font", current.uiFont);
      set("--mono", current.codeFont);
      set("--text", `${current.textSize}px`);
      set("--text-meta", `${current.textSize - 1}px`);
      set("--diffs-font-size", `${current.codeSize}px`);
      set("--diffs-line-height", `${current.lineHeight}px`);
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

  const keyFor = (action: Action): string => settings.keys[action] ?? actions[action].key;

  function bind(action: Action, key: string | undefined) {
    const keys = { ...snapshot(settings).keys };
    if (key === undefined || key === actions[action].key) delete keys[action];
    else keys[action] = key;
    update({ keys });
  }

  return { settings, update, reset: () => update(structuredClone(defaults)), dark, theme, keyFor, bind };
}

export const preferences = createRoot(createSettings);

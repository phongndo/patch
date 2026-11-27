//! What is open on the page. Commands open these from anywhere, so they live
//! outside the components that show them.

import { createRoot, createSignal } from "solid-js";
import type { Forge } from "../src/protocol.ts";
import type { Action } from "./commands.ts";
import type { IconName } from "./icons.gen.ts";
import { preferences } from "./settings.ts";

/**
 * A touch screen, or a window too narrow for two columns, keeps its own view of which panels are
 * open, and a touch screen its own layout: they start from the settings and are never written
 * back, since every device of the reviewer reads the same settings.
 */
const narrowQuery = matchMedia("(max-width: 860px)");
const touchQuery = matchMedia("(hover: none)");
const wideQuery = matchMedia("(min-width: 1200px)");
export const [narrow, setNarrow] = createSignal(narrowQuery.matches);
export const [touchOnly, setTouchOnly] = createSignal(touchQuery.matches);
const [wide, setWide] = createSignal(wideQuery.matches);
narrowQuery.addEventListener("change", (event) => setNarrow(event.matches));
touchQuery.addEventListener("change", (event) => setTouchOnly(event.matches));
wideQuery.addEventListener("change", (event) => setWide(event.matches));
export const keepsOwnView = () => narrow() || touchOnly();

type Layout = "split" | "unified";
/** A touch screen's layout; "auto" follows the window, as the setting's Automatic does. */
export const [ownLayoutChoice, setOwnLayout] = createSignal<"auto" | Layout>("auto");
export const ownLayout = (): Layout => {
  const choice = ownLayoutChoice();
  if (choice !== "auto") return choice;
  return wide() ? "split" : "unified";
};
// On a narrow window the files and the comments are drawers over the diff, closed until asked for.
export const [ownFiles, setOwnFiles] = createRoot(() =>
  createSignal(() => !narrow() && preferences.settings.sidebarOpen),
);
export const [ownComments, setOwnComments] = createRoot(() =>
  createSignal(() => !narrow() && preferences.settings.commentsOpen),
);

export const [scopeOpen, setScopeOpen] = createSignal(false);
/** The tab the scope picker opens on, when a command asks for one. */
export type ScopeTab = "changes" | "commits" | "prs";
export const [scopeTab, setScopeTab] = createSignal<ScopeTab>();
export const [filterOpen, setFilterOpen] = createSignal(false);

/** Where the repository's pull requests are, once the server has said. */
export const [forge, setForge] = createSignal<Forge>();
/** What the forge calls its pull requests, and how it numbers them. */
export const requests = (): { one: string; many: string; mark: string; icon: IconName } =>
  forge() === "gitlab"
    ? { one: "merge request", many: "merge requests", mark: "!", icon: "merged" }
    : { one: "pull request", many: "pull requests", mark: "#", icon: "brandGithub" };

export type SettingsPage = "general" | "themes" | "typography" | "shortcuts";
export const [settingsOpen, setSettingsOpen] = createSignal(false);
export const [settingsPage, setSettingsPage] = createSignal<SettingsPage>("general");

/** The palette's open pages, the last one on screen; empty shows every command, undefined is closed. */
export const [palette, setPalette] = createSignal<Action[]>();

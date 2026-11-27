//! What is open on the page. Commands open these from anywhere, so they live
//! outside the components that show them.

import { createSignal } from "solid-js";
import type { Forge } from "../src/protocol.ts";
import type { Action } from "./commands.ts";
import type { IconName } from "./icons.gen.ts";

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

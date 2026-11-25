//! Every command Patch has, with its default key. This one table is what the
//! command palette lists, Settings rebinds and the page registers, so nothing
//! can be done with a button that the palette and the keyboard cannot reach.
//! The ids are how custom keys are saved.

import { detectPlatform } from "@tanstack/hotkeys";
import type { IconName } from "./icons.gen.ts";

// Motions: on a Mac they are on Control, which neither the browser nor ⌘ uses. Elsewhere
// Control is the browser's, so they are on Alt.
const motion = detectPlatform() === "mac" ? "Control" : "Alt";

interface Definition {
  label: string;
  group: string;
  icon: IconName;
  /** The default key: a chord for what a hand on the mouse reaches for. The rest have none until bound. */
  key?: string;
  /** More words the palette finds it by. */
  words?: string;
}

export const actions = {
  palette: { label: "Command palette", key: "Mod+K", group: "App", icon: "command", words: "actions" },
  finish: {
    label: "Finish the review",
    key: "Mod+Enter",
    group: "Review",
    icon: "check",
    words: "send submit feedback approve lgtm",
  },
  copyFeedback: { label: "Copy feedback", group: "Review", icon: "fileText", words: "markdown" },
  viewed: {
    label: "Mark the file viewed",
    key: "Mod+Shift+V",
    group: "Review",
    icon: "checkCircle",
    words: "done",
  },
  refresh: { label: "Refresh the diff", key: "Mod+R", group: "Review", icon: "refresh", words: "reload" },

  comment: { label: "Comment on the selected lines", key: "Mod+/", group: "Comments", icon: "comment" },
  fileComment: { label: "Comment on the file", group: "Comments", icon: "comment", words: "whole" },
  globalComment: {
    label: "Global comment",
    group: "Comments",
    icon: "plus",
    words: "overall general whole change note add",
  },
  nextComment: { label: "Next comment", key: `${motion}+N`, group: "Comments", icon: "comment" },
  previousComment: { label: "Previous comment", key: `${motion}+P`, group: "Comments", icon: "comment" },
  goToComment: { label: "Go to comment…", group: "Comments", icon: "comment", words: "jump open" },
  editComment: { label: "Edit comment…", group: "Comments", icon: "pencil", words: "change" },
  deleteComment: { label: "Delete comment…", group: "Comments", icon: "trash", words: "remove" },
  clearSelection: { label: "Clear the line selection", group: "Comments", icon: "x", words: "deselect" },

  nextChange: {
    label: "Next change",
    key: `${motion}+J`,
    group: "Navigation",
    icon: "diffUnified",
    words: "hunk",
  },
  previousChange: {
    label: "Previous change",
    key: `${motion}+K`,
    group: "Navigation",
    icon: "diffUnified",
    words: "hunk",
  },
  nextFile: { label: "Next file", key: "Alt+ArrowDown", group: "Navigation", icon: "fileText" },
  previousFile: { label: "Previous file", key: "Alt+ArrowUp", group: "Navigation", icon: "fileText" },
  nextUnviewed: {
    label: "Next file not viewed",
    group: "Navigation",
    icon: "fileText",
    words: "unviewed",
  },
  goToFile: { label: "Go to file…", key: "Mod+P", group: "Navigation", icon: "fileTree", words: "open jump" },
  search: {
    label: "Search the sidebar",
    key: "Mod+Shift+F",
    group: "Navigation",
    icon: "search",
    words: "files comments filter",
  },
  find: { label: "Find in the diff", key: "Mod+F", group: "Navigation", icon: "search", words: "text" },

  scope: {
    label: "Choose what to review",
    key: "Mod+O",
    group: "Scope",
    icon: "branch",
    words: "picker open",
  },
  reviewBranch: { label: "Review the branch", group: "Scope", icon: "branch", words: "all changes" },
  reviewUncommitted: {
    label: "Review uncommitted changes",
    group: "Scope",
    icon: "pencil",
    words: "working tree",
  },
  reviewStaged: { label: "Review staged changes", group: "Scope", icon: "plus", words: "index" },
  chooseBase: { label: "Compare against a branch…", group: "Scope", icon: "branch", words: "base" },
  chooseCommit: { label: "Review a commit…", group: "Scope", icon: "commit", words: "sha history" },
  choosePull: { label: "Review a pull request…", group: "Scope", icon: "brandGithub", words: "pr github" },

  foldFile: {
    label: "Collapse or expand the file",
    group: "View",
    icon: "chevronSm",
    words: "fold",
  },
  foldAll: {
    label: "Collapse or expand every file",
    key: "Mod+Shift+ArrowUp",
    group: "View",
    icon: "chevronsClose",
    words: "fold",
  },
  layout: {
    label: "Split or unified",
    key: "Mod+\\",
    group: "View",
    icon: "diffSplit",
    words: "side by side",
  },
  layoutAuto: { label: "Layout: automatic", group: "View", icon: "diffSplit" },
  wrap: { label: "Wrap long lines", group: "View", icon: "fileText" },
  wordDiff: { label: "Highlight changed words", group: "View", icon: "type", words: "intraline" },
  indicators: { label: "Change markers: bars or + and −", group: "View", icon: "plus", words: "signs" },
  contrast: { label: "Change contrast…", group: "View", icon: "brush", words: "tint strength" },
  foldGenerated: { label: "Fold generated files", group: "View", icon: "gear", words: "lockfiles" },
  sidebar: { label: "Show or hide the sidebar", key: "Mod+B", group: "View", icon: "sidebarLeft" },
  sidebarSide: { label: "Move the sidebar to the other side", group: "View", icon: "sidebarLeft" },
  sidebarWidth: { label: "Reset the sidebar's width", group: "View", icon: "sidebarLeft" },
  showFiles: { label: "Show files in the sidebar", group: "View", icon: "fileTree" },
  showComments: { label: "Show comments in the sidebar", group: "View", icon: "comment" },
  filterFiles: { label: "Filter files…", group: "View", icon: "filter", words: "kind status tests docs" },
  clearFilter: { label: "Clear the file filter", group: "View", icon: "filter", words: "show all" },

  appearance: { label: "Appearance…", group: "Appearance", icon: "brush", words: "dark light system mode" },
  lightTheme: { label: "Light theme…", group: "Appearance", icon: "brush", words: "color scheme" },
  darkTheme: { label: "Dark theme…", group: "Appearance", icon: "brush", words: "color scheme" },
  codeFont: { label: "Code font…", group: "Appearance", icon: "type", words: "typography mono" },
  uiFont: { label: "Interface font…", group: "Appearance", icon: "type", words: "typography" },
  codeBigger: { label: "Code size: bigger", group: "Appearance", icon: "type", words: "font zoom increase" },
  codeSmaller: {
    label: "Code size: smaller",
    group: "Appearance",
    icon: "type",
    words: "font zoom decrease",
  },
  linesTaller: { label: "Line height: taller", group: "Appearance", icon: "diffUnified", words: "spacing" },
  linesShorter: { label: "Line height: shorter", group: "Appearance", icon: "diffUnified", words: "spacing" },
  codeBolder: { label: "Code weight: bolder", group: "Appearance", icon: "textBold", words: "font" },
  codeLighter: { label: "Code weight: lighter", group: "Appearance", icon: "textBold", words: "font" },
  textBigger: { label: "Interface size: bigger", group: "Appearance", icon: "type", words: "font" },
  textSmaller: { label: "Interface size: smaller", group: "Appearance", icon: "type", words: "font" },
  textBolder: { label: "Interface weight: bolder", group: "Appearance", icon: "textBold", words: "font" },
  textLighter: { label: "Interface weight: lighter", group: "Appearance", icon: "textBold", words: "font" },
  ligatures: { label: "Ligatures", group: "Appearance", icon: "code", words: "font" },

  settings: { label: "Settings", key: "Mod+,", group: "App", icon: "gear", words: "preferences options" },
  shortcuts: {
    label: "Keyboard shortcuts",
    group: "App",
    icon: "key",
    words: "help keys bindings",
  },
  settingsThemes: { label: "Settings: themes", group: "App", icon: "brush" },
  settingsTypography: { label: "Settings: typography", group: "App", icon: "type", words: "fonts" },
  restoreDefaults: { label: "Restore default settings…", group: "App", icon: "refresh", words: "reset" },
} as const satisfies Record<string, Definition>;

export type Action = keyof typeof actions;
/** Commands whose keys also work while typing. The others leave their keys to the field, like ⌘⇧V and ⌘⇧↑. */
export const whileTyping: ReadonlySet<Action> = new Set<Action>([
  "palette",
  "scope",
  "goToFile",
  "find",
  "search",
  "refresh",
  "sidebar",
  "settings",
]);
export const actionNames = Object.keys(actions) as Action[];
export const definitionOf = (action: Action): Definition => actions[action];

/** The order the palette and Settings list the groups in. */
export const actionGroups = [
  "Navigation",
  "Comments",
  "Review",
  "Scope",
  "View",
  "Appearance",
  "App",
] as const;

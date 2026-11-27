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
    label: "Filter files by name…",
    key: "Mod+Shift+E",
    group: "Navigation",
    icon: "filter",
    words: "sidebar search names #",
  },
  clearSearch: {
    label: "Clear the file search",
    key: "Mod+Shift+X",
    group: "Navigation",
    icon: "x",
    words: "filter names reset sidebar",
  },
  grep: {
    label: "Search file contents…",
    key: "Mod+Shift+F",
    group: "Navigation",
    icon: "search",
    words: "grep code text find all files /",
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
    words: "working tree working copy jj",
  },
  reviewStaged: { label: "Review staged changes", group: "Scope", icon: "plus", words: "index" },
  chooseBase: { label: "Compare against a branch…", group: "Scope", icon: "branch", words: "base" },
  chooseCommit: { label: "Review a commit…", group: "Scope", icon: "commit", words: "sha history" },
  choosePull: {
    label: "Review a pull request…",
    group: "Scope",
    icon: "brandGithub",
    words: "pr github merge request mr gitlab",
  },

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
  // Alt+Z, as in VS Code; Control on a Mac, like the motions, since Option types a character there.
  wrap: { label: "Wrap long lines", key: `${motion}+Z`, group: "View", icon: "fileText", words: "word wrap" },
  wordDiff: { label: "Highlight changed words", group: "View", icon: "type", words: "intraline" },
  indicators: { label: "Change markers: bars or + and −", group: "View", icon: "plus", words: "signs" },
  contrast: { label: "Change contrast…", group: "View", icon: "brush", words: "tint strength" },
  foldGenerated: { label: "Fold generated files", group: "View", icon: "gear", words: "lockfiles" },
  preview: {
    label: "Preview the file or show its code",
    group: "View",
    icon: "eye",
    words: "render svg markdown image raw code toggle",
  },
  previewSvg: { label: "Open SVG as a preview", group: "View", icon: "eye", words: "render image default" },
  previewMarkdown: {
    label: "Open Markdown as a preview",
    group: "View",
    icon: "eye",
    words: "render md docs default",
  },
  wholeFiles: {
    label: "Show whole files",
    group: "View",
    icon: "chevrons",
    words: "expand unfold full context unchanged lines everything",
  },
  groupByKind: {
    label: "Group files by kind",
    group: "View",
    icon: "fileTree",
    words: "sections code tests docs generated",
  },
  sidebar: {
    label: "Show or hide the files",
    key: "Mod+B",
    group: "View",
    icon: "sidebarLeft",
    words: "sidebar tree",
  },
  sidebarSide: {
    label: "Swap the files and comments",
    group: "View",
    icon: "sidebarLeft",
    words: "sidebar side left right",
  },
  sidebarWidth: { label: "Reset the panels' widths", group: "View", icon: "sidebarLeft", words: "sidebar" },
  showFiles: { label: "Show the files", group: "View", icon: "fileTree", words: "sidebar tree" },
  showComments: { label: "Show or hide the comments", group: "View", icon: "comment", words: "panel" },
  showUnchanged: {
    label: "Explore the repository",
    group: "View",
    icon: "folder",
    words: "unchanged all files browse tree",
  },
  backToReview: {
    label: "Back to the review",
    group: "Navigation",
    icon: "diffUnified",
    words: "close file browse",
  },
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
  "grep",
  "clearSearch",
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

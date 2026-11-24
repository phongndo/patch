//! Page shortcuts through TanStack Hotkeys' core, bound to the reviewer's keys
//! from Settings and re-bound whenever those change.

import {
  getHotkeyManager,
  matchesKeyboardEvent,
  validateHotkey,
  type RegisterableHotkey,
} from "@tanstack/hotkeys";
import { createEffect } from "solid-js";
import { actionNames, definitionOf, whileTyping, type Action } from "./commands.ts";
import { preferences } from "./settings.ts";

export interface Handler {
  run: () => void;
  /** Whether its key works now; by default, while nothing covers the page. */
  enabled?: () => boolean;
}

const bound = (action: Action) => {
  const key = preferences.keyFor(action);
  // A hand-edited settings file may hold anything.
  return key && validateHotkey(key).valid ? key : undefined;
};
/** Commands that go on while their key is held; the others run once a press. */
const repeats = (action: Action) =>
  /^(next|previous)|(Bigger|Smaller|Taller|Shorter|Bolder|Lighter)$/.test(action);
const isChord = (key: string) => /Mod|Control|Meta/.test(key);
const isModified = (key: string) => isChord(key) || key.includes("Alt+");

/** Whether a key goes to text being written; a list, a tree or a checkbox that has focus after a click is not that. */
function isTyping(event: KeyboardEvent) {
  const target = event.composedPath()[0];
  if (target instanceof HTMLInputElement)
    return !["checkbox", "radio", "button", "range"].includes(target.type);
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** Whether a command's key works even while typing. */
const always = (action: Action, key: string) => whileTyping.has(action) && isChord(key);

/** Whether a key press in a text field is a page shortcut and not typing. */
export const isPageShortcut = (event: KeyboardEvent) =>
  event.key !== "Enter" &&
  event.key !== "Escape" &&
  [...whileTyping].some((action) => {
    const key = bound(action);
    return (
      key !== undefined && isChord(key) && matchesKeyboardEvent(event, key as RegisterableHotkey as never)
    );
  });

export function bindActions(handlers: Record<Action, Handler>, idle: () => boolean) {
  createEffect(
    () =>
      actionNames.map((action) => ({
        action,
        key: bound(action),
        enabled: handlers[action].enabled?.() ?? idle(),
      })),
    (bindings) => {
      const manager = getHotkeyManager();
      const handles = bindings.flatMap(({ action, key, enabled }) => {
        if (key === undefined) return [];
        const anywhere = always(action, key);
        const chord = isModified(key) && !anywhere;
        return manager.register(
          key as RegisterableHotkey,
          (event) => {
            if (chord) {
              if (isTyping(event)) return;
              event.preventDefault();
              event.stopPropagation();
            }
            // Not requireReset: it forgets a held key when the bindings change, and what
            // opens Finish must never go on to send.
            if (!event.repeat || repeats(action)) handlers[action].run();
          },
          {
            enabled,
            // The file tree takes ⌥↓ for itself once clicked, so chords come before it, and
            // leave only text alone; the library's own check leaves them to lists too.
            capture: chord,
            stopPropagation: !chord,
            ignoreInputs: !isModified(key),
            // These must not fall through to the browser while they are off, like ⌘R.
            preventDefault: anywhere ? "always" : !chord,
            meta: { name: definitionOf(action).label },
          },
        );
      });
      return () => {
        for (const handle of handles) handle.unregister();
      };
    },
  );
}

/** Lets the motions (Control with J and K, or N and P) move the highlight of a list under a search field. */
export function listMotions(event: KeyboardEvent & { currentTarget: HTMLElement }) {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const key = { j: "ArrowDown", n: "ArrowDown", k: "ArrowUp", p: "ArrowUp" }[event.key.toLowerCase()];
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
  );
}

//! Page shortcuts through TanStack Hotkeys' core, bound to the reviewer's keys
//! from Settings and re-bound whenever those change.

import { getHotkeyManager, type RegisterableHotkey } from "@tanstack/hotkeys";
import { createEffect } from "solid-js";
import { actions, preferences, type Action } from "./settings.ts";

export interface Handler {
  run: () => void;
  /** Also fire while typing in a text field. */
  inInputs?: boolean;
}

export function bindActions(handlers: Record<Action, Handler>) {
  const names = Object.keys(actions) as Action[];
  createEffect(
    () => names.map((action) => preferences.keyFor(action)).join("\n"),
    () => {
      const manager = getHotkeyManager();
      const handles = names.map((action) =>
        manager.register(preferences.keyFor(action) as RegisterableHotkey, () => handlers[action].run(), {
          ignoreInputs: handlers[action].inInputs ? false : "auto",
          preventDefault: true,
        }),
      );
      return () => {
        for (const handle of handles) handle.unregister();
      };
    },
  );
}

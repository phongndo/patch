//! Page shortcuts through TanStack Hotkeys' core, which needs no framework
//! adapter. Each binding lives as long as the component that made it.

import { getHotkeyManager, type RegisterableHotkey } from "@tanstack/hotkeys";
import { onSettled } from "solid-js";

export function hotkeys(bindings: Array<[RegisterableHotkey, () => void, { inInputs?: boolean }?]>) {
  onSettled(() => {
    const manager = getHotkeyManager();
    const handles = bindings.map(([key, run, options]) =>
      manager.register(key, () => run(), {
        ignoreInputs: options?.inInputs ? false : "auto",
        preventDefault: true,
      }),
    );
    return () => {
      for (const handle of handles) handle.unregister();
    };
  });
}

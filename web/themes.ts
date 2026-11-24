//! Community themes are registered with Pierre only when in use, so neither
//! their files nor the list of them load until a reviewer picks one.

import { registerCustomTheme } from "@pierre/diffs";

const registered = new Set<string>();

/** Makes a chosen theme known to Pierre; built-in themes need nothing. */
export async function useTheme(id: string): Promise<void> {
  if (!id.includes(":") || registered.has(id)) return;
  const { communityThemes } = await import("./themes.loaders.gen.ts");
  const load = communityThemes[id];
  if (!load || registered.has(id)) return;
  registered.add(id);
  registerCustomTheme(id, load as never, "zed");
}

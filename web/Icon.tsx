import { icons, type IconName } from "./icons.gen.ts";
import type { Status } from "./state.ts";

export const Icon = (props: { name: IconName }) => <span class="icon" innerHTML={icons[props.name]} />;

/** What happened to a file, as one icon, wherever a file's change is shown. */
export const statusIcons: Record<Status, IconName> = {
  added: "diffAdd",
  modified: "diffModified",
  deleted: "diffDeleted",
  renamed: "diffRenamed",
};

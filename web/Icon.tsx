import { icons, type IconName } from "./icons.gen.ts";

export const Icon = (props: { name: IconName }) => <span class="icon" innerHTML={icons[props.name]} />;

import { For } from "solid-js";
import { segments } from "./search.ts";

/** A label with the characters a search matched in bold. */
export const Marked = (props: { label: string; marks?: ReadonlySet<number> }) => (
  <span class="palette-label">
    <For each={segments(props.label, props.marks ?? new Set())} keyed={false}>
      {(part) => <span class={{ marked: part().marked }}>{part().text}</span>}
    </For>
  </span>
);

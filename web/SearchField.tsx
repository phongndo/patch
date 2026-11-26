//! A search box with an × that clears it, while it has text. Escape clears it
//! too and leaves the field; Enter does what the box offers.

import { Show } from "solid-js";
import type { Action } from "./commands.ts";
import { Icon } from "./Icon.tsx";
import { preferences } from "./settings.ts";

export function SearchField(props: {
  value: string;
  onInput: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  label: string;
  title?: string;
  /** The command that clears it from anywhere, named in the ×'s tooltip. */
  clearAction?: Action;
  class?: string;
}) {
  let input: HTMLInputElement | undefined;
  return (
    <div class="search-field">
      <input
        class={["side-search", props.class]}
        ref={(element) => (input = element)}
        type="search"
        placeholder={props.placeholder}
        aria-label={props.label}
        title={props.title}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          // An input method's own Escape or Enter ends its word.
          if (event.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onEnter?.();
          } else if (event.key === "Escape") {
            props.onInput("");
            event.currentTarget.blur();
          }
        }}
      />
      <Show when={props.value}>
        <button
          class="icon-button search-clear"
          title={props.clearAction ? preferences.hint("Clear", props.clearAction) : "Clear"}
          aria-label={`Clear: ${props.label}`}
          onClick={() => {
            props.onInput("");
            input?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      </Show>
    </div>
  );
}

//! The edge of a panel whose width is kept in pixels, as a focusable separator.
//! UI SDK's Resizable sizes panels in percent and follows their order in the
//! page, so it can't keep the sidebar's width or move it to the other side.

import {
  bindDrag,
  type ChangeDetails,
  type CommitDetails,
  createChange,
  createCommit,
  definePrimitive,
  dragThreshold,
} from "@ui-sdk/core";
import { clamp, stepFromKey } from "@ui-sdk/core/number";
import { createParts } from "@ui-sdk/solid/primitive";

type Reason = "drag" | "step-key" | "imperative";

interface SplitterOptions {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  side?: string;
  onValueChange?: (value: number, details: ChangeDetails<Reason>) => void;
  onValueCommit?: (value: number, details: CommitDetails<Reason>) => void;
}

const steps = { small: 1, step: 16, large: 64 };

const bounds = (options: SplitterOptions) => {
  const min = options.min ?? 0;
  return { min, max: Math.max(min, options.max ?? 1000), side: options.side ?? "left" };
};

export const splitter = definePrimitive({
  name: "splitter",
  options: {
    value: "number",
    defaultValue: "number",
    min: "number",
    max: "number",
    side: "string",
    onValueChange: "callback",
    onValueCommit: "callback",
  },
  controlled: ["value"],
  commits: ["value"],
  state: (options: SplitterOptions) => ({
    value: options.value ?? options.defaultValue ?? 0,
    dragging: false,
    ...bounds(options),
  }),
  sync: (options) => ({
    ...(options.value === undefined ? {} : { value: options.value }),
    ...bounds(options),
  }),
  api: (context) => {
    const change = createChange(context);
    const commit = createCommit(context);
    const { store } = context;
    let stop: (() => void) | undefined;
    context.onDestroy(() => stop?.());

    const fit = (value: number) => Math.round(clamp(value, store.get().min, store.get().max));

    return {
      setValue(value: number, event?: Event) {
        const next = fit(value);
        if (change("value", next, { reason: "imperative", event }))
          commit("value", next, { reason: "imperative", event });
      },
      keydown(event: KeyboardEvent) {
        if (event.ctrlKey || event.metaKey) return;
        const { value, min, max, side } = store.get();
        // Arrows move the edge itself, so on the right side Left widens the panel.
        const move = stepFromKey(event, { arrows: "horizontal", dir: side === "right" ? "rtl" : "ltr" });
        if (!move) return;
        event.preventDefault();
        const next = fit(
          move.bound ? (move.bound === "min" ? min : max) : value + move.direction * steps[move.size],
        );
        if (change("value", next, { reason: "step-key", event }))
          commit("value", next, { reason: "step-key", event });
      },
      pointerdown(event: PointerEvent, el: HTMLElement) {
        if (event.button !== 0) return;
        stop?.();
        const start = store.get().value;
        let last = start;
        stop = bindDrag(el, event, {
          threshold: dragThreshold,
          cancelOnEscape: true,
          onStart: () => store.set({ dragging: true }),
          onMove: ({ x, event }) => {
            const box = el.parentElement!.getBoundingClientRect();
            const next = fit(store.get().side === "right" ? box.right - x : x - box.left);
            if (change("value", next, { reason: "drag", event })) last = next;
          },
          onEnd: (event, canceled) => {
            store.set({ dragging: false });
            if (canceled) change("value", start, { reason: "drag", event });
            else if (last !== start) commit("value", last, { reason: "drag", event });
          },
        });
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { dragging: boolean }>({
      role: "separator",
      focus: "tab-stop",
      keys: ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"],
      state: (state) => ({ dragging: state.dragging }),
      attrs: (state) => ({
        tabindex: "0",
        "aria-orientation": "vertical",
        "aria-valuenow": String(state.value),
        "aria-valuemin": String(state.min),
        "aria-valuemax": String(state.max),
        "data-dragging": state.dragging ? "" : undefined,
      }),
      on: {
        keydown: (event, { api }) => api.keydown(event),
        pointerdown: (event, { el, api }) => api.pointerdown(event, el!),
      },
    }),
  }),
  agent: { actions: ["setValue"] },
});

export const { Root: Splitter } = createParts(splitter, { root: "div" });

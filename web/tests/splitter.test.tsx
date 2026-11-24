import { checkServer, mount } from "@ui-sdk/core/testing";
import { expect, test } from "vitest";
import { splitter } from "../splitter.ts";

const markup = `<root aria-label="Resize"></root>`;
const options = { defaultValue: 280, min: 180, max: 700 };

test("is a named separator that reports its bounds", () => {
  const view = mount(splitter, options, markup);
  try {
    const root = view.part("root")!;
    for (const [name, value] of Object.entries({
      role: "separator",
      "aria-label": "Resize",
      "aria-orientation": "vertical",
      "aria-valuenow": "280",
      "aria-valuemin": "180",
      "aria-valuemax": "700",
      tabindex: "0",
    }))
      expect(root.getAttribute(name), name).toBe(value);
    expect(root.hasAttribute("data-dragging")).toBe(false);
    expect(root.hasAttribute("aria-disabled")).toBe(false);
  } finally {
    view.unmount();
  }
});

test("arrows, Shift, Alt, Home and End move it within its bounds and commit", async () => {
  const committed: number[] = [];
  const view = mount(
    splitter,
    { ...options, onValueCommit: (value: number) => committed.push(value) },
    markup,
  );
  try {
    await view.keys("Tab", "ArrowRight");
    expect(view.state.value).toBe(296);
    expect(view.changes.at(-1)).toMatchObject({ key: "value", source: "keyboard", reason: "step-key" });
    await view.keys("ArrowLeft", "Shift+ArrowRight", "Alt+ArrowLeft");
    expect(view.state.value).toBe(343);
    await view.keys("End", "ArrowRight");
    expect(view.state.value).toBe(700);
    await view.keys("Home", "ArrowLeft");
    expect(view.state.value).toBe(180);
    expect(committed).toEqual([296, 280, 344, 343, 700, 180]);
  } finally {
    view.unmount();
  }
});

test("on the right side the arrows move the edge, so Left widens the panel", async () => {
  const view = mount(splitter, { ...options, side: "right" }, markup);
  try {
    await view.keys("Tab", "ArrowLeft");
    expect(view.state.value).toBe(296);
    await view.keys("ArrowRight", "ArrowRight");
    expect(view.state.value).toBe(264);
  } finally {
    view.unmount();
  }
});

test("Up and Down are left to the page", async () => {
  const view = mount(splitter, options, markup);
  try {
    await view.keys("Tab", "ArrowUp", "ArrowDown");
    expect(view.state.value).toBe(280);
    expect(view.changes).toHaveLength(0);
  } finally {
    view.unmount();
  }
});

test("renders on the server", () => {
  checkServer(splitter, options, markup);
});

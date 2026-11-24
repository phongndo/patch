import { createAgent } from "@ui-sdk/solid/agent";
import { createSignal } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import { defaults, preferences } from "../settings.ts";
import { SettingsDialog } from "../SettingsDialog.tsx";
import { themes } from "../themes.gen.ts";
import { $, click, mount, named, nameOf, press, settle, type } from "./dom.tsx";

const agent = createAgent();
let closed = 0;

beforeEach(async () => {
  closed = 0;
  vi.stubGlobal("fetch", async () => new Response("{}"));
  preferences.reset();
  mount(() => {
    const [open, setOpen] = createSignal(true);
    return (
      <SettingsDialog
        open={open()}
        onOpenChange={(next) => {
          if (!next) closed++;
          setOpen(next);
        }}
      />
    );
  });
  await settle();
});

const page = (title: string) =>
  click(
    [...document.querySelectorAll<HTMLElement>(".settings-nav-item")].find((e) => e.textContent === title)!,
  );
const size = () => named("textbox", "Font size") as HTMLInputElement;

test("every switch toggles from Space and from its label, and is described", async () => {
  const keys = {
    "Wrap long lines": "wrap",
    "Highlight changed words": "wordDiff",
    "Fold generated files": "foldGenerated",
  } as const;
  for (const [label, key] of Object.entries(keys) as Array<[string, (typeof keys)[keyof typeof keys]]>) {
    const control = named("switch", label);
    expect(document.getElementById(control.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
    await click(control);
    expect(preferences.settings[key]).toBe(!defaults[key]);
    await click([...document.querySelectorAll("label")].find((e) => e.textContent === label)!);
    expect(preferences.settings[key]).toBe(defaults[key]);
  }
});

test("a row's reset button resets it without pressing its control", async () => {
  await click(named("switch", "Wrap long lines"));
  expect(preferences.settings.wrap).toBe(false);
  await click(named("button", "Reset Wrap long lines"));
  expect(preferences.settings.wrap).toBe(true);
});

test("a number field keeps its value when emptied and clamps what is typed", async () => {
  await page("Typography");
  for (const [text, saved] of [
    ["", 13],
    ["999", 20],
    ["998", 20],
    ["3", 10],
  ] as const) {
    await type(size(), text);
    await press(size(), "Enter");
    expect(preferences.settings.codeSize).toBe(saved);
    expect(size().value).toBe(String(saved));
  }
});

test("its step buttons are named and step it", async () => {
  await page("Typography");
  await click(named("button", "More Font size"));
  expect(preferences.settings.codeSize).toBe(14);
  await click(named("button", "Less Font size"));
  expect(preferences.settings.codeSize).toBe(13);
});

test("Escape in a number field closes Settings", async () => {
  await page("Typography");
  size().focus();
  await press(size(), "Escape");
  expect(closed).toBe(1);
});

test("Escape in the font field closes only its popover, Enter keeps what was typed", async () => {
  await page("Typography");
  const trigger = named("button", "Choose… Code font");
  await click(trigger);
  expect(nameOf($(".font-menu"))).toBe("Code font");
  await press($(".font-menu input"), "Escape");
  expect(document.querySelector(".font-menu[data-open]")).toBeNull();
  expect(closed).toBe(0);

  await click(trigger);
  await type($<HTMLInputElement>(".font-menu input"), "Menlo, monospace");
  const enter = await press($(".font-menu input"), "Enter");
  expect(enter.defaultPrevented).toBe(true);
  expect(preferences.settings.codeFont).toBe("Menlo, monospace");
  expect(document.querySelector(".font-menu[data-open]")).toBeNull();
});

test("arrows browse the themes and Enter chooses one", async () => {
  await page("Themes");
  const strip = named("listbox", "Light theme");
  const [first, second] = strip.querySelectorAll<HTMLElement>('[role="option"]');
  first!.focus();
  await press(first!, "ArrowRight");
  expect(document.activeElement).toBe(second);
  expect(preferences.settings.lightTheme).toBe(defaults.lightTheme);
  await press(second!, "Enter");
  expect(second!.getAttribute("aria-selected")).toBe("true");
  expect(preferences.settings.lightTheme).not.toBe(defaults.lightTheme);
});

test("the themes open on the chosen one", async () => {
  const shown: Array<string | null> = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    shown.push(this.getAttribute("aria-label"));
  });
  const last = themes.findLast((theme) => theme.dark && theme.group === "community")!;
  preferences.chooseTheme(last);
  await page("Themes");
  await settle(60);
  expect(shown).toContain(last.name);
});

test("an agent can find and change every setting", async () => {
  const labels = new Set<string | undefined>();
  for (const title of ["General", "Themes", "Typography"]) {
    await page(title);
    for (const entry of agent.snapshot().filter((e) => !e.offPage && e.component !== "more")) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
      labels.add(entry.label);
    }
  }
  for (const label of [
    "Sidebar",
    "Diff layout",
    "Wrap long lines",
    "Change markers",
    "Change contrast",
    "Highlight changed words",
    "Fold generated files",
    "Appearance",
    "Base16 schemes",
    "Light theme",
    "Dark theme",
    "Font size",
    "Weight",
    "Line height",
    "Ligatures",
  ])
    expect([...labels], `${label} is missing`).toContain(label);

  await page("General");
  const result = await agent.act({
    steps: [
      { ref: "Change contrast", action: "setValue", args: ["high"] },
      { ref: "Wrap long lines", action: "setChecked", args: [false] },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  expect(preferences.settings.contrast).toBe("high");
  expect(preferences.settings.wrap).toBe(false);
});

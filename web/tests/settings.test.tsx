import { createAgent } from "@ui-sdk/solid/agent";
import { createSignal } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import { defaults, preferences } from "../settings.ts";
import { SettingsDialog } from "../SettingsDialog.tsx";
import { themes } from "../themes.gen.ts";
import { setSettingsPage } from "../ui.ts";
import { $, click, mount, named, nameOf, press, settle, type } from "./dom.tsx";

const agent = createAgent();
let closed = 0;

beforeEach(async () => {
  closed = 0;
  vi.stubGlobal("fetch", async () => new Response("{}"));
  preferences.reset();
  setSettingsPage("general");
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
  const last = themes.findLast((theme) => theme.dark && theme.group === "community")!;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new DOMRect(this.getAttribute("aria-label") === last.name ? 800 : 0, 0, 100, 100);
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("theme-strip") ? 400 : 0;
  });
  preferences.chooseTheme(last);
  await page("Themes");
  await settle(60);
  // A 100px tile at 800px, centred in a 400px strip.
  expect($('[aria-label="Dark theme"]').scrollLeft).toBe(650);
});

test("switching settings pages starts at the top, and an empty search shows no unrelated settings", async () => {
  $(".settings-body").scrollTop = 200;
  await page("Typography");
  expect($(".settings-body").scrollTop).toBe(0);
  const search = $<HTMLInputElement>('[aria-label="Search settings"]');
  await type(search, "no-matching-setting");
  expect($(".settings-page").textContent).toContain("No settings match.");
  expect(document.querySelector(".settings-body")).toBeNull();
  await press(search, "Escape");
  expect($(".settings-crumbs").textContent).toContain("Typography");
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

test("the page takes a theme's Display P3 colors, and drops what is not a color", async () => {
  const { darkTheme, darkColors } = defaults;
  const panel = "color(display-p3 0.090196 0.090196 0.090196)";
  const add = "color(display-p3 0.304148 0.801790 0.517191 / 0.550000)";
  const root = document.documentElement.style;
  preferences.update({ colorScheme: "dark", darkTheme, darkColors: { ...darkColors, chrome: panel, add } });
  await settle();
  expect(root.getPropertyValue("--panel")).toBe(panel);
  expect(root.getPropertyValue("--add")).toBe(add);
  preferences.update({ darkColors: { ...darkColors, chrome: "url(x)" } });
  await settle();
  expect(root.getPropertyValue("--panel")).toBe(darkColors.editor);
});

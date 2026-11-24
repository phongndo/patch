//! Settings: a centered dialog with a page per subject down the side and a
//! search across all of them (/ focuses it). Themes as tiles, fonts with a
//! live preview, and a shortcut recorder. Every change applies at once and is
//! saved by patchr for the next review.

import { type JSX } from "@solidjs/web";
import { HotkeyRecorder } from "@tanstack/hotkeys";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/solid/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/solid/listbox";
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from "@ui-sdk/solid/number-input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/solid/segmented-control";
import { Switch, SwitchThumb } from "@ui-sdk/solid/switch";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { actionGroups, actionNames, definitionOf, type Action } from "./commands.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import {
  defaults,
  displayKey,
  fontPresets,
  preferences,
  ranges,
  type Numeric,
  type Settings,
} from "./settings.ts";
import { defaultDark, defaultLight } from "./themes.defaults.gen.ts";
import { themes, type Theme } from "./themes.gen.ts";
import { setSettingsPage, settingsPage, type SettingsPage } from "./ui.ts";

const { settings, update } = preferences;

/* Controls */

function Choose<K extends keyof Settings>(props: {
  name: K;
  label: string;
  options: Array<{ value: Settings[K]; label: string }>;
}) {
  return (
    <SegmentedControl
      class="segmented"
      aria-label={props.label}
      value={String(settings[props.name])}
      onValueChange={(value) => {
        const option = props.options.find((choice) => String(choice.value) === value);
        if (option) update({ [props.name]: option.value } as Partial<Settings>);
      }}
    >
      <SegmentedControlIndicator class="segmented-indicator" />
      <For each={props.options}>
        {(option) => (
          <SegmentedControlItem class="segmented-item" value={String(option.value)}>
            {option.label}
          </SegmentedControlItem>
        )}
      </For>
    </SegmentedControl>
  );
}

type Toggleable = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Toggle(props: { name: Toggleable }) {
  return (
    <Switch
      class="switch"
      checked={settings[props.name]}
      onCheckedChange={(checked) => update({ [props.name]: checked } as Partial<Settings>)}
    >
      <SwitchThumb class="switch-thumb" />
    </Switch>
  );
}

/** A number field with arrows and a unit, like a native stepper. */
function Stepper(props: { name: Numeric; label: string; icon: IconName; unit?: string }) {
  const range = () => ranges[props.name];
  return (
    <Field class="field-group">
      <FieldLabel class="field-name">{props.label}</FieldLabel>
      <span class="stepper-row">
        <NumberInput
          min={range().min}
          max={range().max}
          step={range().step}
          value={settings[props.name]}
          onValueChange={(value, details) => {
            if (value === null) details.cancel();
            else update({ [props.name]: value } as Partial<Settings>);
          }}
        >
          <NumberInputGroup class="stepper">
            <Icon name={props.icon} />
            <NumberInputControl />
            <span class="stepper-arrows">
              <NumberInputIncrement aria-label={`More ${props.label}`}>
                <Icon name="chevronSm" />
              </NumberInputIncrement>
              <NumberInputDecrement aria-label={`Less ${props.label}`}>
                <Icon name="chevronSm" />
              </NumberInputDecrement>
            </span>
          </NumberInputGroup>
        </NumberInput>
        <Show when={props.unit}>
          <span class="muted">{props.unit}</span>
        </Show>
      </span>
    </Field>
  );
}

/* Themes */

function ThemeTile(props: { theme: Theme }) {
  const c = () => props.theme.colors;
  const accent = () => c().accent ?? props.theme.palette[4] ?? c().text;
  return (
    <ListboxItem
      class="theme-tile"
      value={props.theme.id}
      label={props.theme.name}
      aria-label={props.theme.name}
    >
      <span class="theme-face" aria-hidden="true" style={{ background: c().editor, color: c().text }}>
        <span class="theme-top">
          <span class="theme-aa">Aa</span>
          <span
            class="theme-chip"
            style={{ background: `color-mix(in srgb, ${accent()} 22%, ${c().editor})`, color: accent() }}
          >
            ~/
          </span>
          <span class="theme-cursor" style={{ background: accent() }} />
        </span>
        <span class="theme-dots">
          <For each={props.theme.palette}>
            {(color) => <span style={{ background: color, "box-shadow": `0 0 0 2px ${c().editor}` }} />}
          </For>
        </span>
      </span>
      <span class="theme-name">{props.theme.name}</span>
    </ListboxItem>
  );
}

const groups: Array<{ id: string; label: string }> = [
  { id: "pierre", label: "Pierre" },
  { id: "builtin", label: "Built-in" },
  { id: "community", label: "Community" },
  { id: "base16", label: "Base16" },
];

/** A mode's themes in one sideways strip, in labeled sections. */
function ThemeStrip(props: { field: "lightTheme" | "darkTheme"; base16: boolean }) {
  const dark = () => props.field === "darkTheme";
  const sections = () =>
    groups
      .filter((group) => group.id !== "base16" || props.base16)
      .map((group) => ({
        ...group,
        themes: themes.filter((theme) => theme.dark === dark() && theme.group === group.id),
      }))
      .filter((group) => group.themes.length);
  return (
    <Listbox
      class="theme-strip"
      ref={(element: HTMLElement) =>
        // Tiles out of view have only an estimated size, so the list's own scrolling misses the chosen one.
        requestAnimationFrame(() =>
          element
            .querySelector(".theme-tile[data-selected]")
            ?.scrollIntoView({ block: "nearest", inline: "center" }),
        )
      }
      aria-label={dark() ? "Dark theme" : "Light theme"}
      orientation="horizontal"
      activation="manual"
      loop={false}
      value={settings[props.field]}
      onValueChange={(id) => {
        const theme = themes.find((candidate) => candidate.id === id);
        if (theme) preferences.chooseTheme(theme);
      }}
    >
      <For each={sections()}>
        {(section) => (
          <ListboxGroup class="theme-section">
            <ListboxGroupLabel class="theme-section-label">
              {section.label}
              <span class="muted"> {section.themes.length}</span>
            </ListboxGroupLabel>
            <div class="theme-section-tiles" role="presentation">
              <For each={section.themes}>{(theme) => <ThemeTile theme={theme} />}</For>
            </div>
          </ListboxGroup>
        )}
      </For>
    </Listbox>
  );
}

function ThemesPage() {
  // Base16's 251 schemes stay out of the strip until asked for, or one is in use.
  const [base16, setBase16] = createSignal(
    settings.lightTheme.startsWith("base16:") || settings.darkTheme.startsWith("base16:"),
  );
  const active = () => (preferences.dark() ? "darkTheme" : "lightTheme");
  return (
    <>
      <Group title="Mode">
        <div class="settings-card">
          <Row
            label="Appearance"
            description="Follow the system, or always use the light or dark theme."
            keys={["colorScheme"]}
          >
            <Choose
              name="colorScheme"
              label="Appearance"
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Row>
          <Row
            label="Base16 schemes"
            description="List 251 more color schemes from the Base16 project."
            keys={[]}
          >
            <Switch class="switch" checked={base16()} onCheckedChange={setBase16}>
              <SwitchThumb class="switch-thumb" />
            </Switch>
          </Row>
        </div>
      </Group>
      <For each={["lightTheme", "darkTheme"] as const}>
        {(field) => (
          <Group
            title={field === "lightTheme" ? "Light Mode" : "Dark Mode"}
            note={active() === field ? "Active" : undefined}
            reset={
              settings[field] !== defaults[field]
                ? () => preferences.chooseTheme(field === "lightTheme" ? defaultLight : defaultDark)
                : undefined
            }
          >
            <div class="settings-card">
              <ThemeStrip field={field} base16={base16()} />
            </div>
          </Group>
        )}
      </For>
    </>
  );
}

/* Typography */

function FontCard(props: {
  field: "uiFont" | "codeFont";
  title: string;
  presets: ReadonlyArray<{ label: string; value: string }>;
  size: Numeric;
  weight: Numeric;
  preview: () => JSX.Element;
  children?: JSX.Element;
  /** More rows in the same card, under the preview. */
  footer?: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const typed = (text: string) => {
    const value = text.trim();
    if (value) update({ [props.field]: value });
  };
  const name = () =>
    props.presets.find((preset) => preset.value === settings[props.field])?.label ??
    settings[props.field].split(",")[0]!.replaceAll('"', "");
  return (
    <div class="settings-card">
      <div class="setting">
        <span class="setting-label">{props.title}</span>
        <span class="font-current" style={{ "font-family": settings[props.field] }}>
          {name()}
        </span>
        <Popover open={open()} onOpenChange={setOpen}>
          <PopoverTrigger class="pill">
            Choose…<span class="sr-only"> {props.title}</span>
          </PopoverTrigger>
          <PopoverContent class="menu font-menu" side="bottom" align="end" sideOffset={6}>
            <PopoverTitle class="sr-only">{props.title}</PopoverTitle>
            <For each={props.presets}>
              {(preset) => (
                <button
                  class="menu-item"
                  aria-pressed={settings[props.field] === preset.value ? "true" : "false"}
                  style={{ "font-family": preset.value }}
                  onClick={() => {
                    update({ [props.field]: preset.value });
                    setOpen(false);
                  }}
                >
                  <span class="menu-check">
                    <Show when={settings[props.field] === preset.value}>
                      <Icon name="check" />
                    </Show>
                  </span>
                  {preset.label}
                </button>
              )}
            </For>
            <Field class="menu-group">
              <FieldLabel class="menu-label">Any installed font</FieldLabel>
              <Input
                class="field mono"
                spellcheck={false}
                placeholder='"My Font", monospace'
                defaultValue={settings[props.field]}
                onChange={(event) => typed(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter would go on to press the trigger, which focus returns to.
                  event.preventDefault();
                  typed(event.currentTarget.value);
                  setOpen(false);
                }}
              />
            </Field>
          </PopoverContent>
        </Popover>
      </div>
      <div class="field-grid">
        <Stepper name={props.size} label="Font size" icon="type" unit="px" />
        <Stepper name={props.weight} label="Weight" icon="textBold" />
        {props.children}
      </div>
      <div class="preview">{props.preview()}</div>
      <Show when={props.footer}>
        <div class="card-rows">{props.footer}</div>
      </Show>
    </div>
  );
}

function TypographyPage() {
  return (
    <>
      <Group
        title="Code"
        reset={
          ["codeFont", "codeSize", "codeWeight", "lineHeight", "ligatures"].some(
            (key) => settings[key as keyof Settings] !== defaults[key as keyof Settings],
          )
            ? () =>
                update({
                  codeFont: defaults.codeFont,
                  codeSize: defaults.codeSize,
                  codeWeight: defaults.codeWeight,
                  lineHeight: defaults.lineHeight,
                  ligatures: defaults.ligatures,
                })
            : undefined
        }
      >
        <FontCard
          field="codeFont"
          title="Code font"
          presets={fontPresets.code}
          size="codeSize"
          weight="codeWeight"
          footer={
            <Row
              label="Ligatures"
              description="Join characters like => and != in fonts that support it."
              keys={["ligatures"]}
            >
              <Toggle name="ligatures" />
            </Row>
          }
          preview={() => (
            <pre
              class="code-preview"
              style={{
                "font-family": settings.codeFont,
                "font-size": `${settings.codeSize}px`,
                "line-height": `${settings.lineHeight}px`,
                "font-weight": settings.codeWeight,
                "font-feature-settings": settings.ligatures ? "normal" : '"liga" 0, "calt" 0',
              }}
            >
              <span class="del-line">- const limit = 64 * 1024 * 1024;</span>
              {"\n"}
              <span class="add-line">+ const limit = maxReviewBytes =&gt; bytes !== 0;</span>
            </pre>
          )}
        >
          <Stepper name="lineHeight" label="Line height" icon="diffUnified" unit="px" />
        </FontCard>
      </Group>
      <Group
        title="Interface"
        reset={
          ["uiFont", "textSize", "uiWeight"].some(
            (key) => settings[key as keyof Settings] !== defaults[key as keyof Settings],
          )
            ? () =>
                update({ uiFont: defaults.uiFont, textSize: defaults.textSize, uiWeight: defaults.uiWeight })
            : undefined
        }
      >
        <FontCard
          field="uiFont"
          title="Interface font"
          presets={fontPresets.ui}
          size="textSize"
          weight="uiWeight"
          preview={() => (
            <p
              class="ui-preview"
              style={{
                "font-family": settings.uiFont,
                "font-size": `${settings.textSize}px`,
                "font-weight": settings.uiWeight,
              }}
            >
              Send review · 3 comments · Lines 12–18 of src/git.ts
            </p>
          )}
        />
      </Group>
    </>
  );
}

/* Shortcuts */

/** One rebindable action: click, press the new keys, and it is saved. */
function Binding(props: { action: Action }) {
  const [recording, setRecording] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  let recorder: HotkeyRecorder | undefined;
  const key = () => preferences.keyFor(props.action);

  function record() {
    setProblem("");
    recorder = new HotkeyRecorder({
      // Safari leaves focus where it was, like in the search field, when a button is clicked.
      ignoreInputs: false,
      // Two keys can be written differently and still be one press, like ? and Shift+/.
      detectConflicts: {
        includeDisabled: true,
        exclude: (registration) => registration.options.meta?.name === definitionOf(props.action).label,
      },
      onReject: ({ conflicts }) => {
        const name = conflicts?.[0]?.registration.options.meta?.name;
        setProblem(name ? `Used by “${name}”` : "That key cannot be used");
      },
      onRecord(hotkey) {
        setRecording(false);
        const taken = actionNames.find(
          (other) => other !== props.action && preferences.keyFor(other) === hotkey,
        );
        if (taken) return setProblem(`Used by “${definitionOf(taken).label}”`);
        setProblem("");
        preferences.bind(props.action, hotkey as string);
      },
      onClear() {
        setRecording(false);
        recorder?.stop();
        preferences.bind(props.action, "");
      },
      onCancel: () => setRecording(false),
    });
    setRecording(true);
    recorder.start();
  }
  onCleanup(() => recorder?.stop());

  return (
    <span class="binding">
      <Show when={problem()}>
        <span class="binding-problem">{problem()}</span>
      </Show>
      <Show when={settings.keys[props.action] !== undefined}>
        <button
          class="reset"
          title={`Back to ${displayKey(definitionOf(props.action).key ?? "") || "no shortcut"}`}
          onClick={() => preferences.bind(props.action, undefined)}
        >
          <Icon name="refresh" />
        </button>
      </Show>
      <button
        class={{ "key-chip": true, recording: recording(), unbound: !key() }}
        aria-label={`${definitionOf(props.action).label}: ${displayKey(key()) || "no shortcut"}`}
        title={
          recording()
            ? "Press the new keys · Esc cancels · ⌫ removes the shortcut"
            : "Click, then press the new keys"
        }
        onClick={() => (recording() ? recorder?.cancel() : record())}
      >
        {recording() ? "Press keys…" : displayKey(key()) || "None"}
      </button>
    </span>
  );
}

function ShortcutsPage(props: { filter: string }) {
  const groups = createMemo(() => {
    const text = props.filter.trim().toLowerCase();
    const rows = actionNames.filter(
      (action) =>
        !text ||
        definitionOf(action).label.toLowerCase().includes(text) ||
        preferences.keyText(action).toLowerCase().includes(text) ||
        preferences.keyFor(action).toLowerCase().includes(text),
    );
    return actionGroups
      .map((group) => [group, rows.filter((action) => definitionOf(action).group === group)] as const)
      .filter(([, members]) => members.length);
  });
  return (
    <>
      <p class="page-note">
        Click a shortcut and press the new keys, or Backspace to remove it. Keys another shortcut already uses
        are refused, and each one can go back to its default. The command palette (
        {preferences.keyText("palette")}) has every one of these.
      </p>
      <For each={groups()} fallback={<p class="settings-empty">No shortcuts match.</p>}>
        {([group, rows]) => (
          <Group title={group}>
            <div class="settings-card">
              <For each={rows}>
                {(action) => (
                  <div class="setting">
                    <span class="setting-label">{definitionOf(action).label}</span>
                    <Binding action={action} />
                  </div>
                )}
              </For>
            </div>
          </Group>
        )}
      </For>
    </>
  );
}

/* Page parts */

function Group(props: { title: string; note?: string; reset?: () => void; children: JSX.Element }) {
  return (
    <section class="settings-group">
      <h3>
        {props.title}
        <Show when={props.note}>
          <span class="muted"> — {props.note}</span>
        </Show>
        <Show when={props.reset}>
          <button
            type="button"
            class="reset"
            title="Back to the defaults"
            aria-label={`Reset ${props.title}`}
            onClick={() => props.reset?.()}
          >
            <Icon name="refresh" />
          </button>
        </Show>
      </h3>
      {props.children}
    </section>
  );
}

function Row(props: {
  label: string;
  description?: string;
  keys: Array<keyof Settings>;
  children: JSX.Element;
}) {
  const changed = () => props.keys.some((key) => settings[key] !== defaults[key]);
  return (
    <Field class="setting">
      <span class="setting-text">
        <span class="setting-label">
          <FieldLabel>{props.label}</FieldLabel>
          <Show when={changed()}>
            <button
              type="button"
              class="reset"
              title="Back to the default"
              aria-label={`Reset ${props.label}`}
              onClick={() => update(Object.fromEntries(props.keys.map((key) => [key, defaults[key]])))}
            >
              <Icon name="refresh" />
            </button>
          </Show>
        </span>
        <Show when={props.description}>
          <FieldDescription class="setting-description">{props.description}</FieldDescription>
        </Show>
      </span>
      {props.children}
    </Field>
  );
}

function GeneralPage() {
  return (
    <>
      <Group title="Workspace">
        <div class="settings-card">
          <Row label="Sidebar" description="Which side the files and comments sit on." keys={["sidebarSide"]}>
            <Choose
              name="sidebarSide"
              label="Sidebar"
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
            />
          </Row>
          <Row
            label="Diff layout"
            description="Side by side, one column, or split on wide windows only."
            keys={["layout"]}
          >
            <Choose
              name="layout"
              label="Diff layout"
              options={[
                { value: "auto", label: "Auto" },
                { value: "split", label: "Split" },
                { value: "unified", label: "Unified" },
              ]}
            />
          </Row>
          <Row
            label="Wrap long lines"
            description="Wrap lines instead of scrolling sideways."
            keys={["wrap"]}
          >
            <Toggle name="wrap" />
          </Row>
        </div>
      </Group>
      <Group title="Diff">
        <div class="settings-card">
          <Row
            label="Change markers"
            description="Colored bars, or + and − signs, beside changed lines."
            keys={["indicators"]}
          >
            <Choose
              name="indicators"
              label="Change markers"
              options={[
                { value: "bars", label: "Bars" },
                { value: "classic", label: "+ / −" },
              ]}
            />
          </Row>
          <Row
            label="Change contrast"
            description="How strongly changed lines and words are tinted."
            keys={["contrast"]}
          >
            <Choose
              name="contrast"
              label="Change contrast"
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </Row>
          <Row
            label="Highlight changed words"
            description="Mark the words that changed within a line."
            keys={["wordDiff"]}
          >
            <Toggle name="wordDiff" />
          </Row>
          <Row
            label="Fold generated files"
            description="Open lockfiles, minified and generated files folded."
            keys={["foldGenerated"]}
          >
            <Toggle name="foldGenerated" />
          </Row>
        </div>
      </Group>
    </>
  );
}

const pages: Array<{ id: SettingsPage; title: string; icon: IconName; words: string }> = [
  {
    id: "general",
    title: "General",
    icon: "sidebarLeft",
    words:
      "layout sidebar left right split unified wrap diff change markers bars contrast colors words generated fold",
  },
  { id: "themes", title: "Themes", icon: "brush", words: "appearance color scheme dark light mode palette" },
  {
    id: "typography",
    title: "Typography",
    icon: "type",
    words: "font size weight line height ligatures interface code",
  },
  { id: "shortcuts", title: "Shortcuts", icon: "key", words: "keyboard keys bindings hotkeys" },
];

const pageWords = (id: SettingsPage) => {
  const found = pages.find((p) => p.id === id)!;
  return `${found.title} ${found.words}`.toLowerCase();
};

export function SettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = createSignal("");
  let search: HTMLInputElement | undefined;

  // The search picks the page; on Shortcuts it also filters the list.
  const matching = createMemo(() => {
    const text = query().trim().toLowerCase();
    if (!text) return pages;
    const findsShortcut = actionNames.some((action) =>
      `${definitionOf(action).label} ${preferences.keyText(action)}`.toLowerCase().includes(text),
    );
    return pages.filter(
      (p) => `${p.title} ${p.words}`.toLowerCase().includes(text) || (p.id === "shortcuts" && findsShortcut),
    );
  });
  const shown = () =>
    matching().some((p) => p.id === settingsPage()) ? settingsPage() : (matching()[0]?.id ?? settingsPage());
  const title = () => pages.find((p) => p.id === shown())!.title;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (!open) setQuery("");
      }}
    >
      <DialogBackdrop class="dialog-backdrop" />
      <DialogContent
        class="settings-dialog"
        onKeyDown={(event: KeyboardEvent) => {
          const typing =
            event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
          if (event.key === "/" && !typing) {
            event.preventDefault();
            search?.focus();
          }
        }}
      >
        <aside class="settings-side">
          <label class="settings-search">
            <Icon name="search" />
            <input
              ref={(element) => (search = element)}
              type="search"
              placeholder="Search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query()) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
            <kbd>/</kbd>
          </label>
          <nav class="settings-nav" aria-label="Settings pages">
            <For each={pages}>
              {(candidate) => (
                <button
                  class="settings-nav-item"
                  aria-current={shown() === candidate.id ? "page" : undefined}
                  disabled={!matching().includes(candidate)}
                  onClick={() => setSettingsPage(candidate.id)}
                >
                  <Icon name={candidate.icon} />
                  {candidate.title}
                </button>
              )}
            </For>
          </nav>
        </aside>

        <div class="settings-page">
          <header class="settings-head">
            <DialogTitle class="settings-crumbs">
              <span class="muted">Settings</span>
              <span class="muted">/</span>
              {title()}
            </DialogTitle>
            <button class="settings-restore" onClick={() => preferences.reset()}>
              <Icon name="refresh" />
              Restore defaults
            </button>
            <DialogClose class="icon-button" aria-label="Close settings">
              <Icon name="x" />
            </DialogClose>
          </header>
          <div class="settings-body">
            <Show when={shown() === "themes"}>
              <ThemesPage />
            </Show>
            <Show when={shown() === "typography"}>
              <TypographyPage />
            </Show>
            <Show when={shown() === "general"}>
              <GeneralPage />
            </Show>
            <Show when={shown() === "shortcuts"}>
              <ShortcutsPage
                filter={pageWords("shortcuts").includes(query().trim().toLowerCase()) ? "" : query()}
              />
            </Show>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

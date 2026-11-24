//! Settings: a centered dialog with a page per subject down the side and a
//! search across all of them (/ focuses it). Themes as tiles, fonts with a
//! live preview, and a shortcut recorder. Every change applies at once and is
//! saved by patchr for the next review.

import { type JSX } from "@solidjs/web";
import { formatForDisplay, HotkeyRecorder, type Hotkey } from "@tanstack/hotkeys";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/solid/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/solid/popover";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/solid/segmented-control";
import { Switch, SwitchThumb } from "@ui-sdk/solid/switch";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import { actions, defaults, fontPresets, preferences, type Action, type Settings } from "./settings.ts";
import { themes, type Theme } from "./themes.gen.ts";

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

function Toggle(props: { name: Toggleable; label: string }) {
  return (
    <Switch
      class="switch"
      aria-label={props.label}
      checked={settings[props.name]}
      onCheckedChange={(checked) => update({ [props.name]: checked } as Partial<Settings>)}
    >
      <SwitchThumb class="switch-thumb" />
    </Switch>
  );
}

type Numeric = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

/** A number field with arrows and a unit, like a native stepper. */
function Stepper(props: {
  name: Numeric;
  label: string;
  icon: IconName;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  const step = () => props.step ?? 1;
  const set = (value: number) =>
    update({ [props.name]: Math.min(props.max, Math.max(props.min, value)) } as Partial<Settings>);
  return (
    <label class="field-group">
      <span class="field-name">{props.label}</span>
      <span class="stepper-row">
        <span class="stepper">
          <Icon name={props.icon} />
          <input
            type="number"
            aria-label={props.label}
            min={props.min}
            max={props.max}
            step={step()}
            value={settings[props.name]}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) set(Math.round(value / step()) * step());
            }}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <span class="stepper-arrows">
            <button
              type="button"
              aria-label={`More ${props.label}`}
              onClick={() => set(settings[props.name] + step())}
            >
              <Icon name="chevronSm" />
            </button>
            <button
              type="button"
              aria-label={`Less ${props.label}`}
              onClick={() => set(settings[props.name] - step())}
            >
              <Icon name="chevronSm" />
            </button>
          </span>
        </span>
        <Show when={props.unit}>
          <span class="muted">{props.unit}</span>
        </Show>
      </span>
    </label>
  );
}

/* Themes */

function ThemeTile(props: { theme: Theme; field: "lightTheme" | "darkTheme" }) {
  const c = () => props.theme.colors;
  const accent = () => c().accent ?? props.theme.palette[4] ?? c().text;
  const chosen = () => settings[props.field] === props.theme.id;
  return (
    <button
      class={{ "theme-tile": true, chosen: chosen() }}
      aria-pressed={chosen() ? "true" : "false"}
      onClick={() => update({ [props.field]: props.theme.id })}
    >
      <span class="theme-face" style={{ background: c().editor, color: c().text }}>
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
    </button>
  );
}

function ThemeStrip(props: { field: "lightTheme" | "darkTheme" }) {
  const list = () => themes.filter((theme) => theme.dark === (props.field === "darkTheme"));
  return (
    <div
      class="theme-strip"
      ref={(element) =>
        // Open on the chosen theme.
        requestAnimationFrame(() =>
          element.querySelector(".theme-tile.chosen")?.scrollIntoView({ block: "nearest", inline: "center" }),
        )
      }
    >
      <For each={list()}>{(theme) => <ThemeTile theme={theme} field={props.field} />}</For>
    </div>
  );
}

function ThemesPage() {
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
        </div>
      </Group>
      <For each={["lightTheme", "darkTheme"] as const}>
        {(field) => (
          <Group
            title={field === "lightTheme" ? "Light Mode" : "Dark Mode"}
            note={active() === field ? "Active" : undefined}
            reset={
              settings[field] !== defaults[field] ? () => update({ [field]: defaults[field] }) : undefined
            }
          >
            <ThemeStrip field={field} />
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
  sizeRange: [number, number];
  preview: () => JSX.Element;
  children?: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
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
          <PopoverTrigger class="pill">Choose…</PopoverTrigger>
          <PopoverContent class="menu font-menu" side="bottom" align="end" sideOffset={6}>
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
            <div class="menu-group">
              <p class="menu-label">Any installed font</p>
              <input
                class="field mono"
                spellcheck={false}
                aria-label={`${props.title}: font family`}
                placeholder='"My Font", monospace'
                value={settings[props.field]}
                onChange={(event) => {
                  const value = event.currentTarget.value.trim();
                  if (value) update({ [props.field]: value });
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") setOpen(false);
                }}
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div class="field-grid">
        <Stepper
          name={props.size}
          label="Font size"
          icon="type"
          min={props.sizeRange[0]}
          max={props.sizeRange[1]}
          unit="px"
        />
        <Stepper name={props.weight} label="Weight" icon="textBold" min={100} max={900} step={100} />
        {props.children}
      </div>
      <div class="preview">{props.preview()}</div>
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
          sizeRange={[10, 20]}
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
          <Stepper name="lineHeight" label="Line height" icon="diffUnified" min={14} max={32} unit="px" />
        </FontCard>
        <div class="settings-card">
          <Row
            label="Ligatures"
            description="Join characters like => and != in fonts that support it."
            keys={["ligatures"]}
          >
            <Toggle name="ligatures" label="Ligatures" />
          </Row>
        </div>
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
          sizeRange={[11, 17]}
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

const display = (key: string) => {
  try {
    return formatForDisplay(key as Hotkey);
  } catch {
    return key;
  }
};

/** One rebindable action: click, press the new keys, and it is saved. */
function Binding(props: { action: Action }) {
  const [recording, setRecording] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  let recorder: HotkeyRecorder | undefined;
  const key = () => preferences.keyFor(props.action);

  function record() {
    setProblem("");
    recorder = new HotkeyRecorder({
      onRecord(hotkey) {
        setRecording(false);
        const taken = (Object.keys(actions) as Action[]).find(
          (other) => other !== props.action && preferences.keyFor(other) === hotkey,
        );
        if (taken) return setProblem(`Used by “${actions[taken].label}”`);
        preferences.bind(props.action, hotkey);
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
          title={`Back to ${display(actions[props.action].key)}`}
          onClick={() => preferences.bind(props.action, undefined)}
        >
          <Icon name="refresh" />
        </button>
      </Show>
      <button
        class={{ "key-chip": true, recording: recording() }}
        aria-label={`${actions[props.action].label}: ${display(key())}`}
        title={recording() ? "Press the new keys · Esc cancels" : "Click, then press the new keys"}
        onClick={() => (recording() ? recorder?.cancel() : record())}
      >
        {recording() ? "Press keys…" : display(key())}
      </button>
    </span>
  );
}

function ShortcutsPage(props: { filter: string }) {
  const groups = createMemo(() => {
    const text = props.filter.trim().toLowerCase();
    const rows = (Object.keys(actions) as Action[]).filter(
      (action) =>
        !text ||
        actions[action].label.toLowerCase().includes(text) ||
        display(preferences.keyFor(action)).toLowerCase().includes(text) ||
        preferences.keyFor(action).toLowerCase().includes(text),
    );
    return [...Map.groupBy(rows, (action) => actions[action].group)];
  });
  return (
    <>
      <p class="page-note">
        Click a shortcut and press the new keys. Keys another shortcut already uses are refused, and each one
        can go back to its default.
      </p>
      <For each={groups()} fallback={<p class="settings-empty">No shortcuts match.</p>}>
        {([group, rows]) => (
          <Group title={group}>
            <div class="settings-card">
              <For each={rows}>
                {(action) => (
                  <div class="setting">
                    <span class="setting-label">{actions[action].label}</span>
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
          <button class="reset" title="Back to the defaults" onClick={() => props.reset?.()}>
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
    <div class="setting">
      <span class="setting-text">
        <span class="setting-label">
          {props.label}
          <Show when={changed()}>
            <button
              class="reset"
              title="Back to the default"
              onClick={() => update(Object.fromEntries(props.keys.map((key) => [key, defaults[key]])))}
            >
              <Icon name="refresh" />
            </button>
          </Show>
        </span>
        <Show when={props.description}>
          <span class="setting-description">{props.description}</span>
        </Show>
      </span>
      {props.children}
    </div>
  );
}

function LayoutPage() {
  return (
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
        <Row label="Wrap long lines" description="Wrap lines instead of scrolling sideways." keys={["wrap"]}>
          <Toggle name="wrap" label="Wrap long lines" />
        </Row>
      </div>
    </Group>
  );
}

function DiffPage() {
  return (
    <Group title="Changes">
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
          label="Highlight changed words"
          description="Mark the words that changed within a line."
          keys={["wordDiff"]}
        >
          <Toggle name="wordDiff" label="Highlight changed words" />
        </Row>
        <Row
          label="Fold generated files"
          description="Open lockfiles, minified and generated files folded."
          keys={["foldGenerated"]}
        >
          <Toggle name="foldGenerated" label="Fold generated files" />
        </Row>
      </div>
    </Group>
  );
}

const pages: Array<{ id: string; title: string; icon: IconName; words: string }> = [
  { id: "themes", title: "Themes", icon: "brush", words: "appearance color scheme dark light mode palette" },
  {
    id: "typography",
    title: "Typography",
    icon: "type",
    words: "font size weight line height ligatures interface code",
  },
  { id: "layout", title: "Layout", icon: "sidebarLeft", words: "sidebar left right split unified wrap" },
  { id: "diff", title: "Diff", icon: "diffSplit", words: "change markers bars words generated fold" },
  { id: "shortcuts", title: "Shortcuts", icon: "key", words: "keyboard keys bindings hotkeys" },
];

const pageWords = (id: string) => {
  const found = pages.find((p) => p.id === id)!;
  return `${found.title} ${found.words}`.toLowerCase();
};

export function SettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [page, setPage] = createSignal(pages[0]!.id);
  const [query, setQuery] = createSignal("");
  let search: HTMLInputElement | undefined;

  // The search picks the page; on Shortcuts it also filters the list.
  const matching = createMemo(() => {
    const text = query().trim().toLowerCase();
    if (!text) return pages;
    const findsShortcut = (Object.keys(actions) as Action[]).some((action) =>
      `${actions[action].label} ${display(preferences.keyFor(action))}`.toLowerCase().includes(text),
    );
    return pages.filter(
      (p) => `${p.title} ${p.words}`.toLowerCase().includes(text) || (p.id === "shortcuts" && findsShortcut),
    );
  });
  const shown = () => (matching().some((p) => p.id === page()) ? page() : (matching()[0]?.id ?? page()));
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
                  onClick={() => setPage(candidate.id)}
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
            <Show when={shown() === "layout"}>
              <LayoutPage />
            </Show>
            <Show when={shown() === "diff"}>
              <DiffPage />
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

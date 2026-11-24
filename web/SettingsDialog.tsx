//! Settings: a centered dialog with a search across every setting (/ focuses
//! it), sections down the side, theme cards, typography, and a shortcut editor.
//! Every change applies at once and is saved by patchr for the next review.

import { type JSX } from "@solidjs/web";
import { formatForDisplay, HotkeyRecorder, type Hotkey } from "@tanstack/hotkeys";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/solid/dialog";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/solid/segmented-control";
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/solid/slider";
import { Switch, SwitchThumb } from "@ui-sdk/solid/switch";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import { actions, fontPresets, preferences, type Action, type Settings } from "./settings.ts";
import { themes, type Theme } from "./themes.gen.ts";

const { settings, update } = preferences;

function Choose<K extends keyof Settings>(props: {
  name: K;
  options: Array<{ value: Settings[K]; label: string }>;
  label: string;
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

function Range(props: { name: Numeric; label: string; min: number; max: number; unit?: string }) {
  return (
    <div class="range">
      <Slider
        class="slider"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={1}
        value={settings[props.name]}
        onValueChange={(value) => update({ [props.name]: value as number } as Partial<Settings>)}
      >
        <SliderControl class="slider-control">
          <SliderTrack class="slider-track">
            <SliderIndicator class="slider-indicator" />
            <SliderThumb class="slider-thumb" />
          </SliderTrack>
        </SliderControl>
      </Slider>
      <span class="range-value">
        {settings[props.name]}
        {props.unit ?? "px"}
      </span>
    </div>
  );
}

function ThemeCard(props: { theme: Theme; field: "lightTheme" | "darkTheme" }) {
  const c = () => props.theme.colors;
  const chosen = () => settings[props.field] === props.theme.id;
  return (
    <button
      class={{ "theme-card": true, chosen: chosen() }}
      aria-pressed={chosen() ? "true" : "false"}
      title={props.theme.name}
      onClick={() => update({ [props.field]: props.theme.id })}
    >
      <span class="theme-swatch" style={{ background: c().editor, color: c().text }}>
        <span class="theme-line" style={{ background: c().chrome }} />
        <span class="theme-row">
          <span class="theme-mark" style={{ background: c().del ?? "#d33" }} />
          <span class="theme-text">const a = 1</span>
        </span>
        <span class="theme-row">
          <span class="theme-mark" style={{ background: c().add ?? "#3a3" }} />
          <span class="theme-text">const a = 2</span>
        </span>
      </span>
      <span class="theme-name">{props.theme.name}</span>
    </button>
  );
}

function Themes(props: { field: "lightTheme" | "darkTheme" }) {
  const list = () => themes.filter((theme) => theme.dark === (props.field === "darkTheme"));
  return (
    <div class="theme-grid">
      <For each={list()}>{(theme) => <ThemeCard theme={theme} field={props.field} />}</For>
    </div>
  );
}

function Font(props: {
  field: "uiFont" | "codeFont";
  presets: ReadonlyArray<{ label: string; value: string }>;
}) {
  return (
    <div class="font-picker">
      <div class="chips">
        <For each={props.presets}>
          {(preset) => (
            <button
              class="chip"
              aria-pressed={settings[props.field] === preset.value ? "true" : "false"}
              style={{ "font-family": preset.value }}
              onClick={() => update({ [props.field]: preset.value })}
            >
              {preset.label}
            </button>
          )}
        </For>
      </div>
      <input
        class="field mono"
        spellcheck={false}
        aria-label="Font family"
        title="Any installed font: a CSS font-family list"
        value={settings[props.field]}
        onChange={(event) =>
          update({ [props.field]: event.currentTarget.value.trim() || preferences.settings[props.field] })
        }
        onKeyDown={(event) => event.stopPropagation()}
      />
    </div>
  );
}

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
  const custom = () => settings.keys[props.action] !== undefined;

  function record() {
    setProblem("");
    recorder?.destroy?.();
    recorder = new HotkeyRecorder({
      onRecord(hotkey) {
        const taken = (Object.keys(actions) as Action[]).find(
          (other) => other !== props.action && preferences.keyFor(other) === hotkey,
        );
        setRecording(false);
        if (taken) return setProblem(`Already used by “${actions[taken].label}”`);
        preferences.bind(props.action, hotkey);
      },
      onCancel: () => setRecording(false),
    });
    setRecording(true);
    recorder.start();
  }
  onCleanup(() => recorder?.destroy?.());

  return (
    <div class="binding">
      <button
        class={{ "key-button": true, recording: recording() }}
        aria-label={`${actions[props.action].label}: ${display(key())}`}
        title={recording() ? "Press the new keys · Esc cancels" : "Click to change"}
        onClick={() => (recording() ? recorder?.cancel() : record())}
      >
        <Show when={!recording()} fallback={<span class="muted">Press keys…</span>}>
          <For
            each={display(key())
              .split(/(?=[⌘⌥⇧⌃])|\+| /)
              .filter(Boolean)}
          >
            {(part) => <kbd>{part}</kbd>}
          </For>
        </Show>
      </button>
      <Show when={custom()}>
        <button
          class="icon-button"
          title={`Back to ${display(actions[props.action].key)}`}
          onClick={() => preferences.bind(props.action, undefined)}
        >
          <Icon name="refresh" />
        </button>
      </Show>
      <Show when={problem()}>
        <span class="binding-problem">{problem()}</span>
      </Show>
    </div>
  );
}

interface Row {
  label: string;
  /** Extra words the search finds it by. */
  words?: string;
  hint?: string;
  /** Draws the control under the label, across the full width. */
  wide?: boolean;
  control: () => JSX.Element;
}

const sections: Array<{ id: string; title: string; rows: Row[] }> = [
  {
    id: "appearance",
    title: "Appearance",
    rows: [
      {
        label: "Mode",
        words: "color scheme dark light system theme",
        control: () => (
          <Choose
            name="colorScheme"
            label="Mode"
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        ),
      },
      {
        label: "Light theme",
        words: "color scheme palette colors github catppuccin solarized one rose pine",
        wide: true,
        control: () => <Themes field="lightTheme" />,
      },
      {
        label: "Dark theme",
        words: "color scheme palette colors dracula nord tokyo night catppuccin gruvbox one dark",
        wide: true,
        control: () => <Themes field="darkTheme" />,
      },
    ],
  },
  {
    id: "typography",
    title: "Typography",
    rows: [
      {
        label: "Interface font",
        words: "typeface family text",
        wide: true,
        control: () => <Font field="uiFont" presets={fontPresets.ui} />,
      },
      {
        label: "Code font",
        words: "typeface family monospace mono",
        wide: true,
        control: () => <Font field="codeFont" presets={fontPresets.code} />,
      },
      {
        label: "Interface size",
        words: "text font size",
        control: () => <Range name="textSize" label="Interface size" min={11} max={17} />,
      },
      {
        label: "Code size",
        words: "font size diff",
        control: () => <Range name="codeSize" label="Code size" min={10} max={20} />,
      },
      {
        label: "Code line height",
        words: "spacing leading",
        control: () => <Range name="lineHeight" label="Code line height" min={14} max={32} />,
      },
      {
        label: "Ligatures",
        words: "font features arrows",
        hint: "Joins characters like => and != in fonts that support it",
        control: () => <Toggle name="ligatures" label="Ligatures" />,
      },
    ],
  },
  {
    id: "layout",
    title: "Layout",
    rows: [
      {
        label: "Sidebar",
        words: "side left right position files tree",
        control: () => (
          <Choose
            name="sidebarSide"
            label="Sidebar"
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
        ),
      },
      {
        label: "Diff layout",
        words: "split unified side by side",
        control: () => (
          <Choose
            name="layout"
            label="Diff layout"
            options={[
              { value: "auto", label: "Auto" },
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
          />
        ),
      },
      {
        label: "Wrap long lines",
        words: "overflow scroll",
        control: () => <Toggle name="wrap" label="Wrap long lines" />,
      },
    ],
  },
  {
    id: "diff",
    title: "Diff",
    rows: [
      {
        label: "Change markers",
        words: "indicators bars plus minus gutter",
        control: () => (
          <Choose
            name="indicators"
            label="Change markers"
            options={[
              { value: "bars", label: "Bars" },
              { value: "classic", label: "+ / −" },
            ]}
          />
        ),
      },
      {
        label: "Highlight changed words",
        words: "word diff inline",
        control: () => <Toggle name="wordDiff" label="Highlight changed words" />,
      },
      {
        label: "Fold generated files",
        words: "lockfiles minified collapse",
        hint: "Lockfiles, minified and generated files open folded",
        control: () => <Toggle name="foldGenerated" label="Fold generated files" />,
      },
    ],
  },
  {
    id: "keyboard",
    title: "Keyboard",
    rows: (Object.keys(actions) as Action[]).map((action) => ({
      label: actions[action].label,
      words: `shortcut key binding hotkey ${actions[action].key}`,
      control: () => <Binding action={action} />,
    })),
  },
];

export function SettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = createSignal("");
  let search: HTMLInputElement | undefined;
  let content: HTMLDivElement | undefined;

  const matches = (row: Row) => {
    const text = query().trim().toLowerCase();
    return !text || `${row.label} ${row.words ?? ""}`.toLowerCase().includes(text);
  };
  const visible = createMemo(() =>
    sections
      .map((section) => ({ ...section, rows: section.rows.filter(matches) }))
      .filter((s) => s.rows.length),
  );

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
        <header class="settings-head">
          <DialogTitle class="visually-hidden">Settings</DialogTitle>
          <Icon name="search" />
          <input
            ref={(element) => {
              search = element;
              requestAnimationFrame(() => element.focus());
            }}
            class="settings-search"
            type="search"
            placeholder="Search settings"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd>/</kbd>
          <DialogClose class="icon-button" aria-label="Close settings">
            <Icon name="x" />
          </DialogClose>
        </header>
        <div class="settings-main">
          <nav class="settings-nav" aria-label="Sections">
            <For each={sections}>
              {(section) => (
                <button
                  class="settings-nav-item"
                  disabled={!visible().some((shown) => shown.id === section.id)}
                  onClick={() =>
                    content?.querySelector(`#settings-${section.id}`)?.scrollIntoView({ block: "start" })
                  }
                >
                  {section.title}
                </button>
              )}
            </For>
          </nav>
          <div class="settings-content" ref={(element) => (content = element)}>
            <For each={visible()} fallback={<p class="empty">No settings match “{query()}”.</p>}>
              {(section) => (
                <section class="settings-section" id={`settings-${section.id}`}>
                  <h3>{section.title}</h3>
                  <For each={section.rows}>
                    {(row) => (
                      <div class={{ setting: true, wide: Boolean(row.wide) }} title={row.hint}>
                        <span class="setting-label">
                          {row.label}
                          <Show when={row.hint}>
                            <span class="setting-hint">{row.hint}</span>
                          </Show>
                        </span>
                        {row.control()}
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
        <footer class="settings-foot">
          <span class="hint">Saved for every review on this machine</span>
          <button class="link" onClick={() => preferences.reset()}>
            Reset to defaults
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

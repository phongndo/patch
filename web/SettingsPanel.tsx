//! The reviewer's settings, under the gear at the bottom of the sidebar. Every
//! change applies at once and is saved by patchr for the next review.

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/solid/segmented-control";
import { Switch, SwitchThumb } from "@ui-sdk/solid/switch";
import { type JSX } from "@solidjs/web";
import { For } from "solid-js";
import { Icon } from "./Icon.tsx";
import { preferences, type Settings } from "./settings.ts";

const shortcuts: Array<[keys: string, action: string]> = [
  ["J K", "Next or previous file"],
  ["C", "Comment on the selected lines"],
  ["V", "Mark the file viewed"],
  ["S", "Split or unified"],
  ["B", "Show or hide the sidebar"],
  ["R", "Refresh the diff"],
  ["/", "Search files and comments"],
  ["⌘ ↵", "Finish, then send"],
];

type Choice<K extends keyof Settings> = { value: Settings[K]; label: string };

function Choose<K extends keyof Settings>(props: { name: K; label: string; options: Choice<K>[] }) {
  // Four or more choices take the full width under their label, in equal columns.
  return (
    <div class={{ setting: true, stacked: props.options.length > 3 }}>
      <span class="setting-label">{props.label}</span>
      <SegmentedControl
        class="segmented setting-control"
        aria-label={props.label}
        value={String(preferences.settings[props.name])}
        onValueChange={(value) => {
          const option = props.options.find((choice) => String(choice.value) === value);
          if (option) preferences.update({ [props.name]: option.value } as Partial<Settings>);
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
    </div>
  );
}

function Toggle(props: {
  name: { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
  label: string;
  hint?: string;
}) {
  return (
    <label class="setting" title={props.hint}>
      <span class="setting-label">{props.label}</span>
      <Switch
        class="switch"
        checked={preferences.settings[props.name]}
        onCheckedChange={(checked) => preferences.update({ [props.name]: checked } as Partial<Settings>)}
      >
        <SwitchThumb class="switch-thumb" />
      </Switch>
    </label>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

export function SettingsPanel() {
  return (
    <Popover>
      <PopoverTrigger class="icon-button" title="Settings">
        <Icon name="gear" />
      </PopoverTrigger>
      <PopoverContent class="menu settings" side="top" align="start" sideOffset={6}>
        <PopoverTitle class="menu-title">Settings</PopoverTitle>
        <div class="settings-body">
          <Section title="Appearance">
            <Choose
              name="colorScheme"
              label="Color scheme"
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <Choose
              name="palette"
              label="Diff colors"
              options={[
                { value: "", label: "Default" },
                { value: "soft", label: "Soft" },
                { value: "vibrant", label: "Vivid" },
                { value: "protanopia-deuteranopia", label: "Red-green" },
                { value: "tritanopia", label: "Blue-yellow" },
              ]}
            />
            <Choose
              name="font"
              label="Text font"
              options={[
                { value: "geist", label: "Geist" },
                { value: "system", label: "System" },
              ]}
            />
            <Choose
              name="codeFont"
              label="Code font"
              options={[
                { value: "geist", label: "Geist Mono" },
                { value: "system", label: "System" },
              ]}
            />
            <Choose
              name="textSize"
              label="Text size"
              options={[
                { value: 12, label: "Small" },
                { value: 13, label: "Medium" },
                { value: 14, label: "Large" },
              ]}
            />
            <Choose
              name="codeSize"
              label="Code size"
              options={[
                { value: 12, label: "Small" },
                { value: 13, label: "Medium" },
                { value: 14, label: "Large" },
              ]}
            />
          </Section>

          <Section title="Layout">
            <Choose
              name="sidebarSide"
              label="Sidebar"
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
            />
            <Choose
              name="layout"
              label="Diff layout"
              options={[
                { value: "auto", label: "Auto" },
                { value: "split", label: "Split" },
                { value: "unified", label: "Unified" },
              ]}
            />
            <Toggle name="wrap" label="Wrap long lines" />
          </Section>

          <Section title="Diff">
            <Choose
              name="indicators"
              label="Change markers"
              options={[
                { value: "bars", label: "Bars" },
                { value: "classic", label: "+ / −" },
              ]}
            />
            <Toggle name="wordDiff" label="Highlight changed words" />
            <Toggle
              name="foldGenerated"
              label="Fold generated files"
              hint="Lockfiles, minified and generated files open folded"
            />
          </Section>
          <Section title="Keyboard">
            <dl class="shortcuts">
              <For each={shortcuts}>
                {([keys, action]) => (
                  <>
                    <dt>{action}</dt>
                    <dd>
                      <For each={keys.split(" ")}>{(key) => <kbd>{key}</kbd>}</For>
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </Section>
        </div>
        <footer class="settings-foot">
          <span class="hint">Saved for every review on this machine</span>
          <button class="link" onClick={() => preferences.reset()}>
            Reset to defaults
          </button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}

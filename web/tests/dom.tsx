import { render, type JSX } from "@solidjs/web";
import { flush } from "solid-js";

const disposers = new Set<() => void>();

export function mount(view: () => JSX.Element) {
  const host = document.body.appendChild(document.createElement("div"));
  const dispose = render(view, host);
  disposers.add(() => {
    dispose();
    host.remove();
  });
  return host;
}

export function unmountAll() {
  for (const dispose of disposers) dispose();
  disposers.clear();
}

export async function settle(ms = 30) {
  flush();
  await new Promise((resolve) => setTimeout(resolve, ms));
  flush();
}

export const $ = <T extends HTMLElement>(selector: string) => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Nothing matches ${selector}`);
  return found;
};

export async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, ...init }));
  await settle();
  return event;
}

export async function click(target: HTMLElement) {
  target.focus();
  target.click();
  await settle();
}

export async function type(input: HTMLInputElement, value: string) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  await settle();
}

export const named = (role: string, name: string) => {
  const native: Record<string, string> = { button: "button", textbox: "input" };
  const found = [
    ...document.querySelectorAll<HTMLElement>(`[role="${role}"], ${native[role] ?? ":not(*)"}`),
  ].find((element) => nameOf(element) === name);
  if (!found) throw new Error(`No ${role} named ${name}`);
  return found;
};

export function nameOf(element: HTMLElement) {
  const by = element.getAttribute("aria-labelledby");
  if (by)
    return by
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  const label = (element as HTMLInputElement).labels?.[0]?.textContent;
  return (element.getAttribute("aria-label") ?? label ?? element.textContent ?? "").trim();
}

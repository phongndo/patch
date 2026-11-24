import { afterEach, vi } from "vitest";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}
globalThis.__UI_SDK_STRICT__ = true;

HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.EventSource = class extends EventTarget {
  static CLOSED = 2;
  static last: EventTarget & { readyState: number; onerror: (() => void) | null };
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor() {
    super();
    (globalThis.EventSource as unknown as { last: unknown }).last = this;
  }
  close() {}
} as unknown as typeof EventSource;
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;
document.head.append(
  Object.assign(document.createElement("style"), {
    textContent: "[popover] { display: block !important }",
  }),
);

const { unmountAll } = await import("./dom.tsx");
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

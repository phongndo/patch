import type {
  PullRequest,
  ReviewResponse,
  Scope,
  ScopesResponse,
  Submission,
  UnchangedFiles,
  GrepMatch,
} from "../src/protocol.ts";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Patch could not read that.");
  return body as T;
}

export function scopeQuery(scope: Scope): URLSearchParams {
  const params = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === "commits") {
    params.set("from", scope.from);
    params.set("to", scope.to);
  } else if (scope.kind === "pr") params.set("pr", String(scope.number));
  else if (scope.base) params.set("base", scope.base);
  return params;
}

export const loadReview = (scope?: Scope) =>
  getJson<ReviewResponse>(scope ? `/api/review?${scopeQuery(scope)}` : "/api/review");

export const loadScopes = (base?: string) =>
  getJson<ScopesResponse>(base ? `/api/scopes?${new URLSearchParams({ base })}` : "/api/scopes");

export const loadPullRequests = (query: string) =>
  getJson<PullRequest[]>(`/api/prs?${new URLSearchParams({ q: query })}`);

export const loadSide = async (key: string, side: "old" | "new", path: string) => {
  const response = await fetch(`/api/file?${new URLSearchParams({ key, side, path })}`);
  return response.ok ? response.text() : "";
};

export const loadUnchanged = (key: string) =>
  getJson<UnchangedFiles>(`/api/unchanged?${new URLSearchParams({ key })}`);

export const loadGrep = (key: string, text: string) =>
  getJson<GrepMatch[]>(`/api/grep?${new URLSearchParams({ key, q: text })}`);

/** A file the review leaves alone, whole. */
export async function loadUnchangedFile(key: string, path: string): Promise<string> {
  const response = await fetch(`/api/unchanged/file?${new URLSearchParams({ key, path })}`);
  if (response.ok) return response.text();
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error ?? "Patch could not read that.");
}

// Names this load of the page, so Patch knows which one left and which went quiet.
// Not crypto.randomUUID: a remote review's page is plain HTTP, which lacks it.
const page = Math.random().toString(36).slice(2);
let unsent = () => false;

addEventListener("pagehide", (event: PageTransitionEvent) => {
  // Tell Patch the page is really going (closed or reloaded), so it can end
  // the review at once. A tab that only sleeps sends nothing and is waited for.
  if (event.persisted) return;
  const params = new URLSearchParams(unsent() ? { page, unsent: "1" } : { page });
  navigator.sendBeacon(`/api/leave?${params}`, new Blob(["{}"], { type: "application/json" }));
});

export async function submit(submission: Submission) {
  const gone = "Patch is no longer running. Copy your feedback to send it yourself.";
  const response = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  }).catch(() => {
    throw new Error(gone);
  });
  if (!response.ok) throw new Error(gone);
}

/** Holds a stream open so Patch can tell when the tab is gone, and hears when the repository changes. */
export function stayConnected(hear: {
  lost: () => void;
  back: () => void;
  changed: () => void;
  unsent: () => boolean;
}) {
  unsent = hear.unsent;
  let source: EventSource;
  // Chrome retries a server that is gone forever without closing the stream.
  let silent: ReturnType<typeof setTimeout> | undefined;
  let again: ReturnType<typeof setTimeout> | undefined;
  function connect() {
    clearTimeout(again);
    source = new EventSource(`/api/live?${new URLSearchParams({ page })}`);
    source.addEventListener("changed", hear.changed);
    source.onopen = () => {
      clearTimeout(silent);
      silent = undefined;
      hear.back();
    };
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) {
        silent ??= setTimeout(hear.lost, 4000);
        return;
      }
      // The browser gave up, as over a network that slept; the review may still be there.
      hear.lost();
      clearTimeout(again);
      again = setTimeout(connect, 2000);
    };
  }
  connect();
  const onShow = (event: PageTransitionEvent) => {
    if (event.persisted && source.readyState === EventSource.CLOSED) connect();
  };
  addEventListener("pageshow", onShow);
  return () => {
    removeEventListener("pageshow", onShow);
    clearTimeout(silent);
    clearTimeout(again);
    source.close();
  };
}

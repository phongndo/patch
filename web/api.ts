import type {
  Draft,
  PullRequest,
  ReviewResponse,
  Scope,
  ScopesResponse,
  Submission,
} from "../src/protocol.ts";

const send = (path: string, method: string, body: unknown) =>
  fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  });

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

let pending: ReturnType<typeof setTimeout> | undefined;
let flush: (() => void) | undefined;

/** Saves the draft a moment after the last change, and right away when the page hides. */
export function saveDraft(key: string, draft: Draft) {
  clearTimeout(pending);
  flush = () => {
    flush = undefined;
    void send(`/api/draft?key=${key}`, "PUT", draft);
  };
  pending = setTimeout(flush, 400);
}
addEventListener("pagehide", (event: PageTransitionEvent) => {
  flush?.();
  // Tell Patch the page is really going (closed or reloaded), so it can end
  // the review soon. A tab that only sleeps sends nothing and is waited for.
  if (!event.persisted) navigator.sendBeacon("/api/leave", new Blob(["{}"], { type: "application/json" }));
});

export async function submit(key: string, submission: Submission) {
  clearTimeout(pending);
  flush = undefined;
  const response = await send(`/api/submit?key=${key}`, "POST", submission);
  if (!response.ok) throw new Error("Patch is no longer running. Your comments are saved in the draft.");
}

/** Holds a stream open so the server can tell when the tab is gone. */
/** Holds a stream open so Patch can tell when the tab is gone, and hears when the repository changes. */
export function stayConnected(onLost: () => void, onChanged: () => void) {
  const source = new EventSource("/api/live");
  source.addEventListener("changed", onChanged);
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onLost();
  };
  return () => source.close();
}

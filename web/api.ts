import type { PullRequest, ReviewResponse, Scope, ScopesResponse, Submission } from "../src/protocol.ts";

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

addEventListener("pagehide", (event: PageTransitionEvent) => {
  // Tell Patch the page is really going (closed or reloaded), so it can end
  // the review soon. A tab that only sleeps sends nothing and is waited for.
  if (!event.persisted) navigator.sendBeacon("/api/leave", new Blob(["{}"], { type: "application/json" }));
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
export function stayConnected(hear: { lost: () => void; back: () => void; changed: () => void }) {
  const source = new EventSource("/api/live");
  source.addEventListener("changed", hear.changed);
  // Chrome retries a server that is gone forever without closing the stream.
  let silent: ReturnType<typeof setTimeout> | undefined;
  source.onopen = () => {
    clearTimeout(silent);
    silent = undefined;
    hear.back();
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) hear.lost();
    else silent ??= setTimeout(hear.lost, 4000);
  };
  return () => {
    clearTimeout(silent);
    source.close();
  };
}

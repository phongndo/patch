import type {
  CommitsResponse,
  PullRequestsResponse,
  ReviewResponse,
  Scope,
  ScopesResponse,
  Submission,
  UnchangedFiles,
  GrepMatch,
} from "../src/protocol.ts";

declare global {
  interface Window {
    /** The first review, asked for by index.html before any script loaded. */
    __PATCH_REVIEW__?: Promise<Response>;
  }
}

/** A request with no answer at all: the network is down, or the review ended with its server. */
const UNREACHABLE = "Can't reach this Patch review. Check the connection, or start a new review.";

async function getJson<T>(path: string, request: Promise<Response> = fetch(path)): Promise<T> {
  const response = await request.catch((error: unknown) => {
    // A request called off was meant to stop; it says nothing of Patch.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(UNREACHABLE);
  });
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

export function loadReview(scope?: Scope) {
  const early = scope ? undefined : window.__PATCH_REVIEW__;
  window.__PATCH_REVIEW__ = undefined;
  return getJson<ReviewResponse>(scope ? `/api/review?${scopeQuery(scope)}` : "/api/review", early);
}

export const loadScopes = (base?: string) =>
  getJson<ScopesResponse>(base ? `/api/scopes?${new URLSearchParams({ base })}` : "/api/scopes");

/** A page of commits or pull requests: what `query` finds, from where the last page ended. */
function listPage<T>(path: string, query: string, after: string | undefined, signal: AbortSignal) {
  const url = `${path}?${new URLSearchParams({ q: query, ...(after ? { after } : {}) })}`;
  return getJson<T>(url, fetch(url, { signal }));
}

export const loadCommits = (query: string, after: string | undefined, signal: AbortSignal) =>
  listPage<CommitsResponse>("/api/commits", query, after, signal);

export const loadPullRequests = (query: string, after: string | undefined, signal: AbortSignal) =>
  listPage<PullRequestsResponse>("/api/prs", query, after, signal);

export const loadSide = async (key: string, side: "old" | "new", path: string) => {
  const response = await fetch(`/api/file?${new URLSearchParams({ key, side, path })}`);
  return response.ok ? response.text() : "";
};

/**
 * One side of a changed file, read only if it is at most `max` bytes: its text, or the status it
 * could not be read with (413 for too long), never mistaken for an empty file.
 */
export const loadSideText = async (key: string, side: "old" | "new", path: string, max: number) => {
  const query = new URLSearchParams({ key, side, path, max: String(max) });
  const response = await fetch(`/api/file?${query}`).catch(() => undefined);
  return { status: response?.status ?? 0, text: response?.ok ? await response.text() : undefined };
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
  if (response.status === 409) {
    const { error } = await response.json().catch(() => ({ error: "" }));
    throw new Error(`${error || "This review has already ended."} Copy your feedback to send it yourself.`);
  }
  if (!response.ok) throw new Error(gone);
}

/** Holds a stream open so Patch can tell when the tab is gone, and hears when the repository changes. */
export function stayConnected(hear: {
  lost: () => void;
  back: () => void;
  changed: () => void;
  /** The run of Patch the stream reached, each time it connects. */
  session: (session: string) => void;
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
    source.addEventListener("session", (event) => hear.session((event as MessageEvent<string>).data));
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { readGitReview } from "./git.ts";
import type { ReviewMode } from "../src/review/types.ts";

export function reviewApi(directory: string, base = "main") {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/review") return false;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405).end(JSON.stringify({ error: "Method not allowed." }));
      return true;
    }
    if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
      response.writeHead(403).end(JSON.stringify({ error: "Open Patch from its local address." }));
      return true;
    }
    const mode = url.searchParams.get("mode") ?? "working";
    if (!["working", "staged", "branch"].includes(mode)) {
      response.writeHead(400).end(JSON.stringify({ error: "Unknown review mode." }));
      return true;
    }
    try {
      const review = await readGitReview(directory, mode as ReviewMode, base);
      response.end(JSON.stringify(review));
    } catch (error) {
      response.writeHead(422).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unable to read the repository.",
        }),
      );
    }
    return true;
  };
}

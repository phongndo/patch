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
    // A loopback listener can still receive a foreign Host through DNS
    // rebinding. Check it even when the client sends no Origin header.
    const host = request.headers.host;
    const address = host ? URL.parse(`http://${host}`) : null;
    const origin = request.headers.origin ? URL.parse(request.headers.origin) : null;
    if (
      !address ||
      address.host !== host ||
      !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) ||
      (request.headers.origin && (!origin || origin.protocol !== "http:" || origin.host !== host))
    ) {
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

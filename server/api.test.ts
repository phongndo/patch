import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { reviewApi } from "./api.ts";

test("review API rejects malformed and foreign origins without throwing", async () => {
  const api = reviewApi(".");
  let failure: unknown;
  const server = createServer((incoming, response) => {
    void api(incoming, response).catch((error: unknown) => {
      failure = error;
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const [origin, host, expected] of [
      ["null", `127.0.0.1:${port}`, 403],
      ["not a URL", `127.0.0.1:${port}`, 403],
      ["https://foreign.invalid", `127.0.0.1:${port}`, 403],
      [`ftp://127.0.0.1:${port}`, `127.0.0.1:${port}`, 403],
      ["http://foreign.invalid", "foreign.invalid", 403],
      [undefined, "foreign.invalid", 403],
      [undefined, `127.0.0.1:${port}`, 400],
      [`http://localhost:${port}`, `localhost:${port}`, 400],
    ] as const) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/review?mode=invalid",
            headers: { ...(origin ? { Origin: origin } : {}), Host: host },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.equal(status, expected, origin);
    }
    assert.equal(failure, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { reviewApi } from "./api.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const repository = resolve(
  args.find(
    (arg, index) => !arg.startsWith("-") && !["--port", "--base"].includes(args[index - 1] ?? ""),
  ) ?? process.cwd(),
);
const port = Number(option("--port", "4173"));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Choose a port between 1 and 65535.");
const directory = fileURLToPath(new URL("../dist/", import.meta.url));
try {
  await stat(resolve(directory, "index.html"));
} catch {
  throw new Error("Build Patch first with pnpm build.");
}
const api = reviewApi(repository, option("--base", "main"));
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const server = createServer(async (request, response) => {
  try {
    if (await api(request, response)) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    let file = resolve(directory, `.${path}`);
    if (file !== resolve(directory) && !file.startsWith(`${resolve(directory)}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) file = resolve(directory, "index.html");
    } catch {
      file = extname(path) ? "" : resolve(directory, "index.html");
    }
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Cache-Control",
      file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    );
    const bytes = await readFile(file);
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(500).end("Unable to serve this request.");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Patch  ${url}\n  Repository: ${repository}\n`);
  if (!args.includes("--no-open")) {
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  }
});

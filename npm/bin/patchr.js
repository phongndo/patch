#!/usr/bin/env node
// Runs the binary npm installed for this platform.
const { spawn } = require("node:child_process");

const platform = `${process.platform}-${process.arch}`;
let binary;
try {
  binary = require.resolve(`@phongndo/patchr-${platform}/bin/patchr`);
} catch {
  console.error(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(platform)
      ? `patchr: the ${platform} binary is missing. Install again without --omit=optional.`
      : `patchr: there is no build for ${platform}. Patch runs on macOS and Linux, on arm64 and x64.`,
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
/** @type {NodeJS.Signals[]} */
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`patchr: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});

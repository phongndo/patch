// OpenCode 2's `/patch`, written by `patchr install`: runs `patchr review`
// beside the session instead of inside a model turn, then sends the feedback as
// the user's message. Plugins run in OpenCode's background service, so the
// directory is the session's, never this process's.
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";

const PATCHR = "patchr"; // install writes the binary's full path here
const EDITS = new Set(["edit", "write", "patch", "apply_patch"]);

type Context = Parameters<Plugin.Plugin["setup"]>[0];

/** The file the agent last changed, whose repository may not be the session's. */
async function lastEdited(ctx: Context, sessionID: string, cwd: string): Promise<string | undefined> {
  const messages = await ctx.session.context({ sessionID });
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue;
    for (const part of message.content.toReversed()) {
      if (part.type !== "tool" || !EDITS.has(part.name) || part.state.status !== "completed") continue;
      const { filePath, path = filePath, patchText } = part.state.input;
      const patched =
        typeof patchText === "string"
          ? [...patchText.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].at(-1)?.[1]
          : undefined;
      const file = typeof path === "string" ? path : patched;
      if (file) return resolve(cwd, file.trim());
    }
  }
  return undefined;
}

export default {
  id: "patch",
  setup: async (ctx: Context) => {
    const open = new Map<string, { child: ChildProcess; url: string }>();

    // Shown in the session without starting a turn, and kept from the model below. In a running
    // turn the notice would make the model answer it, so it waits for the end.
    async function notice(sessionID: string, text: string, current = () => true) {
      await ctx.session.wait({ sessionID }).catch(() => undefined);
      if (!current()) return;
      await ctx.session
        .synthetic({ sessionID, text, description: text, metadata: { patch: "notice" }, resume: false })
        .catch(() => undefined);
    }

    await ctx.session.hook("context", (request) => {
      const kept = request.messages.filter((message) => message.metadata?.patch !== "notice");
      // A request must not end with the model's own words.
      if (kept.at(-1)?.role !== "assistant") request.messages = kept;
    });

    /** Sends the feedback, then lets go of the file that keeps it until then. */
    async function deliver(sessionID: string, output: string) {
      let kept = "";
      try {
        const { receipt, text, file } = JSON.parse(output);
        kept = file ? ` It is kept in ${file}` : "";
        const idle = await Promise.race([
          ctx.session.wait({ sessionID }).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, 250, false)),
        ]);
        // While the agent works OpenCode stores the queued message for after it. Once idle, steering
        // takes a waiting notice along; queued, each would get a turn of its own.
        await ctx.session.prompt({ sessionID, text, delivery: idle ? "steer" : "queue" });
        spawn(PATCHR, ["hook", "delivered", receipt], { stdio: "ignore" }).on("error", () => {});
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await notice(sessionID, `Your feedback was not sent (${why}).${kept}`);
      }
    }

    async function review(sessionID: string, typed: string) {
      const current = open.get(sessionID);
      if (current) {
        // Its tab may be gone.
        if (current.url)
          spawn(PATCHR, ["hook", "reopen", current.url], { stdio: "ignore" }).on("error", () => {});
        await notice(
          sessionID,
          current.url ? `Patch is already open at ${current.url}` : "Patch is already opening.",
        );
        return;
      }
      const run: { child?: ChildProcess; url: string } = { url: "" };
      open.set(sessionID, run as { child: ChildProcess; url: string });
      const session = await ctx.session.get({ sessionID }).catch(() => undefined);
      const cwd = session?.location.directory ?? ctx.location.directory;
      const near = await lastEdited(ctx, sessionID, cwd).catch(() => undefined);
      if (open.get(sessionID) !== run) return; // the plugin was unloaded meanwhile
      const args = ["review", "--typed", typed, ...(near ? ["--near", near] : [])];
      const child = spawn(PATCHR, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      run.child = child;
      let output = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => (output += text));
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
        const url = /Patch is open at (\S+)\s/.exec(stderr)?.[1];
        if (!url || run.url) return;
        run.url = url;
        void notice(sessionID, `Patch is open at ${url}`, () => open.get(sessionID) === run);
      });
      const finish = (failure?: string) => {
        if (open.get(sessionID) !== run) return;
        open.delete(sessionID);
        if (failure) void notice(sessionID, failure);
        else if (output.trim()) void deliver(sessionID, output);
      };
      child.on("error", (error) => finish(`Could not run ${PATCHR}: ${error.message}`));
      child.on("close", (code, signal) =>
        finish(code === 0 ? undefined : stderr.trim() || `patchr ended with ${signal ?? code}.`),
      );
    }

    await ctx.command.transform((commands) =>
      commands.add({
        name: "patch",
        description: "Review the current changes in Patch, a browser diff viewer",
        // Not awaited: the session stays free while the review is open.
        execute: async ({ sessionID, prompt }) => void review(sessionID, prompt.text),
      }),
    );

    return () => {
      const runs = [...open.values()];
      open.clear();
      for (const run of runs) run.child?.kill();
    };
  },
};

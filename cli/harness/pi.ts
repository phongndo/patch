// Pi's `/patch`, written by `patchr install`: runs `patchr review` beside the
// session instead of inside a model turn, then sends the feedback as the user's
// message. No model or shell timeout is involved while the review is open.
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const PATCHR = "patchr"; // install writes the binary's full path here

/** The file the agent last changed, whose repository may not be where Pi started. */
function lastEdited(ctx: ExtensionCommandContext): string | undefined {
  const done = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "toolResult" && !message.isError) done.add(message.toolCallId);
    const calls =
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "toolCall" && done.has(part.id))
        : message.role === "toolResult"
          ? (message.nestedCalls?.calls ?? []).filter((call) => call.status === "ok")
          : [];
    for (const call of calls.toReversed()) {
      if (!("arguments" in call) || (call.name !== "edit" && call.name !== "write")) continue;
      const path = call.arguments?.path;
      if (typeof path === "string") return path.startsWith("~") ? path : resolve(ctx.cwd, path);
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let open: { child: ChildProcess; url: string } | undefined;

  function notify(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error") {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else console.error(text);
  }

  /** Sends the feedback, then lets go of the file that keeps it until then. */
  function deliver(ctx: ExtensionCommandContext, output: string) {
    let kept = "";
    try {
      const { receipt, text, file } = JSON.parse(output);
      kept = file ? ` It is kept in ${file}` : "";
      // followUp only matters while the agent is working; when idle this starts a turn.
      pi.sendUserMessage(text, { deliverAs: "followUp" });
      spawn(PATCHR, ["hook", "delivered", receipt], { stdio: "ignore" }).on("error", () => {});
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      notify(ctx, `Your feedback was not sent (${why}).${kept}`, "error");
    }
  }

  function review(typed: string, ctx: ExtensionCommandContext): Promise<void> {
    const near = lastEdited(ctx);
    const args = ["review", "--typed", typed, ...(near ? ["--near", near] : [])];
    const child = spawn(PATCHR, args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const run = { child, url: "" };
    open = run;
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (output += text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
      const url = /Patch is open at (\S+)\s/.exec(stderr)?.[1];
      if (!url || run.url || open !== run) return;
      run.url = url;
      notify(ctx, `Patch is open at ${url}`, "info");
      ctx.ui.setStatus("patch", "Patch review open");
    });

    return new Promise((done) => {
      const finish = (failure?: string) => {
        // After a reload or session switch this ctx is stale and must not be used.
        if (open === run) {
          open = undefined;
          ctx.ui.setStatus("patch", undefined);
          if (failure) notify(ctx, failure, "error");
          else if (output.trim()) deliver(ctx, output);
          else notify(ctx, "Patch closed without feedback.", "info");
        }
        done();
      };
      child.on("error", (error) => finish(`Could not run ${PATCHR}: ${error.message}`));
      child.on("close", (code, signal) =>
        finish(code === 0 ? undefined : stderr.trim() || `patchr ended with ${signal ?? code}.`),
      );
    });
  }

  pi.registerCommand("patch", {
    description: "Review the current changes in Patch, a browser diff viewer",
    handler: async (typed, ctx) => {
      if (open) {
        // Its tab may be gone.
        if (open.url) spawn(PATCHR, ["hook", "reopen", open.url], { stdio: "ignore" }).on("error", () => {});
        notify(
          ctx,
          open.url ? `Patch is already open at ${open.url}` : "Patch is already opening.",
          "warning",
        );
        return;
      }
      const done = review(typed, ctx);
      // Without a UI, Pi exits once the command returns: wait out the review and the turn it starts.
      if (ctx.hasUI) return;
      await done;
      await new Promise((started) => setTimeout(started, 250)); // sendUserMessage starts its run later
      await ctx.waitForIdle();
    },
  });

  // The open tab keeps its comments and can copy them.
  pi.on("session_shutdown", () => {
    const run = open;
    open = undefined;
    run?.child.kill();
  });
}

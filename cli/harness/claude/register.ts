// Claude Code's `/patch`, written by `patchr install`: answers the command
// itself and runs `patchr review` beside the session, then submits the feedback
// as the user's prompt. Where this module does not run (`claude -p`, hosts
// without mods), the `/patch` skill next to it has the model run the review.
import type { CommandRunResult, EngineInterface, Register } from "claude-code";

const PATCHR = "patchr"; // install writes the binary's full path here
/** What `patchr review` says on stderr when a review passed: nothing is sent, so no turn starts. */
const PASSED = "The review passed.";

/** Submits the feedback, then lets go of the file that keeps it until then. */
async function deliver($: EngineInterface, output: string) {
  let why = "";
  let kept = "";
  try {
    const { receipt, text, file } = JSON.parse(output);
    kept = file ? ` It is kept in ${file}` : "";
    const sent = await $.prompt.submit({ text, asUser: true });
    if (sent.drop === undefined) {
      await $.process.run([PATCHR, "hook", "delivered", receipt]).catch(() => undefined);
      return;
    }
    why = sent.drop;
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  $.ui.toast(`Your feedback was not sent (${why}).${kept}`);
}

/** The command's answer, for the user only. In a running turn the model would read its text. */
function answerWith($: EngineInterface, text: string, working: boolean): CommandRunResult {
  if (!working) return { text, isTextDisplayOnly: true };
  $.ui.toast(text);
  return {};
}

export const register: Register = (on) => {
  let interactive = false;
  let working = false;
  let open: { url: string } | undefined;

  on("session.start", async ($, e, next) => {
    interactive = e.isInteractive;
    // The skill's command waits for a running turn to end; this one opens at once.
    if (interactive) {
      await $.command.register({
        name: "patch",
        description: "Review the current changes in Patch, a browser diff viewer",
        argumentHint: "[directory] [--base ref]",
        immediate: true,
      });
    }
    return next(e);
  });

  on("turn.start", ($, e, next) => {
    working ||= !e.agentId;
    return next(e);
  });
  on("turn.complete", ($, e, next) => {
    working &&= !!e.agentId; // a subagent's turn ends inside the main one
    return next(e);
  });

  // The fallback's own entry, which that command replaces here.
  on("command.describe", { command: "patch:patch" }, ($, e, next) =>
    next(interactive ? { ...e, isHidden: true } : e),
  );

  on("command.run", { command: "patch" }, async ($, e, next) => {
    if (!interactive) return next(e);
    if (open) {
      // Its tab may be gone.
      if (open.url) await $.process.run([PATCHR, "hook", "reopen", open.url]).catch(() => undefined);
      const text = open?.url ? `Patch is already open at ${open.url}` : "Patch is already opening.";
      return answerWith($, text, working);
    }
    const run = { url: "" };
    open = run;

    // The file the agent last changed, whose repository may not be the session's.
    const messages = await $.session.messages({ last: 400 });
    const near = ("deny" in messages ? [] : messages)
      .flatMap((message) => message.toolUses)
      .filter((use) => ["Edit", "Write", "NotebookEdit"].includes(use.tool))
      .filter((use) => use.text !== undefined && !use.isError)
      .map((use) => use.input.file_path ?? use.input.notebook_path)
      .findLast((path) => typeof path === "string");
    const argv = [PATCHR, "review", "--typed", e.args, ...(typeof near === "string" ? ["--near", near] : [])];

    const text = await new Promise<string>((answer) => {
      void (async () => {
        let output = "";
        let stderr = "";
        let failure = "";
        try {
          const child = $.process.spawn({ argv });
          for (;;) {
            const piece = await child.next();
            if (piece.done) {
              const { code, signal } = piece.value;
              if (code !== 0) failure = stderr.trim() || `patchr ended with ${signal ?? code}.`;
              break;
            }
            if (piece.value.stream === "stdout") output += piece.value.text;
            else stderr += piece.value.text;
            const url = /Patch is open at (\S+)\s/.exec(stderr)?.[1];
            if (!url || run.url) continue;
            run.url = url;
            $.ui.status(`Patch review open at ${url}`);
            answer(`Patch is open at ${url}`);
          }
        } catch (error) {
          failure = `Could not run ${PATCHR}: ${error instanceof Error ? error.message : String(error)}`;
        }
        open = undefined;
        $.ui.status(undefined);
        // The command has answered once the URL is known; later news is a toast.
        if (failure && !run.url) answer(failure);
        else if (failure) $.ui.toast(failure);
        else if (output.trim()) await deliver($, output);
        else if (stderr.includes(PASSED)) $.ui.toast(PASSED);
        else $.ui.toast("Patch closed without feedback.");
      })();
    });
    return answerWith($, text, working);
  });
};

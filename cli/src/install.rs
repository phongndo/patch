//! Adds `/patch` to every agent harness on this machine. Each harness gets the
//! same instructions in the file format it reads; nothing else is touched.

use std::path::{Path, PathBuf};

const DESCRIPTION: &str = "Review the current changes in Patch, a browser diff viewer, then act on the feedback.";

const WHERE: &str = "Pick the repository first. Use the directory the user names in the arguments; otherwise the Git repository you have been working in during this conversation; otherwise the current directory. Pass it as the first argument whenever it is not the current directory. If none of these is a Git repository, ask the user which one to review instead of running the command.";

const LINK: &str = "The command first prints `Patch is open at <url>` on stderr. When no browser opens on the user's screen, as over SSH or on a remote machine, read that line and give the user the URL.";

const OUTCOMES: &str = "Then act on its stdout:

- Feedback or comments: address every one now, then summarize what you changed.
- Approved with no comments: say the review passed and continue.
- Closed without feedback: say so in one sentence and stop. Closing is not approval.
- If the command was cut off by a timeout, run it again: the user's comments are restored from their draft.";

const OPTIONS: &str = "Arguments: a directory to review, `--base <ref>` to compare against another branch, `--uncommitted` or `--staged` to narrow the change, `--remote` to serve the page to another device over Tailscale. Run the command yourself; never ask the user to.";

fn task(command: &str) -> String {
    format!(
        "{WHERE}

Run `{command}` in the foreground and wait for it to finish. It opens the diff in the browser and blocks until the user submits, which can take a long time: use the longest timeout your shell tool allows, or none.

{LINK}

{OUTCOMES}

Patch serves the page from a local port. In a sandboxed shell (Codex), run the command with escalated permissions, since a sandbox that blocks local ports makes it fail at once.

{OPTIONS}"
    )
}

fn skill() -> String {
    format!(
        "---
name: patch
description: {DESCRIPTION}
disable-model-invocation: true
---

# Patch

{}
",
        task("patchr review $ARGUMENTS")
    )
}

// The model runs the command, not a pre-run `!` line, so it can review the
// repository it has been working in rather than the session's start folder.
fn claude_skill() -> String {
    format!(
        "---
name: patch
description: {DESCRIPTION}
allowed-tools: Bash(patchr:*)
disable-model-invocation: true
---

# Patch review

{WHERE}

Run `patchr review [directory] $ARGUMENTS` with the Bash tool, `run_in_background: true` and `timeout: 7200000`. It opens the diff in the browser and waits for the user, which can take a long time. Don't poll it or start a second one.

{LINK} Its output file holds that line as soon as the command starts. Then end your turn and act when it finishes.

{OUTCOMES}

{OPTIONS}
"
    )
}

fn markdown_command() -> String {
    format!("---\ndescription: {DESCRIPTION}\n---\n\n{}\n", task("patchr review $ARGUMENTS"))
}

fn gemini_command() -> String {
    format!(
        r#"description = "{DESCRIPTION}"
prompt = """
## Patch review

!{{patchr review {{{{args}}}}}}

## Your task

If the review above has feedback or comments, address every one now, then summarize what you changed. If it was approved with no comments, say the review passed and continue. If it was closed without feedback, or is empty, say so in one sentence and stop: closing is not approval.
"""
"#
    )
}

pub struct Target {
    pub harness: &'static str,
    /// Folders that show the harness is installed; any one is enough.
    pub homes: Vec<PathBuf>,
    pub file: PathBuf,
    pub content: String,
}

fn env_dir(name: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or(fallback)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn targets(home: &Path) -> Vec<Target> {
    let xdg = env_dir("XDG_CONFIG_HOME", home.join(".config"));
    let claude = env_dir("CLAUDE_CONFIG_DIR", home.join(".claude"));
    let codex = env_dir("CODEX_HOME", home.join(".codex"));
    vec![
        Target {
            harness: "Claude Code",
            homes: vec![claude.clone()],
            file: claude.join("skills/patch/SKILL.md"),
            content: claude_skill(),
        },
        Target {
            harness: "Agent skills (Codex, Amp, Pi)",
            homes: vec![codex, home.join(".agents"), home.join(".pi"), xdg.join("amp")],
            file: home.join(".agents/skills/patch/SKILL.md"),
            content: skill(),
        },
        Target {
            harness: "Pi",
            homes: vec![home.join(".pi")],
            file: home.join(".pi/agent/prompts/patch.md"),
            content: markdown_command(),
        },
        Target {
            harness: "OpenCode",
            homes: vec![xdg.join("opencode")],
            file: xdg.join("opencode/commands/patch.md"),
            content: markdown_command(),
        },
        Target {
            harness: "Gemini CLI",
            homes: vec![home.join(".gemini")],
            file: home.join(".gemini/commands/patch.toml"),
            content: gemini_command(),
        },
        Target {
            harness: "Cursor",
            homes: vec![home.join(".cursor")],
            file: home.join(".cursor/commands/patch.md"),
            content: markdown_command(),
        },
        Target {
            harness: "Factory Droid",
            homes: vec![home.join(".factory")],
            file: home.join(".factory/commands/patch.md"),
            content: markdown_command(),
        },
    ]
}

fn bin_path() -> PathBuf {
    let dir = env_dir("PATCH_BIN_DIR", home_dir().join(".local/bin"));
    dir.join(if cfg!(windows) { "patchr.exe" } else { "patchr" })
}

pub fn install(all: bool, dry_run: bool) -> std::io::Result<()> {
    for target in targets(&home_dir()) {
        if !all && !target.homes.iter().any(|home| home.exists()) {
            continue;
        }
        eprintln!("{}  {}  ({})", if dry_run { "would write" } else { "wrote" }, target.file.display(), target.harness);
        if dry_run {
            continue;
        }
        if let Some(parent) = target.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target.file, target.content)?;
    }
    let me = std::env::current_exe()?;
    let bin = bin_path();
    if me != bin {
        eprintln!("{}  {} -> {}", if dry_run { "would copy" } else { "copied" }, me.display(), bin.display());
        if !dry_run {
            if let Some(parent) = bin.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // Copy beside it, then rename: a running patchr keeps its old file.
            let temporary = bin.with_extension("tmp");
            std::fs::copy(&me, &temporary)?;
            std::fs::rename(&temporary, &bin)?;
        }
    }
    Ok(())
}

pub fn uninstall() -> std::io::Result<()> {
    for target in targets(&home_dir()) {
        if !target.file.exists() {
            continue;
        }
        std::fs::remove_file(&target.file)?;
        eprintln!("removed  {}", target.file.display());
        // Skills live in a folder of their own; drop it once empty.
        if target.file.ends_with("SKILL.md")
            && let Some(parent) = target.file.parent()
        {
            let _ = std::fs::remove_dir(parent);
        }
    }
    let bin = bin_path();
    if bin.exists() {
        std::fs::remove_file(&bin)?;
        eprintln!("removed  {}", bin.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_harness_runs_patchr_review() {
        for target in targets(Path::new("/home/test")) {
            assert!(target.content.contains("patchr review"), "{}", target.harness);
            let name = target.file.file_name().unwrap().to_string_lossy();
            assert!(name == "SKILL.md" || name == "patch.md" || name == "patch.toml");
        }
    }

    #[test]
    fn gemini_template_keeps_its_braces() {
        assert!(gemini_command().contains("!{patchr review {{args}}}"));
    }
}

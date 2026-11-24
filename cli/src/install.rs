//! Adds `/patch` to every agent harness on this machine. Claude Code, Codex, Pi
//! and OpenCode get code that opens the review without a model turn; the others
//! get instructions for the model. Codex's hooks.json is the only shared file
//! changed, by one entry.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

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

/// Code a harness runs itself needs the binary's own path: the harness may
/// have been started without the user's shell PATH.
fn adapter(source: &str) -> String {
    let bin = serde_json::to_string(&bin_path().to_string_lossy()).unwrap_or_else(|_| "\"patchr\"".into());
    source.replace(ADAPTER_PATCHR, &format!("const PATCHR = {bin};"))
}

const ADAPTER_PATCHR: &str = "const PATCHR = \"patchr\"; // install writes the binary's full path here";

pub struct Target {
    pub harness: &'static str,
    /// Folders that show the harness is installed; any one is enough.
    pub homes: Vec<PathBuf>,
    pub files: Vec<(PathBuf, String)>,
    /// Where an earlier version installed this; removed so it isn't offered twice.
    pub replaces: Option<PathBuf>,
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
    let pi = env_dir("PI_CODING_AGENT_DIR", home.join(".pi/agent"));
    vec![
        Target {
            harness: "Claude Code",
            homes: vec![claude.clone()],
            files: vec![
                // In the plugin rather than at its root, so the mod's own /patch comes first.
                (claude.join("skills/patch/skills/patch/SKILL.md"), claude_skill()),
                (claude.join("skills/patch/.claude-plugin/plugin.json"), include_str!("../harness/claude/plugin.json").into()),
                (claude.join("skills/patch/hooks/hooks.json"), include_str!("../harness/claude/hooks.json").into()),
                (claude.join("skills/patch/hooks/register.ts"), adapter(include_str!("../harness/claude/register.ts"))),
            ],
            replaces: Some(claude.join("skills/patch/SKILL.md")),
        },
        Target {
            harness: "Agent skills (Codex, Amp)",
            homes: vec![codex, home.join(".agents"), xdg.join("amp")],
            files: vec![(home.join(".agents/skills/patch/SKILL.md"), skill())],
            replaces: None,
        },
        Target {
            harness: "Pi",
            homes: vec![pi.clone()],
            files: vec![(pi.join("extensions/patch.ts"), adapter(include_str!("../harness/pi.ts")))],
            replaces: Some(pi.join("prompts/patch.md")),
        },
        Target {
            harness: "OpenCode",
            homes: vec![xdg.join("opencode")],
            files: vec![(xdg.join("opencode/plugins/patch.ts"), adapter(include_str!("../harness/opencode.ts")))],
            replaces: Some(xdg.join("opencode/commands/patch.md")),
        },
        Target {
            harness: "Gemini CLI",
            homes: vec![home.join(".gemini")],
            files: vec![(home.join(".gemini/commands/patch.toml"), gemini_command())],
            replaces: None,
        },
        Target {
            harness: "Cursor",
            homes: vec![home.join(".cursor")],
            files: vec![(home.join(".cursor/commands/patch.md"), markdown_command())],
            replaces: None,
        },
        Target {
            harness: "Factory Droid",
            homes: vec![home.join(".factory")],
            files: vec![(home.join(".factory/commands/patch.md"), markdown_command())],
            replaces: None,
        },
    ]
}

/// The command Codex runs for every prompt. Codex trusts this exact line once,
/// so it must not change between versions.
fn codex_command() -> String {
    format!("'{}'{CODEX_HOOK}", bin_path().display().to_string().replace('\'', r"'\''"))
}

const CODEX_HOOK: &str = " hook codex";

fn codex_hooks_file() -> PathBuf {
    env_dir("CODEX_HOME", home_dir().join(".codex")).join("hooks.json")
}

/// Whether a hook is Patch's, wherever its binary was installed.
fn is_patch_hook(handler: &Value) -> bool {
    let command = handler["command"].as_str().and_then(|command| command.strip_suffix(CODEX_HOOK));
    let name = command.and_then(|bin| Path::new(bin.trim_matches('\'')).file_name());
    name.is_some_and(|name| name == "patchr" || name == "patchr.exe")
}

/// Codex's hooks with Patch's added or removed, or None when nothing changes.
/// Other hooks keep their place: Codex remembers trust by position. So removing
/// Patch's leaves an empty group where others follow, and adding it reuses one.
fn codex_hooks(text: &str, install: bool) -> Result<Option<String>, String> {
    let before: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(text).map_err(|error| error.to_string())?
    };
    let groups = before["hooks"]["UserPromptSubmit"].as_array();
    let had = groups.into_iter().flatten().filter_map(|group| group["hooks"].as_array()).flatten().any(is_patch_hook);
    if !had && !install {
        return Ok(None);
    }
    let mut root = before.clone();
    let hooks = root.as_object_mut().ok_or("not an object")?.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks is not an object")?;
    let groups = hooks.entry("UserPromptSubmit").or_insert_with(|| json!([]));
    let groups = groups.as_array_mut().ok_or("UserPromptSubmit is not a list")?;

    let empty = json!({ "hooks": [] });
    let mut missing = install;
    for group in groups.iter_mut() {
        let Some(handlers) = group["hooks"].as_array_mut() else { continue };
        handlers.retain_mut(|handler| {
            if !is_patch_hook(handler) {
                return true;
            }
            // The first one stays, pointed at this binary; any other is a leftover.
            handler["command"] = codex_command().into();
            std::mem::take(&mut missing)
        });
    }
    if missing {
        let group = json!({ "hooks": [{ "type": "command", "command": codex_command(), "timeout": 30 }] });
        match groups.iter_mut().find(|group| **group == empty) {
            Some(place) => *place = group,
            None => groups.push(group),
        }
    }
    while had && groups.last() == Some(&empty) {
        groups.pop();
    }
    if groups.is_empty() {
        hooks.shift_remove("UserPromptSubmit");
    }
    if root == before {
        return Ok(None);
    }
    serde_json::to_string_pretty(&root).map(|text| Some(text + "\n")).map_err(|error| error.to_string())
}

fn update_codex(install: bool, dry_run: bool) -> std::io::Result<()> {
    let file = codex_hooks_file();
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    match codex_hooks(&text, install) {
        Ok(Some(updated)) => {
            let verb = match (install, dry_run) {
                (true, true) => "would add a hook to",
                (true, false) => "added a hook to",
                (false, _) => "removed a hook from",
            };
            if !dry_run {
                replace_file(&file, &updated)?;
            }
            eprintln!("{verb}  {}{}", file.display(), if install { "  (Codex asks you to trust it once)" } else { "" });
        }
        Ok(None) => {}
        Err(error) => eprintln!("skipped  {}  ({error})", file.display()),
    }
    Ok(())
}

/// Replaces a file in one step, so a failure leaves the old one whole. A link
/// stays a link and the file keeps its permissions.
fn replace_file(file: &Path, text: &str) -> std::io::Result<()> {
    let file = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    let replaced = std::fs::write(&temporary, text)
        .and_then(|()| match std::fs::metadata(&file) {
            Ok(old) => std::fs::set_permissions(&temporary, old.permissions()),
            Err(_) => Ok(()),
        })
        .and_then(|()| std::fs::rename(&temporary, &file));
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    replaced
}

fn bin_path() -> PathBuf {
    let dir = env_dir("PATCH_BIN_DIR", home_dir().join(".local/bin"));
    dir.join(if cfg!(windows) { "patchr.exe" } else { "patchr" })
}

/// Whether Patch wrote a file: everything it installs names its command.
fn is_ours(file: &Path) -> bool {
    std::fs::read_to_string(file).is_ok_and(|text| text.contains("patchr"))
}

/// Whether the user has a file of their own where Patch's would go.
fn taken(target: &Target) -> Option<&Path> {
    let (file, _) = target.files.first()?;
    // Something of theirs in the folder Patch would fill counts too.
    let beside = target.replaces.as_ref().filter(|old| old.parent().is_some_and(|dir| file.starts_with(dir)));
    [Some(file), beside].into_iter().flatten().find(|file| file.exists() && !is_ours(file)).map(PathBuf::as_path)
}

fn copy_binary(dry_run: bool) -> std::io::Result<()> {
    let me = std::env::current_exe()?;
    let bin = bin_path();
    if me == bin {
        return Ok(());
    }
    eprintln!("{}  {} -> {}", if dry_run { "would copy" } else { "copied" }, me.display(), bin.display());
    if dry_run {
        return Ok(());
    }
    if let Some(parent) = bin.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Copy beside it, then rename: a running patchr keeps its old file.
    let temporary = bin.with_extension("tmp");
    std::fs::copy(&me, &temporary)?;
    std::fs::rename(&temporary, &bin)
}

pub fn install(all: bool, dry_run: bool) -> std::io::Result<()> {
    // First, so no adapter ever points at a binary that isn't there.
    copy_binary(dry_run)?;
    for target in targets(&home_dir()) {
        if !all && !target.homes.iter().any(|home| home.exists()) {
            continue;
        }
        if let Some(file) = taken(&target) {
            eprintln!("skipped  {}  (not Patch's; move it to install {})", file.display(), target.harness);
            continue;
        }
        for (file, _) in &target.files {
            eprintln!("{}  {}  ({})", if dry_run { "would write" } else { "wrote" }, file.display(), target.harness);
        }
        let old = target.replaces.as_deref().filter(|old| old.exists());
        let replaced = old.filter(|old| is_ours(old));
        if let Some(old) = replaced {
            eprintln!("{}  {}  (replaced)", if dry_run { "would remove" } else { "removed" }, old.display());
        } else if let Some(old) = old {
            eprintln!("kept  {}  (not Patch's; {} may run it instead)", old.display(), target.harness);
        }
        if dry_run {
            continue;
        }
        for (file, content) in &target.files {
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(file, content)?;
        }
        if let Some(old) = replaced {
            std::fs::remove_file(old)?;
        }
    }
    if (all || codex_hooks_file().parent().is_some_and(Path::exists))
        && let Err(error) = update_codex(true, dry_run)
    {
        eprintln!("skipped  {}  ({error})", codex_hooks_file().display());
    }
    Ok(())
}

pub fn uninstall() -> std::io::Result<()> {
    for target in targets(&home_dir()) {
        if let Some(old) = target.replaces.as_deref().filter(|old| is_ours(old)) {
            std::fs::remove_file(old)?;
            eprintln!("removed  {}", old.display());
        }
        if taken(&target).is_some() {
            continue;
        }
        for (file, _) in target.files.iter().filter(|(file, _)| file.exists()).rev() {
            std::fs::remove_file(file)?;
            eprintln!("removed  {}", file.display());
            // Skills live in a folder of their own; drop it once empty.
            let skill = file.ancestors().skip(1).filter(|dir| dir.ends_with("skills/patch")).last();
            for dir in file.ancestors().skip(1).take_while(|dir| skill.is_some_and(|skill| dir.starts_with(skill))) {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }
    if codex_hooks_file().exists()
        && let Err(error) = update_codex(false, false)
    {
        eprintln!("skipped  {}  ({error})", codex_hooks_file().display());
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
            assert!(target.files.iter().any(|(_, content)| content.contains("patchr review")), "{}", target.harness);
        }
    }

    #[test]
    fn adapters_know_the_binary() {
        let sources = targets(Path::new("/home/test")).into_iter().flat_map(|target| target.files);
        let adapters: Vec<_> = sources.filter(|(file, _)| file.extension().is_some_and(|e| e == "ts")).collect();
        assert_eq!(adapters.len(), 3);
        for (file, content) in adapters {
            assert!(content.contains(&format!("const PATCHR = {:?};", bin_path())), "{}", file.display());
            assert!(!content.contains(ADAPTER_PATCHR), "{}", file.display());
        }
    }

    #[test]
    fn codex_hooks_keep_everything_else_in_place() {
        let before = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"z"}]}],"SessionStart":[]},"a":1}"#;
        let added = codex_hooks(before, true).unwrap().unwrap();
        let value: Value = serde_json::from_str(&added).unwrap();
        assert_eq!(value["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"], "z");
        assert_eq!(value["hooks"]["UserPromptSubmit"][1]["hooks"][0]["command"], codex_command());
        assert!(codex_hooks(&added, true).unwrap().is_none());
        let removed: Value = serde_json::from_str(&codex_hooks(&added, false).unwrap().unwrap()).unwrap();
        assert_eq!(removed.to_string(), before);
        let fresh = codex_hooks("", true).unwrap().unwrap();
        assert_eq!(codex_hooks(&fresh, false).unwrap().unwrap(), "{\n  \"hooks\": {}\n}\n");
        assert!(codex_hooks("[]", true).is_err());
    }

    /// The commands of every UserPromptSubmit group, in order.
    fn commands(text: &str) -> Vec<Vec<String>> {
        let value: Value = serde_json::from_str(text).unwrap();
        let groups = value["hooks"]["UserPromptSubmit"].as_array().unwrap().iter();
        groups.map(|group| group["hooks"].as_array().unwrap().iter().map(|h| h["command"].as_str().unwrap().into()).collect()).collect()
    }

    #[test]
    fn removing_the_codex_hook_moves_no_other() {
        let before = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"'/old/patchr' hook codex"}]},{"hooks":[{"command":"z"}]}]}}"#;
        let removed = codex_hooks(before, false).unwrap().unwrap();
        assert_eq!(commands(&removed), [vec![], vec!["z".to_string()]]);
        assert!(codex_hooks(&removed, false).unwrap().is_none());
        assert_eq!(commands(&codex_hooks(&removed, true).unwrap().unwrap()), [[codex_command()], ["z".into()]]);
    }

    #[test]
    fn one_codex_hook_however_often_the_binary_moves() {
        let before = r#"{"hooks":{"UserPromptSubmit":[
            {"hooks":[{"command":"'/a/patchr' hook codex"},{"command":"z"}]},
            {"hooks":[{"command":"'/b/patchr' hook codex"}]}]}}"#;
        let installed = codex_hooks(before, true).unwrap().unwrap();
        assert_eq!(commands(&installed), [[codex_command(), "z".into()]]);
        assert_eq!(commands(&codex_hooks(&installed, false).unwrap().unwrap()), [["z"]]);
        let theirs = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"not-patchr hook codex"}]}]}}"#;
        assert!(codex_hooks(theirs, false).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_file_keeps_its_link_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("patch-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (real, link) = (dir.join("real.json"), dir.join("link.json"));
        std::fs::write(&real, "old").unwrap();
        std::fs::set_permissions(&real, PermissionsExt::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        replace_file(&link, "new").unwrap();
        assert!(link.is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gemini_template_keeps_its_braces() {
        assert!(gemini_command().contains("!{patchr review {{args}}}"));
    }
}

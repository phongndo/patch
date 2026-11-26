//! Adds `/patch` to every agent harness on this machine. Claude Code, Codex, Pi
//! and OpenCode get code that opens the review without a model turn; the others
//! get instructions for the model. Codex's hooks.json is the only shared file
//! changed, by one entry.
//!
//! Everything runs `~/.local/bin/patchr`, by its full path: a harness may have
//! been started without the user's PATH. That file is a link where a package
//! manager keeps a path to its current version, so the manager's upgrades reach
//! every harness. After an upgrade the next review brings the files up to date
//! (`refresh`), but only those still as Patch wrote them.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::channel::{self, Channel};
use crate::server::state_dir;
#[cfg(unix)]
use crate::slot::Slot;

const DESCRIPTION: &str = "Review the current changes in Patch, a browser diff viewer, then act on the feedback.";

const WHERE: &str = "Pick the repository first. Use the directory the user names in the arguments; otherwise the Git repository you have been working in during this conversation; otherwise the current directory. Pass it as the first argument whenever it is not the current directory. If none of these is a Git repository, ask the user which one to review instead of running the command.";

const LINK: &str = "The command first prints `Patch is open at <url>` on stderr. When no browser opens on the user's screen, as over SSH or on a remote machine, read that line and give the user the URL; it opens on any of their devices on Tailscale.";

const OUTCOMES: &str = "Then act on its stdout:

- Comments: address every one now, answering those that are only questions without changing code for them, then say what you did for each, by number.
- No comments: say the review passed and continue.
- Closed without feedback: say so in one sentence and stop. Closing is not approval.
- If the command was cut off by a timeout, say so and run it again. The new review starts empty; the tab of the old one can still copy its comments.";

const OPTIONS: &str = "Arguments: a directory to review, `--base <ref>` to compare against another branch, `--uncommitted` or `--staged` to narrow the change, `--local` to keep the page off the tailnet. Run the command yourself; never ask the user to.";

/// The installed binary as a shell word.
fn patchr() -> String {
    let path = bin_path().display().to_string();
    let plain = |c: char| c.is_ascii_alphanumeric() || "/._-+".contains(c);
    if path.chars().all(plain) { path } else { format!("'{}'", path.replace('\'', r"'\''")) }
}

fn task() -> String {
    let command = format!("{} review $ARGUMENTS", patchr());
    format!(
        "{WHERE}

Run `{command}` in the foreground and wait for it to finish. It opens the diff in the browser and blocks until the user finishes, which can take a long time: use the longest timeout your shell tool allows, or none.

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
        task()
    )
}

// The model runs the command, not a pre-run `!` line, so it can review the
// repository it has been working in rather than the session's start folder.
fn claude_skill() -> String {
    format!(
        "---
name: patch
description: {DESCRIPTION}
allowed-tools: Bash({patchr}:*)
disable-model-invocation: true
---

# Patch review

{WHERE}

Run `{patchr} review [directory] $ARGUMENTS` with the Bash tool, `run_in_background: true` and `timeout: 7200000`. It opens the diff in the browser and waits for the user, which can take a long time. Don't poll it or start a second one.

{LINK} Its output file holds that line as soon as the command starts. Then end your turn and act when it finishes.

{OUTCOMES}

{OPTIONS}
",
        patchr = patchr()
    )
}

fn markdown_command() -> String {
    format!("---\ndescription: {DESCRIPTION}\n---\n\n{}\n", task())
}

fn gemini_command() -> String {
    let prompt = format!(
        "## Patch review

!{{{} review {{{{args}}}}}}

## Your task

If the review above has comments, address every one now, answering those that are only questions without changing code for them, then say what you did for each, by number. If it has no comments, say the review passed and continue. If it was closed without feedback, or is empty, say so in one sentence and stop: closing is not approval.
",
        patchr()
    );
    // A JSON string is a TOML one too, whatever the path has in it.
    format!("description = {}\nprompt = {}\n", json!(DESCRIPTION), json!(prompt))
}

fn adapter(source: &str) -> String {
    let bin = serde_json::to_string(&bin_path().to_string_lossy()).unwrap_or_else(|_| "\"patchr\"".into());
    source.replace(ADAPTER_PATCHR, &format!("const PATCHR = {bin};"))
}

const ADAPTER_PATCHR: &str = "const PATCHR = \"patchr\"; // install writes the binary's full path here";

pub struct Target {
    /// The harnesses that read it, each with the folder that shows it is installed.
    pub harnesses: Vec<(&'static str, PathBuf)>,
    /// What the user types.
    pub command: &'static str,
    pub files: Vec<(PathBuf, String)>,
    /// Where an earlier version installed this; removed so it isn't offered twice.
    pub replaces: Option<PathBuf>,
}

/// The folder many harnesses read skills from, for those Patch doesn't know.
const SKILLS: &str = "Agent skills";

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
            harnesses: vec![("Claude Code", claude.clone())],
            command: "/patch",
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
            harnesses: vec![("Codex", codex), ("Amp", xdg.join("amp")), (SKILLS, home.join(".agents"))],
            command: "$patch",
            files: vec![(home.join(".agents/skills/patch/SKILL.md"), skill())],
            replaces: None,
        },
        Target {
            harnesses: vec![("Pi", pi.clone())],
            command: "/patch",
            files: vec![(pi.join("extensions/patch.ts"), adapter(include_str!("../harness/pi.ts")))],
            replaces: Some(pi.join("prompts/patch.md")),
        },
        Target {
            harnesses: vec![("OpenCode", xdg.join("opencode"))],
            command: "/patch",
            files: vec![(xdg.join("opencode/plugins/patch.ts"), adapter(include_str!("../harness/opencode.ts")))],
            replaces: Some(xdg.join("opencode/commands/patch.md")),
        },
        Target {
            harnesses: vec![("Gemini CLI", home.join(".gemini"))],
            command: "/patch",
            files: vec![(home.join(".gemini/commands/patch.toml"), gemini_command())],
            replaces: None,
        },
        Target {
            harnesses: vec![("Cursor", home.join(".cursor"))],
            command: "/patch",
            files: vec![(home.join(".cursor/commands/patch.md"), markdown_command())],
            replaces: None,
        },
        Target {
            harnesses: vec![("Droid", home.join(".factory"))],
            command: "/patch",
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

/// What stays where Patch's hook was, when the user's follow it in its group.
const CODEX_PLACEHOLDER: &str = "true # where Patch's hook was; it keeps the trust in those after it";

fn codex_hooks_file() -> PathBuf {
    env_dir("CODEX_HOME", home_dir().join(".codex")).join("hooks.json")
}

/// Whether a hook is Patch's, wherever its binary was installed.
fn is_patch_hook(handler: &Value) -> bool {
    if handler["command"] == CODEX_PLACEHOLDER {
        return true;
    }
    let command = handler["command"].as_str().and_then(|command| command.strip_suffix(CODEX_HOOK));
    let name = command.and_then(|bin| Path::new(bin.trim_matches('\'')).file_name());
    name.is_some_and(|name| name == "patchr" || name == "patchr.exe")
}

/// Codex's hooks with Patch's added or removed, or None when nothing changes.
/// Other hooks keep their place: Codex remembers trust by position. So removing
/// Patch's leaves an empty group or a placeholder where others follow, and
/// adding it reuses one.
fn codex_hooks(text: &str, install: bool) -> Result<Option<String>, String> {
    let before: Value =
        if text.trim().is_empty() { json!({}) } else { serde_json::from_str(text).map_err(|error| error.to_string())? };
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
    // The first one stays, pointed at this binary; any other is a leftover.
    let first = groups
        .iter()
        .enumerate()
        .find_map(|(index, group)| Some((index, group["hooks"].as_array()?.iter().position(is_patch_hook)?)));
    for (index, group) in groups.iter_mut().enumerate() {
        let Some(handlers) = group["hooks"].as_array_mut() else { continue };
        for at in (0..handlers.len()).rev() {
            let followed = at + 1 < handlers.len();
            if !is_patch_hook(&handlers[at]) || (install && Some((index, at)) == first) {
                continue;
            }
            if followed {
                handlers[at]["command"] = CODEX_PLACEHOLDER.into();
            } else {
                handlers.remove(at);
            }
        }
        if let Some((_, at)) = first.filter(|(group, _)| install && *group == index) {
            handlers[at]["command"] = codex_command().into();
        }
    }
    let missing = install && first.is_none();
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

/// Adds or removes Codex's hook, and returns whether that changed anything.
fn update_codex(install: bool, dry_run: bool) -> Result<bool, String> {
    let file = codex_hooks_file();
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("{}: {error}", tilde(&file))),
    };
    let updated = codex_hooks(&text, install).map_err(|error| format!("{}: {error}", tilde(&file)))?;
    if let Some(updated) = updated.as_ref().filter(|_| !dry_run) {
        // With nothing else in it, the file goes too.
        if !install && updated == "{\n  \"hooks\": {}\n}\n" && !file.is_symlink() {
            std::fs::remove_file(&file).map_err(|error| format!("{}: {error}", tilde(&file)))?;
            return Ok(true);
        }
        replace_file(&file, updated).map_err(|error| format!("{}: {error}", tilde(&file)))?;
    }
    Ok(updated.is_some())
}

/// Replaces a file in one step, so a failure leaves the old one whole. A link
/// stays a link and the file keeps its permissions.
fn replace_file(file: &Path, text: &str) -> std::io::Result<()> {
    let file = real_path(file);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = file.with_extension(format!("{}.tmp", crate::random_token(12)));
    let replaced = File::create_new(&temporary)
        .and_then(|mut new| new.write_all(text.as_bytes()))
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

pub fn bin_path() -> PathBuf {
    let dir = env_dir("PATCH_BIN_DIR", home_dir().join(".local/bin"));
    dir.join(if cfg!(windows) { "patchr.exe" } else { "patchr" })
}

/// Whether an earlier Patch, which kept no record, wrote a file: its name is in
/// every one whose content has ever changed.
fn is_ours(file: &Path) -> bool {
    std::fs::read_to_string(file).is_ok_and(|text| text.contains("patchr"))
}

/// Whether what is at a path is the user's: never Patch's, or edited since.
fn is_theirs(file: &Path, content: &str, written: &Written) -> bool {
    match (std::fs::read(file), written.get(file)) {
        (Ok(now), _) if now == content.as_bytes() => false,
        (Ok(now), Some(recorded)) => hash(now) != *recorded,
        (Ok(_), None) => !is_ours(file),
        (Err(error), _) => !matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory),
    }
}

/// The user's own file where one of Patch's would go.
fn taken<'a>(target: &'a Target, written: &Written) -> Option<&'a Path> {
    let file = target.files.iter().find(|(file, content)| is_theirs(file, content, written));
    // Something of theirs in the folder Patch would fill counts too.
    let beside = target.replaces.as_ref().filter(|old| {
        old.parent().is_some_and(|dir| target.files.iter().any(|(file, _)| file.starts_with(dir)))
            && old.exists()
            && !is_ours(old)
    });
    file.map(|(file, _)| file.as_path()).or(beside.map(PathBuf::as_path))
}

/// Whether a path is free for the binary: nothing is there, or a Patch is.
fn holds_patchr(bin: &Path) -> bool {
    match std::fs::read(bin) {
        Ok(bytes) => bytes.windows(crate::ABOUT.len()).any(|part| part == crate::ABOUT.as_bytes()),
        // A link whose package manager has gone.
        Err(_) => match std::fs::read_link(bin) {
            Ok(to) => to.file_name() == bin.file_name(),
            Err(_) => !bin.exists(),
        },
    }
}

/// One install, refresh or uninstall at a time, for as long as the file is held.
fn lock_file() -> std::io::Result<File> {
    std::fs::create_dir_all(state_dir())?;
    File::options().create(true).append(true).open(lock_path())
}

fn lock_path() -> PathBuf {
    state_dir().join("install.lock")
}

fn tilde(path: &Path) -> String {
    match path.strip_prefix(home_dir()) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// How the installed binary comes to be where everything runs it.
#[derive(Debug, PartialEq)]
enum Placement {
    Kept,
    Linked(PathBuf),
    Copied(PathBuf),
}

/// `me` is this binary's real path.
fn placement(me: &Path, bin: &Path) -> Placement {
    if bin.canonicalize().is_ok_and(|real| real == me) {
        return Placement::Kept;
    }
    match channel::of(me).stable(me) {
        Some(stable) => Placement::Linked(stable),
        // Releases are self-contained, so a copy outlives even `nix run`.
        None => Placement::Copied(me.to_path_buf()),
    }
}

#[cfg(unix)]
fn link(to: &Path, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(to, at)
}

#[cfg(not(unix))]
fn link(to: &Path, at: &Path) -> std::io::Result<()> {
    copy(to, at)
}

fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    #[cfg(unix)]
    std::fs::set_permissions(to, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    Ok(())
}

/// Puts the binary in place beside the old one, then renames: a running patchr
/// keeps its file, and the path is never missing.
fn place_binary(placement: &Placement, bin: &Path) -> std::io::Result<()> {
    if *placement == Placement::Kept {
        return Ok(());
    }
    if let Some(parent) = bin.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = bin.with_extension(format!("{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let placed = match placement {
        Placement::Linked(to) => link(to, &temporary),
        Placement::Copied(from) => copy(from, &temporary),
        Placement::Kept => Ok(()),
    };
    let placed = placed.and_then(|()| std::fs::rename(&temporary, bin));
    if placed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    placed
}

/// What Patch wrote where, by the file's hash, so `refresh` can tell its own
/// files from ones the user has edited.
type Written = BTreeMap<PathBuf, String>;

/// What `install` did, for the commands that come after it.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Record {
    files: Written,
    /// Where the binary was copied from, when it isn't a link.
    copied_from: Option<PathBuf>,
}

fn record_file() -> PathBuf {
    state_dir().join("installed.json")
}

fn load_record() -> Record {
    std::fs::read(record_file()).ok().and_then(|text| serde_json::from_slice(&text).ok()).unwrap_or_default()
}

fn record_text(record: &Record) -> String {
    serde_json::to_string_pretty(record).unwrap_or_default() + "\n"
}

fn save_record(record: &Record) -> Result<(), String> {
    let file = record_file();
    replace_file(&file, &record_text(record)).map_err(|error| format!("Could not write {}: {error}", tilde(&file)))
}

/// Where the installed binary was copied from, if it was.
pub fn copied_from() -> Option<PathBuf> {
    load_record().copied_from
}

fn hash(text: impl AsRef<[u8]>) -> String {
    Sha256::digest(text).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Writes a target's files, leaving those already right alone.
fn write_files(target: &Target, written: &mut Written) -> Result<(), String> {
    for (file, content) in &target.files {
        if std::fs::read_to_string(file).ok().as_ref() != Some(content) {
            replace_file(file, content).map_err(|error| format!("{}: {error}", tilde(file)))?;
        }
        written.insert(file.clone(), hash(content));
    }
    Ok(())
}

/// After an upgrade, brings the files that `install` wrote up to date. Files the
/// user changed or removed stay that way, and the repository under review is
/// never written to, even when it holds the user's harness settings.
#[cfg(unix)]
pub fn refresh(repository: &Path) {
    let me = std::env::current_exe().and_then(std::fs::canonicalize);
    if !me.is_ok_and(|me| bin_path().canonicalize().is_ok_and(|bin| bin == me)) {
        return;
    }
    let before = load_record();
    if before.files.is_empty() {
        return;
    }
    let slot = |file: &Path| Slot::open(&real_path(file), repository);
    let (Ok(lock), Ok(kept)) = (slot(&lock_path()), slot(&record_file())) else { return };
    let Ok(lock) = lock.file() else { return };
    // Another review or install is at it.
    if lock.try_lock().is_err() {
        return;
    }
    let mut record = load_record();
    let before = record.clone();
    refresh_targets(&targets(&home_dir()), repository, &mut record.files);
    if record != before
        && let Err(error) = kept.replace(&record_text(&record))
    {
        eprintln!("patchr: {}: {error}", tilde(&record_file()));
    }
}

#[cfg(not(unix))]
pub fn refresh(_repository: &Path) {}

/// Where a file is or would be, following links in the folders that exist.
fn real_path(file: &Path) -> PathBuf {
    let (real, rest) = file
        .ancestors()
        .find_map(|dir| Some((dir.canonicalize().ok()?, file.strip_prefix(dir).ok()?)))
        .unwrap_or_else(|| (file.to_path_buf(), Path::new("")));
    if rest.as_os_str().is_empty() { real } else { real.join(rest) }
}

#[cfg(unix)]
fn refresh_targets(targets: &[Target], repository: &Path, written: &mut Written) {
    for target in targets {
        // What is read and what is written are in the same folder, whatever its path does meanwhile.
        let slots: std::io::Result<Vec<_>> =
            target.files.iter().map(|(file, content)| Ok((file, Slot::open(&real_path(file), repository)?, content))).collect();
        let Ok(slots) = slots else { continue };
        // All of a target's files or none: they belong to one version.
        let untouched = slots.iter().all(|(file, slot, _)| match (slot.read(), written.get(*file)) {
            (Ok(now), Some(recorded)) => hash(now) == *recorded,
            (Err(error), None) => error.kind() == ErrorKind::NotFound,
            _ => false,
        });
        let installed = slots.iter().any(|(file, ..)| written.contains_key(*file));
        let stale = slots.iter().any(|(_, slot, content)| slot.read().ok().as_deref() != Some(content.as_bytes()));
        if !(installed && untouched && stale) {
            continue;
        }
        for (file, slot, content) in slots {
            if let Err(error) = slot.replace(content) {
                eprintln!("patchr: {}: {error}", tilde(file));
                break;
            }
            written.insert(file.clone(), hash(content));
        }
    }
}

/// How setting a harness up went, and what to say about it.
#[derive(Clone)]
enum Setup {
    Done(String),
    /// The user's own file is there.
    Skipped(String),
    Failed(String),
}

fn install_target(target: &Target, dry_run: bool, written: &mut Written) -> Setup {
    if let Some(file) = taken(target, written) {
        return Setup::Skipped(format!("kept your own {}; move it and run this again for Patch's", tilde(file)));
    }
    match write_target(target, dry_run, written) {
        Ok(text) => Setup::Done(text),
        Err(error) => Setup::Failed(error),
    }
}

fn write_target(target: &Target, dry_run: bool, written: &mut Written) -> Result<String, String> {
    let old = target.replaces.as_deref().filter(|old| old.exists());
    if !dry_run {
        write_files(target, written)?;
        if let Some(old) = old.filter(|old| is_ours(old)) {
            std::fs::remove_file(old).map_err(|error| format!("{}: {error}", tilde(old)))?;
        }
    }
    Ok(match old.filter(|old| !is_ours(old)) {
        Some(old) => format!("{}   ({} isn't Patch's and may run instead)", target.command, tilde(old)),
        None => target.command.into(),
    })
}

pub fn install(all: bool, dry_run: bool) -> Result<(), String> {
    let me = std::env::current_exe().and_then(std::fs::canonicalize).map_err(|error| error.to_string())?;
    let bin = bin_path();
    if !holds_patchr(&bin) {
        return Err(format!("{} is another program. Move it, or set PATCH_BIN_DIR to install elsewhere.", tilde(&bin)));
    }
    let locked = if dry_run { None } else { Some(lock_file().and_then(|file| file.lock().map(|()| file))) };
    let _lock = locked.transpose().map_err(|error| format!("Could not write {}: {error}", tilde(&state_dir())))?;
    // The binary first, so nothing ever points at one that isn't there.
    let placement = placement(&me, &bin);
    if !dry_run {
        place_binary(&placement, &bin).map_err(|error| format!("Could not write {}: {error}", tilde(&bin)))?;
    }

    let mut record = load_record();
    match &placement {
        Placement::Kept => {}
        Placement::Linked(_) => record.copied_from = None,
        Placement::Copied(from) => record.copied_from = Some(from.clone()),
    }
    let mut rows = Vec::new();
    let mut files = Vec::new();
    for target in targets(&home_dir()) {
        let mut found: Vec<_> = target.harnesses.iter().filter(|(_, home)| all || home.exists()).map(|(name, _)| *name).collect();
        if found.len() > 1 {
            found.retain(|name| *name != SKILLS);
        }
        if found.is_empty() {
            continue;
        }
        let setup = install_target(&target, dry_run, &mut record.files);
        let done = matches!(setup, Setup::Done(_));
        files.extend(target.files.iter().filter(|_| done).map(|(file, _)| file.clone()));
        for harness in found {
            let mut setup = setup.clone();
            // The hook opens reviews without the skill, so it goes in either way.
            if harness == "Codex" {
                let hook = update_codex(true, dry_run);
                files.extend(matches!(hook, Ok(true)).then(codex_hooks_file));
                let note = "trust the hook when Codex asks";
                setup = match (setup, hook) {
                    (Setup::Done(text), Ok(true)) => Setup::Done(format!("{text}   {note}")),
                    (Setup::Skipped(text), Ok(true)) => Setup::Done(format!("{}   {note}; {text}", target.command)),
                    (setup, Ok(_)) => setup,
                    (Setup::Failed(text), Err(error)) => Setup::Failed(format!("{text}; {error}")),
                    (_, Err(error)) => Setup::Failed(error),
                };
            }
            rows.push((harness, setup));
        }
    }
    let saved = if dry_run { Ok(()) } else { save_record(&record) };
    report(&rows, &files, &placement, dry_run);
    match rows.iter().filter(|(_, setup)| matches!(setup, Setup::Failed(_))).count() {
        0 => saved,
        failed => Err(format!("could not set up {failed} of {} harnesses", rows.len())),
    }
}

fn report(rows: &[(&str, Setup)], files: &[PathBuf], placement: &Placement, dry_run: bool) {
    let bin = tilde(&bin_path());
    let verb = if dry_run { "Would install" } else { "Installed" };
    eprintln!("{verb} Patch {}", crate::VERSION);
    eprintln!();
    let width = rows.iter().map(|(harness, _)| harness.len()).max().unwrap_or(0);
    for (harness, setup) in rows {
        let (mark, text) = match setup {
            Setup::Done(text) => ("✓", text),
            Setup::Skipped(text) => ("-", text),
            Setup::Failed(text) => ("✗", text),
        };
        eprintln!("  {mark} {harness:width$}   {text}");
    }
    if dry_run {
        eprintln!();
        match placement {
            Placement::Kept => {}
            Placement::Linked(to) => eprintln!("  {bin} -> {}", tilde(to)),
            Placement::Copied(from) => eprintln!("  {bin}, copied from {}", tilde(from)),
        }
        files.iter().for_each(|file| eprintln!("  {}", tilde(file)));
        return;
    }
    if rows.is_empty() {
        let known: Vec<_> = targets(&home_dir())
            .into_iter()
            .flat_map(|target| target.harnesses)
            .map(|(name, _)| name)
            .filter(|name| *name != SKILLS)
            .collect();
        eprintln!("No agent harness found. Patch works with {}.", known.join(", "));
        eprintln!("Install one, then run: {} install", patchr());
    } else if rows.iter().any(|(_, setup)| matches!(setup, Setup::Done(_))) {
        eprintln!();
        eprintln!("Restart any open session, then type the command to review its changes.");
    }
    let dir = bin_path().parent().map(Path::to_path_buf).unwrap_or_default();
    if !std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).any(|entry| entry == dir) {
        eprintln!("Your harnesses need nothing more. To run patchr yourself, add {} to your PATH.", tilde(&dir));
    }
}

pub fn uninstall() -> Result<(), String> {
    let remove = |file: &Path| {
        std::fs::remove_file(file).map_err(|error| format!("{}: {error}", tilde(file)))?;
        eprintln!("removed  {}", tilde(file));
        Ok::<_, String>(())
    };
    let lock = lock_file().and_then(|file| file.lock().map(|()| file));
    let _lock = lock.map_err(|error| format!("{}: {error}", tilde(&state_dir())))?;
    let written = load_record().files;
    // Of what stays, so a later install still knows it was edited.
    let mut kept = Written::new();
    for target in targets(&home_dir()) {
        if let Some(old) = target.replaces.as_deref().filter(|old| is_ours(old)) {
            remove(old)?;
        }
        for (file, content) in target.files.iter().filter(|(file, _)| file.exists()).rev() {
            if is_theirs(file, content, &written) {
                eprintln!("kept     {}  (yours, or edited)", tilde(file));
                kept.extend(written.get(file).map(|hash| (file.clone(), hash.clone())));
                continue;
            }
            remove(file)?;
            // Skills live in a folder of their own; drop it once empty.
            let skill = file.ancestors().skip(1).filter(|dir| dir.ends_with("skills/patch")).last();
            for dir in file.ancestors().skip(1).take_while(|dir| skill.is_some_and(|skill| dir.starts_with(skill))) {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }
    if codex_hooks_file().exists() {
        match update_codex(false, false) {
            Ok(true) => eprintln!("removed  a hook from {}", tilde(&codex_hooks_file())),
            Ok(false) => {}
            Err(error) => eprintln!("skipped  {error}"),
        }
    }
    if !kept.is_empty() {
        save_record(&Record { files: kept, copied_from: None })?;
    } else if record_file().exists() {
        remove(&record_file())?;
    }
    let bin = bin_path();
    // Read before the link to it goes.
    let channel = bin.canonicalize().map(|real| channel::of(&real));
    if !holds_patchr(&bin) {
        eprintln!("kept     {}  (another program)", tilde(&bin));
        return Ok(());
    }
    if bin.exists() || bin.is_symlink() {
        remove(&bin)?;
    }
    match channel {
        Ok(Channel::Homebrew { formula, .. }) => eprintln!("Remove the rest with: brew uninstall {formula}"),
        Ok(Channel::Mise { .. }) => eprintln!("Remove the rest with: mise unuse -g github:phongndo/patch"),
        Ok(Channel::Nix) => eprintln!("Remove the rest from your Nix profile or flake."),
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_harness_runs_patchr_review() {
        for target in targets(Path::new("/home/test")) {
            let command = format!("{} review", patchr());
            let runs = |content: &str| content.contains(&command) || content.contains("patchr review");
            assert!(target.files.iter().any(|(_, content)| runs(content)), "{:?}", target.harnesses);
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
        groups
            .map(|group| group["hooks"].as_array().unwrap().iter().map(|h| h["command"].as_str().unwrap().into()).collect())
            .collect()
    }

    #[test]
    fn removing_the_codex_hook_moves_no_other() {
        let before =
            r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"'/old/patchr' hook codex"}]},{"hooks":[{"command":"z"}]}]}}"#;
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
        // z's place in its group is part of what Codex trusts.
        let removed = codex_hooks(&installed, false).unwrap().unwrap();
        assert_eq!(commands(&removed), [[CODEX_PLACEHOLDER, "z"]]);
        assert!(codex_hooks(&removed, false).unwrap().is_none());
        assert_eq!(codex_hooks(&removed, true).unwrap().unwrap(), installed);
        let last = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"z"},{"command":"'/a/patchr' hook codex"}]}]}}"#;
        assert_eq!(commands(&codex_hooks(last, false).unwrap().unwrap()), [["z"]]);
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
        assert!(gemini_command().contains(&format!("!{{{} review {{{{args}}}}}}", patchr())));
    }

    #[test]
    fn gemini_keeps_its_prompt_whole() {
        let command = gemini_command();
        let prompt = command.lines().nth(1).unwrap().strip_prefix("prompt = ").unwrap();
        assert!(serde_json::from_str::<String>(prompt).unwrap().ends_with("closing is not approval.\n"));
        assert_eq!(command.lines().count(), 2);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("patch-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn target(files: &[(&Path, &str)]) -> Target {
        Target {
            harnesses: vec![],
            command: "/patch",
            files: files.iter().map(|(file, text)| (file.to_path_buf(), text.to_string())).collect(),
            replaces: None,
        }
    }

    #[test]
    fn refresh_updates_only_what_patch_wrote() {
        let dir = scratch("refresh");
        let (file, added, mine) = (dir.join("a/patch.ts"), dir.join("a/new.ts"), dir.join("b/patch.md"));
        let mut written = Written::new();
        write_files(&target(&[(&file, "old")]), &mut written).unwrap();
        write_files(&target(&[(&mine, "old")]), &mut written).unwrap();
        std::fs::write(&mine, "edited").unwrap();

        let elsewhere = dir.join("repo");
        std::fs::create_dir(&elsewhere).unwrap();
        let newer = [target(&[(&file, "new"), (&added, "new")]), target(&[(&mine, "new")])];
        refresh_targets(&newer, &elsewhere, &mut written);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&added).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&mine).unwrap(), "edited");

        // Removed by the user, or never installed.
        std::fs::remove_file(&file).unwrap();
        refresh_targets(&[target(&[(&file, "newer"), (&added, "newer")])], &elsewhere, &mut written);
        refresh_targets(&[target(&[(&dir.join("c/patch.md"), "new")])], &elsewhere, &mut written);
        assert!(!file.exists() && !dir.join("c").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refresh_never_writes_to_the_reviewed_repository() {
        let dir = scratch("refresh-inside");
        let (repository, config) = (dir.join("dotfiles"), dir.join("config"));
        std::fs::create_dir_all(&repository).unwrap();
        std::os::unix::fs::symlink(&repository, &config).unwrap();
        let (inside, linked) = (repository.join("a.ts"), config.join("b.ts"));
        let mut written = Written::new();
        for file in [&inside, &linked] {
            write_files(&target(&[(file, "old")]), &mut written).unwrap();
            refresh_targets(&[target(&[(file, "new")])], &repository, &mut written);
            assert_eq!(std::fs::read_to_string(file).unwrap(), "old");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_binary_is_linked_to_its_manager_or_copied() {
        let dir = scratch("place");
        let bin = dir.join("bin/patchr");
        let cellar = dir.join("Cellar/patchr/0.1.0/bin/patchr");
        std::fs::create_dir_all(cellar.parent().unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("opt")).unwrap();
        std::fs::write(&cellar, "managed").unwrap();
        let built = dir.join("built");
        std::fs::write(&built, "built").unwrap();
        std::os::unix::fs::symlink(dir.join("Cellar/patchr/0.1.0"), dir.join("opt/patchr")).unwrap();

        let copied = placement(&built, &bin);
        assert_eq!(copied, Placement::Copied(built.clone()));
        place_binary(&copied, &bin).unwrap();
        assert_eq!(std::fs::read_to_string(&bin).unwrap(), "built");
        assert_eq!(placement(&bin, &bin), Placement::Kept);

        let linked = placement(&cellar, &bin);
        assert_eq!(linked, Placement::Linked(dir.join("opt/patchr/bin/patchr")));
        place_binary(&linked, &bin).unwrap();
        assert_eq!(std::fs::read_link(&bin).unwrap(), dir.join("opt/patchr/bin/patchr"));
        assert_eq!(placement(&cellar, &bin), Placement::Kept);

        // Replacing the link leaves what it led to alone.
        place_binary(&copied, &bin).unwrap();
        assert!(!bin.is_symlink());
        assert_eq!(std::fs::read_to_string(&cellar).unwrap(), "managed");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

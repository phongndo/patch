//! What harness adapters (`cli/harness/`) share: reading the command as the
//! user typed it, choosing the repository, and Codex's prompt hook. Codex has
//! no commands that run code, so a hook answers `$patch` before the model and
//! `codex queue` brings the feedback back as the user's next message.
//!
//! Feedback is never only in flight: a file in the state folder keeps it until an
//! adapter says its harness took the message (`patchr hook delivered`). It is for
//! the user to pick up; no later review reads it.

use std::fs::{File, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use crate::git;
use crate::install::home_dir;
use crate::server::state_dir;

/// Splits a command line like a shell would: quotes, backslashes and a leading `~`.
pub fn split(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quote: Option<char> = None;
    let mut home = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(open) if c == open => quote = None,
            Some('"') if c == '\\' && matches!(chars.peek(), Some('"' | '\\')) => {
                word.get_or_insert_default().extend(chars.next());
            }
            Some(_) => word.get_or_insert_default().push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                word.get_or_insert_default();
            }
            // On Windows a backslash separates folders.
            None if c == '\\' && cfg!(not(windows)) => {
                word.get_or_insert_default().push(chars.next().ok_or("The command ends with a lone backslash.")?);
            }
            None if c.is_whitespace() => {
                words.extend(word.take().map(|word| if home { expand_home(word) } else { word }));
                home = false;
            }
            None => {
                home |= c == '~' && word.is_none();
                word.get_or_insert_default().push(c);
            }
        }
    }
    if quote.is_some() {
        return Err("The command has an unmatched quote.".into());
    }
    words.extend(word.map(|word| if home { expand_home(word) } else { word }));
    Ok(words)
}

fn expand_home(word: String) -> String {
    match word.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{}{rest}", home_dir().display()),
        _ => word,
    }
}

/// The repository a file or folder is in, for the one the agent last worked in.
pub async fn repository_near(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(expand_home(path.to_string()));
    let directory = path.ancestors().find(|dir| dir.is_dir())?;
    git::find_root(directory).await.ok()
}

const RECEIPT: usize = 24;

fn unsent(receipt: &str) -> PathBuf {
    state_dir().join("unsent").join(format!("{receipt}.md"))
}

/// Keeps feedback until it is delivered, in a folder only the user can read.
pub fn keep(receipt: &str, text: &str) -> std::io::Result<PathBuf> {
    let file = unsent(receipt);
    private_dir(&state_dir().join("unsent"))?;
    let unfinished = file.with_extension("tmp");
    std::fs::write(&unfinished, text)?;
    std::fs::rename(unfinished, &file)?;
    Ok(file)
}

/// What an adapter reads: the feedback, the receipt that confirms delivery, and
/// where the feedback is kept until then.
pub fn receipt(text: &str) -> String {
    let receipt = crate::random_token(RECEIPT);
    let file = keep(&receipt, text).ok();
    json!({ "receipt": receipt, "text": text.trim(), "file": file }).to_string()
}

/// The harness took the feedback a receipt names. Receipts are only letters and
/// digits, so none of them names a file elsewhere.
pub fn delivered(receipt: &str) {
    if receipt.len() == RECEIPT && receipt.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        let _ = std::fs::remove_file(unsent(receipt));
    }
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

/// The arguments of a prompt that is a `$patch` command. Codex may write the
/// mention as a link to the skill: `[$patch](/path/SKILL.md)`.
fn patch_command(prompt: &str) -> Option<&str> {
    let prompt = prompt.trim();
    let rest = match prompt.strip_prefix("[$patch](") {
        Some(link) => link.split_once(')')?.1,
        None => prompt.strip_prefix("$patch")?,
    };
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim())
}

/// The file a Codex transcript last records as changed. Only applied edits are
/// recorded, under absolute paths.
fn last_changed(transcript: &str) -> Option<String> {
    transcript.lines().rev().filter(|line| line.contains("\"FileChange\"")).find_map(|line| {
        let entry: Value = serde_json::from_str(line).ok()?;
        let item = &entry["payload"]["item"];
        if entry["payload"]["type"] != "item_completed" || item["type"] != "FileChange" || item["status"] != "completed" {
            return None;
        }
        let (path, change) = item["changes"].as_object()?.iter().next_back()?;
        Some(change["move_path"].as_str().unwrap_or(path).to_string())
    })
}

/// A Codex thread's files, in a folder only the user can read.
struct Codex {
    dir: PathBuf,
    thread: String,
}

impl Codex {
    fn new(thread: &str) -> Option<Self> {
        if thread.is_empty() || !thread.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
            return None;
        }
        let dir = state_dir().join("codex");
        private_dir(&dir).ok()?;
        Some(Codex { dir, thread: thread.into() })
    }

    /// The running review's stderr: its URL, or why it failed. The review holds
    /// a lock on it for as long as it lives, so a dead one is never taken for open.
    fn log(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.thread))
    }

    fn url(&self) -> Option<String> {
        let log = std::fs::read_to_string(self.log()).ok()?;
        let (_, rest) = log.split_once("Patch is open at ")?;
        rest.split_once('\n').map(|(url, _)| url.to_string())
    }

    /// Keeps feedback `codex queue` refused, for the next prompt to carry.
    fn keep(&self, feedback: &str) -> std::io::Result<()> {
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let file = self.dir.join(format!("{}.{now:020}.md", self.thread));
        let unfinished = file.with_extension("tmp");
        std::fs::write(&unfinished, feedback)?;
        std::fs::rename(unfinished, file)
    }

    /// The feedback kept for this thread, oldest first.
    fn kept(&self) -> Vec<(PathBuf, String)> {
        let prefix = format!("{}.", self.thread);
        let entries = std::fs::read_dir(&self.dir).into_iter().flatten().flatten();
        let mut files: Vec<_> = entries
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "md"))
            .collect();
        files.sort();
        files.into_iter().filter_map(|file| std::fs::read_to_string(&file).ok().map(|text| (file, text))).collect()
    }
}

/// Opens a review for a Codex thread and returns what to tell the user.
fn open_for_codex(codex: &Codex, typed: &str, input: &Value) -> Result<String, String> {
    let started = Instant::now();
    let waiting = || started.elapsed() < Duration::from_secs(15);
    let pause = || std::thread::sleep(Duration::from_millis(25));

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let log = options.open(codex.log()).map_err(|error| error.to_string())?;
    loop {
        match log.try_lock() {
            Ok(()) => break,
            Err(TryLockError::Error(error)) => return Err(error.to_string()),
            Err(TryLockError::WouldBlock) => {}
        }
        if let Some(url) = codex.url() {
            return Ok(format!("Patch is already open at {url}"));
        }
        // Starting, or handing over its feedback.
        if !waiting() {
            return Err("Patch is already opening.".into());
        }
        pause();
    }
    log.set_len(0).map_err(|error| error.to_string())?;

    let cwd = PathBuf::from(input["cwd"].as_str().unwrap_or("."));
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.args(["review", "--typed", typed, "--codex", &codex.thread]);
    let transcript = input["transcript_path"].as_str().and_then(|path| std::fs::read_to_string(path).ok());
    if let Some(file) = transcript.as_deref().and_then(last_changed) {
        command.arg("--near").arg(cwd.join(file));
    }
    // The lock goes with the file to the review.
    command.current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
    // The review outlives this hook, whose process group Codex may end.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    while waiting() {
        if let Some(url) = codex.url() {
            return Ok(format!("Patch is open at {url}"));
        }
        if child.try_wait().ok().flatten().is_some() {
            let error = std::fs::read_to_string(codex.log()).unwrap_or_default();
            return Err(error.trim().to_string());
        }
        pause();
    }
    let _ = child.kill();
    Err("patchr: the review did not open.".into())
}

/// Codex's UserPromptSubmit hook. It sees every prompt, so anything that is not
/// `$patch` passes through untouched, with any feedback kept for it.
pub fn codex_hook() {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    let Ok(input) = serde_json::from_str::<Value>(&text) else { return };
    let Some(codex) = Codex::new(input["session_id"].as_str().unwrap_or_default()) else { return };
    if let Some(typed) = patch_command(input["prompt"].as_str().unwrap_or_default()) {
        let reason = open_for_codex(&codex, typed, &input).unwrap_or_else(|error| error);
        println!("{}", json!({ "decision": "block", "reason": reason }));
        return;
    }
    let (files, kept): (Vec<_>, Vec<_>) = codex.kept().into_iter().unzip();
    if kept.is_empty() {
        return;
    }
    let output = json!({ "hookEventName": "UserPromptSubmit", "additionalContext": kept.join("\n\n") });
    let output = json!({ "hookSpecificOutput": output });
    let mut stdout = std::io::stdout().lock();
    if writeln!(stdout, "{output}").and_then(|()| stdout.flush()).is_ok() {
        files.iter().for_each(|file| drop(std::fs::remove_file(file)));
    }
}

/// Ends a Codex review: its feedback, if any, becomes the thread's next message,
/// or is kept where the next prompt finds it.
pub fn finish_codex(thread: &str, feedback: Option<&str>) {
    let Some(codex) = Codex::new(thread) else { return };
    // Nobody should be sent to this review any more.
    let _ = File::options().write(true).truncate(true).open(codex.log());
    let Some(feedback) = feedback else { return };
    let queued = Command::new("codex")
        .args(["queue", "--thread", thread, &format!("--message={feedback}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !queued && let Err(error) = codex.keep(feedback) {
        eprintln!("patchr: could not keep the feedback: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_a_shell() {
        let words = |text| split(text).unwrap();
        assert_eq!(words(r#"--base main "my repo"/a 'b c'"#), ["--base", "main", "my repo/a", "b c"]);
        assert_eq!(words("  "), Vec::<String>::new());
        assert_eq!(words("''"), [""]);
        assert_eq!(words(r#""a \"b\" \n" '\'"#), [r#"a "b" \n"#, r"\"]);
        let home = home_dir().display().to_string();
        assert_eq!(words("~/x a~ '~/y'"), [format!("{home}/x"), "a~".into(), "~/y".into()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_backslash_escapes() {
        assert_eq!(split(r"my\ repo \'").unwrap(), ["my repo", "'"]);
        assert!(split(r"repo\").is_err());
    }

    #[test]
    fn an_unmatched_quote_is_an_error() {
        assert!(split("'my repo").is_err());
        assert!(split("say \"hi").is_err());
    }

    #[test]
    fn only_a_leading_patch_mention_is_the_command() {
        assert_eq!(patch_command("$patch"), Some(""));
        assert_eq!(patch_command(" $patch --base main "), Some("--base main"));
        assert_eq!(patch_command("[$patch](/s/SKILL.md) ../x"), Some("../x"));
        assert_eq!(patch_command("$patcher"), None);
        assert_eq!(patch_command("run $patch"), None);
    }

    #[test]
    fn finds_the_last_applied_edit() {
        let change = |status: &str, changes: &str| {
            format!(r#"{{"payload":{{"type":"item_completed","item":{{"type":"FileChange","status":"{status}","changes":{changes}}}}}}}"#)
        };
        let transcript = [
            change("completed", r#"{"/a/x.rs":{"type":"update","move_path":null},"/b/c d.rs":{"type":"delete"}}"#),
            change("failed", r#"{"/failed/x.rs":{"type":"add"}}"#),
            r#"{"payload":{"type":"message","text":"*** Update File: /quoted/x.rs, \"FileChange\""}}"#.into(),
        ]
        .join("\n");
        assert_eq!(last_changed(&transcript).as_deref(), Some("/b/c d.rs"));
        let moved = change("completed", r#"{"/a/x.rs":{"type":"update","move_path":"/c/y.rs"}}"#);
        assert_eq!(last_changed(&moved).as_deref(), Some("/c/y.rs"));
        assert_eq!(last_changed("nothing"), None);
    }
}

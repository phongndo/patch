//! What harness adapters (`cli/harness/`) share: reading the command as the
//! user typed it and choosing the repository.
//!
//! Feedback is never only in flight: the review's draft keeps it until an
//! adapter says its harness took the message (`patchr hook delivered`).

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::git;
use crate::install::home_dir;

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

/// What an adapter reads: the feedback, and the receipt that confirms delivery.
pub fn receipt(draft: &Path, text: &str) -> String {
    let key = draft.file_stem().unwrap_or_default().to_string_lossy();
    json!({ "receipt": key, "text": text.trim() }).to_string()
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
}

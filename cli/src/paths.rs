//! The paths a unified diff names, so file reads answer only for files in it.

use std::collections::HashSet;

/// Unquotes a path Git wrote in C style ("a\tb", "caf\303\251").
fn unquote(body: &str) -> String {
    let mut bytes = Vec::with_capacity(body.len());
    let raw = body.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        let byte = raw[index];
        if byte != b'\\' || index + 1 >= raw.len() {
            bytes.push(byte);
            index += 1;
            continue;
        }
        let next = raw[index + 1];
        if (b'0'..=b'7').contains(&next) && index + 4 <= raw.len() {
            let digits = std::str::from_utf8(&raw[index + 1..(index + 4).min(raw.len())]).unwrap_or("0");
            bytes.push(u8::from_str_radix(digits, 8).unwrap_or(b'?'));
            index += 4;
            continue;
        }
        bytes.push(match next {
            b'n' => b'\n',
            b't' => b'\t',
            b'a' => 7,
            b'b' => 8,
            b'f' => 12,
            b'r' => b'\r',
            b'v' => 11,
            other => other,
        });
        index += 2;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// A path as Git writes it in a header: quoted when unusual, maybe after a/ or b/.
fn header_path(text: &str, prefixed: bool) -> Option<String> {
    let (body, quoted) = match text.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
        Some(inner) => (inner, true),
        None => (text, false),
    };
    let body = if prefixed { body.strip_prefix("a/").or_else(|| body.strip_prefix("b/"))? } else { body };
    Some(if quoted { unquote(body) } else { body.to_string() })
}

/// The lines of each file's header: from `diff --git` to its first hunk. Lines
/// in a hunk are the file's text, which may read like a header (a removed line
/// `-- a/.env` shows as `--- a/.env`), so they never name a path.
fn header_lines(patch: &str) -> impl Iterator<Item = &str> {
    let mut in_header = false;
    patch.lines().filter(move |line| {
        if line.starts_with("diff --git ") {
            in_header = true;
        } else if line.starts_with("@@") {
            in_header = false;
        }
        in_header
    })
}

/// Every path a unified diff names on either side. Git ends a path that
/// contains a space with a tab, and quotes unusual ones.
#[cfg(test)]
pub fn patch_paths(patch: &str) -> HashSet<String> {
    review_paths(patch).0
}

/// Every path the diff touches.
#[cfg(test)]
pub fn changed_paths(patch: &str) -> HashSet<String> {
    review_paths(patch).1
}

/// In one pass: the paths the diff has text for (`patch_paths`), and every
/// path it touches, also those with no `---` and `+++` lines: a file renamed
/// unchanged, or a binary one. These have no text to read, so they only say
/// what is not unchanged.
pub fn review_paths(patch: &str) -> (HashSet<String>, HashSet<String>) {
    let mut texts = HashSet::new();
    let mut paths = HashSet::new();
    for line in header_lines(patch) {
        if let Some(rest) = line.strip_prefix("+++ ").or_else(|| line.strip_prefix("--- ")) {
            texts.extend(header_path(rest.strip_suffix('\t').unwrap_or(rest), true));
        } else if let Some(rest) =
            ["rename from ", "rename to ", "copy from ", "copy to "].iter().find_map(|prefix| line.strip_prefix(prefix))
        {
            paths.extend(header_path(rest, false));
        } else if let Some(rest) = line.strip_prefix("Binary files ").and_then(|rest| rest.strip_suffix(" differ")) {
            // Unquoted names may hold " and " themselves: take the first split where both sides read as paths.
            let side = |text: &str| if text == "/dev/null" { Some(None) } else { header_path(text, true).map(Some) };
            let found = rest.match_indices(" and ").find_map(|(at, _)| Some((side(&rest[..at])?, side(&rest[at + 5..])?)));
            if let Some((old, new)) = found {
                paths.extend(old.into_iter().chain(new));
            }
        }
    }
    paths.extend(texts.iter().cloned());
    (texts, paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_spaced_and_quoted_paths() {
        let patch = [
            "diff --git a/plain.ts b/plain.ts",
            "--- a/plain.ts",
            "+++ b/plain.ts",
            "diff --git a/with space.txt b/with space.txt",
            "--- /dev/null",
            "+++ b/with space.txt\t",
            "diff --git \"a/caf\\303\\251 \\\"q\\\".md\" \"b/caf\\303\\251 \\\"q\\\".md\"",
            "--- \"a/caf\\303\\251 \\\"q\\\".md\"",
            "+++ \"b/caf\\303\\251 \\\"q\\\".md\"",
        ]
        .join("\n");
        let paths = patch_paths(&patch);
        assert!(paths.contains("plain.ts"));
        assert!(paths.contains("with space.txt"));
        assert!(paths.contains("café \"q\".md"));
        assert_eq!(paths.len(), 3);
    }

    #[test]
    fn renamed_unchanged_and_binary_files() {
        let patch = [
            "diff --git a/old name.ts b/new.ts",
            "similarity index 100%",
            "rename from old name.ts",
            "rename to new.ts",
            "diff --git a/logo.png b/logo.png",
            "Binary files a/logo.png and b/logo.png differ",
            "Binary files /dev/null and b/cats and dogs.png differ",
        ]
        .join("\n");
        assert!(patch_paths(&patch).is_empty());
        let mut paths: Vec<_> = changed_paths(&patch).into_iter().collect();
        paths.sort();
        assert_eq!(paths, ["cats and dogs.png", "logo.png", "new.ts", "old name.ts"]);
    }

    #[test]
    fn a_hunk_line_that_reads_like_a_header_names_nothing() {
        let patch = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,2 +1,1 @@",
            "--- a/.env",
            "+++ b/secret",
            "-rename from x",
            " kept",
        ]
        .join("\n");
        let mut paths: Vec<_> = changed_paths(&patch).into_iter().collect();
        paths.sort();
        assert_eq!(paths, ["a.ts"]);
    }
}

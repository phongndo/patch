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

/// Every path a unified diff names on either side. Git ends a path that
/// contains a space with a tab, and quotes unusual ones.
pub fn patch_paths(patch: &str) -> HashSet<String> {
    let mut paths = HashSet::new();
    for line in patch.lines() {
        let Some(rest) = line.strip_prefix("+++ ").or_else(|| line.strip_prefix("--- ")) else {
            continue;
        };
        let rest = rest.strip_suffix('\t').unwrap_or(rest);
        if let Some(quoted) = rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
            if let Some(path) = quoted.strip_prefix("a/").or_else(|| quoted.strip_prefix("b/")) {
                paths.insert(unquote(path));
            }
        } else if let Some(path) = rest.strip_prefix("a/").or_else(|| rest.strip_prefix("b/")) {
            paths.insert(path.to_string());
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_spaced_and_quoted_paths() {
        let patch = [
            "--- a/plain.ts",
            "+++ b/plain.ts",
            "--- /dev/null",
            "+++ b/with space.txt\t",
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
}

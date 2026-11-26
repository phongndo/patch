//! Turns a submitted review into the text the agent reads on stdout.
//! `web/feedback.ts` writes the same for a page that has lost its review.

use crate::protocol::{Comment, Submission};

pub const PASSED: &str = "The user reviewed the changes in Patch and has no comments. The review passed.";

const ASK: &str = "The user reviewed the changes and left the numbered comments below. Address every one: make the change it asks for or, if it only asks a question, answer it without changing code for it. Then say what you did for each, by number.";

pub const CLOSED: &str =
    "The review was closed without feedback. This is not an approval: do not continue the work unless the user asks.";

fn fence_for(lines: &[String]) -> String {
    let mut fence = String::from("```");
    while lines.iter().any(|line| line.contains(&fence)) {
        fence.push('`');
    }
    fence
}

fn language(file: &str) -> String {
    match file.rsplit_once('.') {
        Some((_, extension))
            if !extension.is_empty() && !extension.contains('/') && extension.bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            extension.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

fn range(comment: &Comment) -> String {
    match (comment.start, comment.end) {
        (0, _) => " (the whole file)".into(),
        (start, end) if start == end => format!(":{start}"),
        (start, end) => format!(":{start}-{end}"),
    }
}

pub fn format(submission: &Submission, repository: &str, root: &str) -> String {
    let mut comments: Vec<&Comment> = submission.comments.iter().filter(|c| !c.body.trim().is_empty()).collect();
    if comments.is_empty() {
        return PASSED.into();
    }

    let mut out: Vec<String> = Vec::new();
    out.push(format!("# Review feedback ({repository})"));
    out.push(String::new());
    out.push(ASK.into());
    out.push(format!("Paths are relative to {root}."));
    let mut number = 0;
    // Global comments belong to no file.
    let global: Vec<&str> = comments.iter().filter(|c| c.file.is_empty()).map(|c| c.body.trim()).collect();
    if !global.is_empty() {
        out.extend(["".into(), "## Global".into(), String::new()]);
        for body in &global {
            number += 1;
            // Later lines indent under the number.
            let mark = format!("{number}. ");
            out.push(format!("{mark}{}", body.replace('\n', &format!("\n{}", " ".repeat(mark.len())))));
        }
    }
    comments.retain(|c| !c.file.is_empty());

    comments.sort_by(|a, b| a.file.to_lowercase().cmp(&b.file.to_lowercase()).then(a.start.cmp(&b.start)));
    let mut current: Option<&str> = None;
    for comment in comments {
        let file = comment.file.as_str();
        if current != Some(file) {
            out.extend(["".into(), format!("## {file}")]);
            current = Some(file);
        }
        number += 1;
        let mut heading = format!("### {number}. {file}{}", range(comment));
        if comment.side == "deletions" && comment.start > 0 {
            heading.push_str(" (old side, removed lines)");
        }
        if let Some(scope) = &comment.scope {
            heading.push_str(&format!(" (in {scope})"));
        }
        out.extend(["".into(), heading]);
        if !comment.excerpt.is_empty() {
            let fence = fence_for(&comment.excerpt);
            out.push(String::new());
            out.push(format!("{fence}{}", language(file)));
            out.extend(comment.excerpt.iter().cloned());
            out.push(fence);
        }
        out.extend(["".into(), comment.body.trim().into()]);
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(side: &str, start: u64, end: u64, excerpt: &[&str]) -> Comment {
        Comment {
            id: "1".into(),
            file: "src/a.ts".into(),
            side: side.into(),
            start,
            end,
            body: "Rename this.".into(),
            excerpt: excerpt.iter().map(|s| s.to_string()).collect(),
            scope: None,
            created_at: None,
        }
    }

    #[test]
    fn a_review_with_nothing_to_say_is_one_line() {
        let mut blank = comment("additions", 2, 2, &[]);
        blank.body = " ".into();
        for comments in [vec![], vec![blank]] {
            assert_eq!(format(&Submission { comments }, "demo", "/repo"), PASSED);
        }
    }

    #[test]
    fn comments_carry_location_lines_and_a_safe_fence() {
        let s = Submission { comments: vec![comment("additions", 2, 3, &["const x = 1;", "```"])] };
        let text = format(&s, "demo", "/repo");
        assert!(text.contains("### 1. src/a.ts:2-3"));
        assert!(text.contains("````ts\nconst x = 1;\n```\n````"));
    }

    #[test]
    fn old_side_and_scope_are_named() {
        let mut c = comment("deletions", 4, 4, &[]);
        c.scope = Some("PR #1".into());
        let s = Submission { comments: vec![c] };
        assert!(format(&s, "demo", "/repo").contains("src/a.ts:4 (old side, removed lines) (in PR #1)"));
    }

    #[test]
    fn global_comments_come_first_and_numbers_go_on() {
        let mut first = comment("additions", 0, 0, &[]);
        first.file = String::new();
        first.body = "Split this PR.".into();
        let mut second = first.clone();
        second.body = "Add tests.\nFor both paths.".into();
        let s = Submission { comments: vec![comment("additions", 2, 2, &[]), first, second] };
        let text = format(&s, "demo", "/repo");
        assert!(
            text.contains(
                "## Global\n\n1. Split this PR.\n2. Add tests.\n   For both paths.\n\n## src/a.ts\n\n### 3. src/a.ts:2"
            )
        );
    }

    #[test]
    fn a_comment_on_a_whole_file_comes_before_its_lines() {
        let s = Submission { comments: vec![comment("additions", 2, 2, &[]), comment("deletions", 0, 0, &[])] };
        let text = format(&s, "demo", "/repo");
        assert!(text.contains("### 1. src/a.ts (the whole file)\n\nRename this.\n\n### 2. src/a.ts:2\n"));
    }

    #[test]
    fn closing_is_never_approval() {
        assert!(CLOSED.contains("not an approval"));
    }
}

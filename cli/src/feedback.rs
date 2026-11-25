//! Turns a submitted review into the text the agent reads on stdout.
//! `web/feedback.ts` writes the same for a page that has lost its review.

use crate::protocol::{Comment, Decision, Submission};

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
    if comment.start == comment.end { comment.start.to_string() } else { format!("{}-{}", comment.start, comment.end) }
}

pub fn format(submission: &Submission, repository: &str, root: &str) -> String {
    let mut comments: Vec<&Comment> = submission.comments.iter().filter(|c| !c.body.trim().is_empty()).collect();
    let approve = submission.decision == Decision::Approve;
    if approve && comments.is_empty() {
        return "The user reviewed the changes in Patch and approved them with no comments.".into();
    }

    let mut out: Vec<String> = Vec::new();
    out.push(if approve {
        format!("# Review: approved with notes ({repository})")
    } else {
        format!("# Review feedback ({repository})")
    });
    out.push(String::new());
    out.push(
        if approve {
            "The user approved these changes. Treat the notes below as guidance, not blocking requests."
        } else {
            "The user reviewed the changes and left feedback. Address every comment, then summarize what you changed."
        }
        .into(),
    );
    out.push(format!("Paths are relative to {root}."));
    // General comments belong to no file.
    let general: Vec<&str> = comments.iter().filter(|c| c.file.is_empty()).map(|c| c.body.trim()).collect();
    if !general.is_empty() {
        out.extend(["".into(), "## General".into(), String::new()]);
        for body in general {
            // One bullet per comment; later lines indent under it.
            out.push(format!("- {}", body.replace('\n', "\n  ")));
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
        let mut heading = format!("### {file}:{}", range(comment));
        if comment.side == "deletions" {
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
    fn approval_with_nothing_to_say_is_one_line() {
        let s = Submission { decision: Decision::Approve, comments: vec![] };
        assert!(format(&s, "demo", "/repo").contains("approved them with no comments"));
    }

    #[test]
    fn comments_carry_location_lines_and_a_safe_fence() {
        let s = Submission { decision: Decision::Comment, comments: vec![comment("additions", 2, 3, &["const x = 1;", "```"])] };
        let text = format(&s, "demo", "/repo");
        assert!(text.contains("### src/a.ts:2-3"));
        assert!(text.contains("````ts\nconst x = 1;\n```\n````"));
    }

    #[test]
    fn old_side_and_scope_are_named() {
        let mut c = comment("deletions", 4, 4, &[]);
        c.scope = Some("PR #1".into());
        let s = Submission { decision: Decision::Comment, comments: vec![c] };
        assert!(format(&s, "demo", "/repo").contains("src/a.ts:4 (old side, removed lines) (in PR #1)"));
    }

    #[test]
    fn general_comments_come_first_as_bullets() {
        let mut first = comment("additions", 0, 0, &[]);
        first.file = String::new();
        first.body = "Split this PR.".into();
        let mut second = first.clone();
        second.body = "Add tests.\nFor both paths.".into();
        let s = Submission { decision: Decision::Comment, comments: vec![comment("additions", 2, 2, &[]), first, second] };
        let text = format(&s, "demo", "/repo");
        assert!(text.contains("## General\n\n- Split this PR.\n- Add tests.\n  For both paths.\n\n## src/a.ts"));
    }

    #[test]
    fn closing_is_never_approval() {
        assert!(CLOSED.contains("not an approval"));
    }
}

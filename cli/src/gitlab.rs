//! Merge requests through the GitLab CLI, as `github.rs` reads pull requests: nothing is fetched
//! into the repository. A merge request's `diff_refs` are read once, and its diff is then
//! compared between exactly those commits, so the patch and every file read for it are of one
//! snapshot. Its old side is `base_sha`, where it branched off, as GitLab diffs it.
//!
//! The project is named from the remote's URL and `glab` runs outside the repository: left to
//! find the project itself, `glab` may record what it resolved in the repository's Git config.
//!
//! GitLab sends each file's hunks without Git's header, so the patch is written here from what it
//! says of each file: its paths, modes, and whether it was added, deleted or renamed.

use serde::Deserialize;

use crate::git::{NOT_FILE, Result, Run, run, run_bytes};
use crate::github::PullRequestDiff;
use crate::protocol::PullRequest;

/// The most pages of 100 a list is read to.
const PAGES: usize = 100;

/// Each file's paths before and after, in the patch's order.
type Files = Vec<(Option<String>, Option<String>)>;

/// A GitLab project: its host, and its path there (`group/subgroup/name`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub host: String,
    pub path: String,
}

impl Project {
    /// The project a remote's URL names, if it names one on a host.
    pub fn of_remote(url: &str) -> Option<Project> {
        let host = crate::github::url_host(url)?;
        // GitLab.com's SSH on port 443 is the same GitLab, whose API is on its own name.
        let host = if host == "altssh.gitlab.com" { "gitlab.com".to_string() } else { host };
        let path = match url.split_once("://") {
            // `https://host[:port]/path` or `ssh://user@host[:port]/path`.
            Some((_, rest)) => rest.split_once('/')?.1,
            // `user@host:path`.
            None => url.split_once(':')?.1,
        };
        let path = path.trim_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
        let named = path.contains('/') && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..");
        named.then(|| Project { host, path: path.into() })
    }

    /// `glab api` on the project's host for `endpoint`, run outside the repository.
    async fn api(&self, endpoint: &str) -> Result<String> {
        run("glab", &std::env::temp_dir(), &["api", "--hostname", &self.host, endpoint], Run::default()).await
    }

    /// `endpoint` under the project, as JSON.
    async fn json<T: for<'a> Deserialize<'a>>(&self, endpoint: &str) -> Result<T> {
        let out = self.api(&format!("projects/{}/{endpoint}", encode(&self.path))).await?;
        serde_json::from_str(&out).map_err(|error| format!("GitLab answered what Patch can't read: {error}"))
    }

    /// Every page of a list under the project, up to `PAGES` of them. Paged here: `glab
    /// --paginate` writes each page as a list of its own.
    async fn all<T: for<'a> Deserialize<'a>>(&self, endpoint: &str) -> Result<Vec<T>> {
        let mut all = Vec::new();
        for page in 1..=PAGES {
            let join = if endpoint.contains('?') { '&' } else { '?' };
            let listed: Vec<T> = self.json(&format!("{endpoint}{join}per_page=100&page={page}")).await?;
            let last = listed.len() < 100;
            all.extend(listed);
            if last {
                return Ok(all);
            }
        }
        Err("GitLab lists too much here for Patch to read.".into())
    }

    /// The first entry of a list under the project that `wanted` admits, read a page at a time
    /// until it is found.
    async fn find<T: for<'a> Deserialize<'a>>(&self, endpoint: &str, wanted: impl Fn(&T) -> bool) -> Result<Option<T>> {
        for page in 1..=PAGES {
            let join = if endpoint.contains('?') { '&' } else { '?' };
            let listed: Vec<T> = self.json(&format!("{endpoint}{join}per_page=100&page={page}")).await?;
            let last = listed.len() < 100;
            if let Some(found) = listed.into_iter().find(&wanted) {
                return Ok(Some(found));
            }
            if last {
                return Ok(None);
            }
        }
        Ok(None)
    }

    /// Whether the host is a GitLab with this project, for one whose name says nothing.
    pub async fn exists(&self) -> bool {
        #[derive(Deserialize)]
        struct Found {
            path_with_namespace: String,
        }
        let found = self.api(&format!("projects/{}", encode(&self.path))).await;
        found
            .ok()
            .and_then(|found| serde_json::from_str::<Found>(&found).ok())
            .is_some_and(|found| found.path_with_namespace.eq_ignore_ascii_case(&self.path))
    }
}

/// A GitLab `glab` is set up for: its name (where its API is), and the host its SSH remotes
/// name when that differs.
#[derive(Debug, PartialEq, Eq)]
pub struct Configured {
    pub name: String,
    pub ssh_host: Option<String>,
    /// The path GitLab is installed under on its host, which a remote's URL starts with.
    pub subfolder: Option<String>,
}

/// The GitLabs `glab` is set up for, from its configuration, and `GITLAB_HOST`. Only these are
/// asked about a host whose name does not say it is a GitLab: `glab` sends credentials with what
/// it asks, which an older one would send to any host.
pub async fn configured() -> Vec<Configured> {
    let mut hosts = Vec::new();
    for name in ["GITLAB_HOST", "GL_HOST"] {
        if let Some(host) = std::env::var(name).ok().and_then(|host| crate::github::url_host(&host).or(Some(host))) {
            hosts.push(Configured { name: host.to_ascii_lowercase(), ssh_host: None, subfolder: None });
        }
    }
    let path = run("glab", &std::env::temp_dir(), &["config", "path"], Run::default()).await.unwrap_or_default();
    let text = std::fs::read_to_string(path.trim()).unwrap_or_default();
    hosts.extend(configured_in(&text));
    hosts
}

/// The hosts under `hosts:` in `glab`'s configuration, each with its `ssh_host`. Read line by
/// line: nothing else of it (its tokens) is kept.
fn configured_in(config: &str) -> Vec<Configured> {
    let mut hosts: Vec<Configured> = Vec::new();
    let mut lines = config.lines().skip_while(|line| line.trim_end() != "hosts:").skip(1);
    let mut indent = None;
    for line in lines.by_ref() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let at = line.len() - trimmed.len();
        if at == 0 {
            break;
        }
        let indent = *indent.get_or_insert(at);
        if at == indent {
            if let Some(name) = trimmed.trim_end().strip_suffix(':') {
                let name = name.trim_matches(['"', '\'']).to_ascii_lowercase();
                hosts.push(Configured { name, ssh_host: None, subfolder: None });
            }
        } else if let Some(host) = hosts.last_mut() {
            let value = |key: &str| {
                let value = trimmed.strip_prefix(key)?.trim().trim_matches(['"', '\'']).trim_matches('/');
                (!value.is_empty()).then(|| value.to_string())
            };
            if let Some(ssh_host) = value("ssh_host:") {
                host.ssh_host = Some(ssh_host.to_ascii_lowercase());
            } else if let Some(subfolder) = value("subfolder:") {
                host.subfolder = Some(subfolder);
            }
        }
    }
    hosts
}

/// A path or query value as one URL component.
fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One file of a comparison, as GitLab reports it.
#[derive(Deserialize)]
struct Diff {
    old_path: String,
    new_path: String,
    #[serde(default, deserialize_with = "text_or_null")]
    a_mode: String,
    #[serde(default, deserialize_with = "text_or_null")]
    b_mode: String,
    #[serde(default)]
    diff: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    renamed_file: bool,
    #[serde(default)]
    deleted_file: bool,
    /// Left out of the answer for its size: its `diff` is empty, whatever changed.
    #[serde(default)]
    too_large: bool,
    #[serde(default)]
    collapsed: bool,
}

/// A string GitLab may send as `null`.
fn text_or_null<'de, D: serde::Deserializer<'de>>(from: D) -> std::result::Result<String, D::Error> {
    Ok(Option::<String>::deserialize(from)?.unwrap_or_default())
}

/// A path in a patch's header as Git writes it: in quotes, with C escapes, when it holds a quote,
/// a backslash or a control character (a newline would end the header).
fn quoted(prefix: &str, path: &str) -> String {
    if !path.chars().any(|char| char == '"' || char == '\\' || char.is_control()) {
        return format!("{prefix}{path}");
    }
    let mut out = String::from("\"");
    for char in format!("{prefix}{path}").chars() {
        match char {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            char if char.is_control() => {
                let mut bytes = [0; 4];
                for byte in char.encode_utf8(&mut bytes).bytes() {
                    out.push_str(&format!("\\{byte:03o}"));
                }
            }
            char => out.push(char),
        }
    }
    out.push('"');
    out
}

impl Diff {
    /// Its paths before and after.
    fn sides(&self) -> (Option<String>, Option<String>) {
        ((!self.new_file).then(|| self.old_path.clone()), (!self.deleted_file).then(|| self.new_path.clone()))
    }
}

/// The files GitLab compared, as one patch in Git's form, and each file's paths in its order.
fn patch(diffs: &[Diff]) -> (String, Files) {
    let mut out = String::new();
    for file in diffs {
        let (old, new) = (&file.old_path, &file.new_path);
        out.push_str(&format!("diff --git {} {}\n", quoted("a/", old), quoted("b/", new)));
        if file.new_file {
            out.push_str(&format!("new file mode {}\n", file.b_mode));
        } else if file.deleted_file {
            out.push_str(&format!("deleted file mode {}\n", file.a_mode));
        } else if file.a_mode != file.b_mode && !file.a_mode.is_empty() && !file.b_mode.is_empty() {
            out.push_str(&format!("old mode {}\nnew mode {}\n", file.a_mode, file.b_mode));
        }
        if file.renamed_file {
            // GitLab doesn't say how alike the two are. Git's figure only tells a pure rename (100%)
            // from one with changes, which is all the page reads of it.
            let similarity = if file.diff.is_empty() { 100 } else { 50 };
            out.push_str(&format!(
                "similarity index {similarity}%\nrename from {}\nrename to {}\n",
                quoted("", old),
                quoted("", new)
            ));
        }
        let body = file.diff.as_str();
        // Hunks alone, unless GitLab wrote the header lines too (`unidiff`), or said it is binary.
        if body.starts_with("@@") {
            let from = if file.new_file { "/dev/null".to_string() } else { quoted("a/", old) };
            let to = if file.deleted_file { "/dev/null".to_string() } else { quoted("b/", new) };
            out.push_str(&format!("--- {from}\n+++ {to}\n"));
        }
        out.push_str(body);
        if !body.is_empty() && !body.ends_with('\n') {
            out.push('\n');
        }
    }
    (out, diffs.iter().map(Diff::sides).collect())
}

#[derive(Deserialize)]
struct Compared {
    #[serde(default)]
    diffs: Vec<Diff>,
    #[serde(default)]
    compare_timeout: bool,
}

/// Refuses a comparison GitLab cut short: a file it left out would read as unchanged.
fn left_out(diffs: &[Diff]) -> Result<()> {
    let left: Vec<&str> = diffs
        .iter()
        .filter(|file| (file.too_large || file.collapsed) && file.diff.is_empty())
        .map(|file| file.new_path.as_str())
        .collect();
    if left.is_empty() {
        return Ok(());
    }
    Err(format!("GitLab leaves out the diff of {} as too large, so Patch would show it unchanged.", left.join(", ")))
}

/// The diff from `from` to `to`, directly between the two (`straight`), not from where they met.
async fn compare(project: &Project, from: &str, to: &str) -> Result<(String, Files)> {
    let endpoint = format!("repository/compare?from={}&to={}&straight=true", encode(from), encode(to));
    let compared: Compared = project.json(&endpoint).await?;
    if compared.compare_timeout {
        return Err("GitLab took too long to compare this change.".into());
    }
    left_out(&compared.diffs)?;
    Ok(patch(&compared.diffs))
}

/// Commits' diff from GitLab, from `parent` to `to`: for a partial clone without their contents.
/// `files`, when given, is how many files the commit has, as the repository lists them.
pub async fn read_commits(
    project: &Project,
    parent: &str,
    first: &str,
    to: &str,
    files: Option<usize>,
) -> Result<(String, Files)> {
    // The first commit has no parent to compare with; GitLab diffs it alone, but no run from it.
    if parent == crate::git::EMPTY_TREE {
        if first != to {
            return Err("GitLab diffs no run of commits from the very first one.".into());
        }
        let diffs: Vec<Diff> = project.all(&format!("repository/commits/{}/diff", encode(to))).await?;
        left_out(&diffs)?;
        // GitLab stops listing a commit's files at a limit of its own, without saying so; with no
        // count of them here (a partial clone without trees), whether it listed all can't be told.
        match files {
            Some(files) if diffs.len() >= files => {}
            Some(_) => return Err("GitLab lists only some of this commit's files.".into()),
            None => {
                return Err("This partial clone can't count this commit's files, to tell whether GitLab listed them all.".into());
            }
        }
        return Ok(patch(&diffs));
    }
    compare(project, parent, to).await
}

#[derive(Deserialize)]
struct DiffRefs {
    base_sha: Option<String>,
    head_sha: Option<String>,
}

#[derive(Deserialize)]
struct MergeRequest {
    iid: u64,
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    author: Option<Author>,
    diff_refs: Option<DiffRefs>,
}

#[derive(Deserialize)]
struct Author {
    username: String,
}

impl From<MergeRequest> for PullRequest {
    fn from(request: MergeRequest) -> PullRequest {
        PullRequest {
            number: request.iid,
            title: request.title,
            author: request.author.map(|author| author.username).unwrap_or_else(|| "ghost".into()),
            head: request.source_branch,
            base: request.target_branch,
            updated: request.updated_at,
            draft: request.draft || request.work_in_progress,
            // GitLab's "opened", and "locked", which is closed to discussion.
            state: match request.state.as_str() {
                "opened" => "open",
                "merged" => "merged",
                _ => "closed",
            }
            .into(),
        }
    }
}

pub async fn read_merge_request(project: &Project, iid: u64) -> Result<PullRequestDiff> {
    let request: MergeRequest = project.json(&format!("merge_requests/{iid}")).await?;
    let refs = request.diff_refs.as_ref();
    let (Some(base), Some(head)) = (refs.and_then(|refs| refs.base_sha.clone()), refs.and_then(|refs| refs.head_sha.clone()))
    else {
        return Err("GitLab has not prepared this merge request's diff yet; try again in a moment.".into());
    };
    let (patch, files) = compare(project, &base, &head).await?;
    Ok(PullRequestDiff { number: request.iid, title: request.title, base_sha: base, head_sha: head, patch, files })
}

/// The merge requests a page lists at a time.
const PAGE: usize = 30;

/// A page of merge requests, newest activity first, and the next page's number: the open ones,
/// or those GitLab's search of titles and descriptions finds for `query`. `is:closed`,
/// `is:merged` or `is:all` in it choose another state. A number, or `!` and a number, also finds
/// that merge request first, whatever its state.
pub async fn list_merge_requests(
    project: &Project,
    query: &str,
    after: Option<&str>,
) -> Result<(Vec<PullRequest>, Option<String>)> {
    let page: usize = after.and_then(|after| after.parse().ok()).filter(|page| *page > 0).unwrap_or(1);
    let query = query.trim();
    let mut state = "opened";
    let mut words = Vec::new();
    for word in query.split_whitespace() {
        match word {
            "is:open" | "is:opened" => state = "opened",
            "is:closed" => state = "closed",
            "is:merged" => state = "merged",
            "is:all" => state = "all",
            word => words.push(word),
        }
    }
    let number = query.trim_start_matches(['!', '#']).parse::<u64>().ok();
    let mut endpoint = format!("merge_requests?state={state}&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}");
    // A number alone is no text to search for, on any page.
    if !words.is_empty() && number.is_none() {
        endpoint.push_str(&format!("&search={}", encode(&words.join(" "))));
    }
    let listed = project.json::<Vec<MergeRequest>>(&endpoint);
    // Asked for by its number: found on the first page, open or not.
    let exact = async { project.json::<MergeRequest>(&format!("merge_requests/{}", number.filter(|_| page == 1)?)).await.ok() };
    let (listed, exact) = tokio::join!(listed, exact);
    let listed = listed?;
    let next = (listed.len() == PAGE).then(|| (page + 1).to_string());
    let mut requests: Vec<PullRequest> = listed.into_iter().map(PullRequest::from).collect();
    if let Some(exact) = exact.map(PullRequest::from) {
        requests.retain(|request| request.number != exact.number);
        requests.insert(0, exact);
    }
    Ok((requests, next))
}

#[derive(Deserialize)]
struct TreeEntry {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    mode: String,
}

/// A regular file at a commit, from the repository's GitLab project: found in its folder's
/// listing, which says what it is (a link, a submodule), then its blob by id. A folder in its
/// path that is a link has no listing, so nothing beyond it is reached.
pub async fn read_remote_bytes(project: &Project, sha: &str, path: &str, limit: u64) -> Result<Vec<u8>> {
    let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
    let mut endpoint = format!("repository/tree?ref={}", encode(sha));
    if !folder.is_empty() {
        endpoint.push_str(&format!("&path={}", encode(folder)));
    }
    let found = project.find(&endpoint, |entry: &TreeEntry| entry.name == name).await;
    let entry = found.ok().flatten().ok_or_else(|| NOT_FILE.to_string())?;
    if entry.kind != "blob" || !matches!(entry.mode.as_str(), "100644" | "100755") {
        return Err(NOT_FILE.into());
    }
    let blob = format!("projects/{}/repository/blobs/{}/raw", encode(&project.path), encode(&entry.id));
    run_bytes("glab", &std::env::temp_dir(), &["api", "--hostname", &project.host, &blob], Run::default(), limit).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(old: &str, new: &str, body: &str) -> Diff {
        Diff {
            old_path: old.into(),
            new_path: new.into(),
            a_mode: "100644".into(),
            b_mode: "100644".into(),
            diff: body.into(),
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            too_large: false,
            collapsed: false,
        }
    }

    #[test]
    fn a_file_gitlab_left_out_is_refused_not_shown_unchanged() {
        assert!(left_out(&[diff("a", "a", "@@ -1 +1 @@\n-a\n+b\n")]).is_ok());
        let big = Diff { too_large: true, ..diff("big.json", "big.json", "") };
        assert!(left_out(&[big]).unwrap_err().contains("big.json"));
    }

    #[test]
    fn gitlab_files_read_as_one_git_patch() {
        let added = Diff { new_file: true, a_mode: "0".into(), ..diff("n.txt", "n.txt", "@@ -0,0 +1 @@\n+new\n") };
        let gone = Diff { deleted_file: true, b_mode: "0".into(), ..diff("g.txt", "g.txt", "@@ -1 +0,0 @@\n-old") };
        let moved = Diff { renamed_file: true, ..diff("a.txt", "b.txt", "") };
        let mode = Diff { b_mode: "100755".into(), ..diff("x.sh", "x.sh", "") };
        let image = diff("i.png", "i.png", "Binary files a/i.png and b/i.png differ\n");
        let (patch, files) = patch(&[added, gone, moved, mode, image]);
        assert_eq!(
            patch,
            [
                "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+new\n",
                "diff --git a/g.txt b/g.txt\ndeleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
                "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n",
                "diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n",
                "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n",
            ]
            .concat()
        );
        let some = |path: &str| Some(path.to_string());
        assert_eq!(
            files,
            [
                (None, some("n.txt")),
                (some("g.txt"), None),
                (some("a.txt"), some("b.txt")),
                (some("x.sh"), some("x.sh")),
                (some("i.png"), some("i.png")),
            ]
        );
    }

    #[test]
    fn a_remote_names_its_project() {
        let project = |url: &str| Project::of_remote(url).map(|project| format!("{} {}", project.host, project.path));
        assert_eq!(project("https://gitlab.com/gitlab-org/cli.git").as_deref(), Some("gitlab.com gitlab-org/cli"));
        assert_eq!(project("git@gitlab.com:org/team/svc.git").as_deref(), Some("gitlab.com org/team/svc"));
        assert_eq!(project("ssh://git@GitLab.corp:2222/a/b/").as_deref(), Some("gitlab.corp a/b"));
        assert_eq!(project("https://token@gitlab.com/a/b").as_deref(), Some("gitlab.com a/b"));
        assert_eq!(project("https://gitlab.com/lonely"), None);
        assert_eq!(project("https://gitlab.com/a/../b"), None);
        assert_eq!(project("/tmp/repo"), None);
    }

    #[test]
    fn glab_names_the_hosts_it_is_set_up_for_and_nothing_else_is_kept() {
        let config = "host: gitlab.com\nhosts:\n    gitlab.com:\n        token: secret\n        ssh_host:\n    code.acme.dev:\n        api_host: code.acme.dev\n        ssh_host: ssh.acme.dev\n        subfolder: /gitlab/\n        token: other\nnext: 1\n";
        assert_eq!(
            configured_in(config),
            [
                Configured { name: "gitlab.com".into(), ssh_host: None, subfolder: None },
                Configured {
                    name: "code.acme.dev".into(),
                    ssh_host: Some("ssh.acme.dev".into()),
                    subfolder: Some("gitlab".into())
                },
            ]
        );
        assert_eq!(configured_in("hosts: {}\n"), []);
    }

    #[test]
    fn gitlabs_other_ssh_host_is_gitlab_com() {
        let project = Project::of_remote("ssh://git@altssh.gitlab.com:443/a/b.git").unwrap();
        assert_eq!(project.host, "gitlab.com");
    }

    #[test]
    fn a_path_git_would_quote_is_quoted() {
        assert_eq!(quoted("a/", "plain name.txt"), "a/plain name.txt");
        assert_eq!(quoted("a/", "two\nlines"), "\"a/two\\nlines\"");
        assert_eq!(quoted("b/", "say \"hi\""), "\"b/say \\\"hi\\\"\"");
    }

    #[test]
    fn values_are_one_url_component() {
        assert_eq!(encode("src/a b.ts"), "src%2Fa%20b.ts");
        assert_eq!(encode("fix&state=all"), "fix%26state%3Dall");
    }
}

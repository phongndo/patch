//! One review session: an HTTP server for the page, resolved when the reviewer
//! submits or leaves. It listens on loopback and, when the machine is on a
//! tailnet, on the same port at its Tailscale address. Then every request
//! carries a pass in a cookie, which the review's link trades for it and which
//! works only from the address that traded it; where the machine has an owner,
//! only the owner's own devices (`tailscale whois`) may trade it from the
//! tailnet, so the link alone lets no one else in. Without a tailnet, loopback
//! needs nothing.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::git::{self, Ref, Review};
use crate::paths::review_paths;
use crate::protocol::{
    ChangedPaths, CommitsResponse, GrepMatch, Mode, PullRequestsResponse, ReviewResponse, Scope, ScopesResponse, Submission,
};
use crate::tailnet::{self, Account};
use crate::{github, history, protocol};

/// One file of the page as a release build embeds it: compressed where Vite left
/// compressed copies (build.rs), else as it is.
struct Asset {
    name: &'static str,
    raw: Option<&'static [u8]>,
    br: Option<&'static [u8]>,
    gz: Option<&'static [u8]>,
}

/// Sorted by name. Empty in a development build, which reads the page from disk.
static PAGE: &[Asset] = include!(concat!(env!("OUT_DIR"), "/page.rs"));

fn embedded(name: &str) -> Option<&'static Asset> {
    PAGE.binary_search_by(|asset| asset.name.cmp(name)).ok().map(|at| &PAGE[at])
}

/// How long after its tab closed a review ends: no time for the reader, enough
/// for messages that pass each other.
const CLOSE_GRACE: Duration = Duration::from_millis(500);
/// The same with comments unsent, so a tab reopened at once still has its review.
const UNSENT_GRACE: Duration = Duration::from_secs(8);
/// How long a page may take from being asked for to connecting. A page that
/// leaves while another is coming was reloaded, not closed.
const LOAD_GRACE: Duration = Duration::from_secs(60);
/// A page that vanished without a word (a sleeping laptop, a suspended tab, a
/// crash) is waited for, and its harness ends the review with the session. This
/// is for a review whose harness died too.
const SILENT_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A page opened this recently is still on its way and not opened again.
const OPENING: Duration = Duration::from_secs(10);
/// Browsers keep a cookie per host, whatever the port: each review names its
/// own by its port, so two open at once on one device keep theirs.
const COOKIE: &str = "patch_session";
/// How often an open page's repository is checked for changes.
const WATCH_EVERY: Duration = Duration::from_secs(3);

/// The tests of a development build don't sit through the waits. A release
/// build keeps them, and its tests do.
fn paced(wait: Duration) -> Duration {
    let hurry = cfg!(debug_assertions) && std::env::var_os("PATCH_TEST_HURRY").is_some();
    if hurry { wait / 10 } else { wait }
}

pub enum Outcome {
    Submitted(Submission),
    Closed,
    /// Nobody opened the page in time.
    Unopened,
}

/// The account whose devices alone may open the link, and the `tailscale`
/// command that names a device's account.
pub struct Owner {
    pub account: u64,
    pub cli: PathBuf,
}

/// The page's second address, on the machine's tailnet.
pub struct Tailnet {
    pub ip: Ipv4Addr,
    /// Host names the page answers to there, without the port.
    pub hosts: Vec<String>,
    /// In the link, which trades it for a pass: this review's alone.
    pub secret: String,
    /// None on a machine without a person's account, a tagged server.
    pub owner: Option<Owner>,
}

/// The listener a request came in on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Loopback,
    Tailnet,
}

pub struct Options {
    pub root: PathBuf,
    pub scope: Scope,
    /// The port to listen on; 0 picks one.
    pub port: u16,
    pub tailnet: Option<Tailnet>,
    /// Serve the page from this folder instead of the copy built in.
    pub dev: Option<PathBuf>,
    /// How long to wait for the page to be opened at all; None waits forever.
    pub unopened: Option<Duration>,
    /// Whether this review opens the browser itself, and so may again.
    pub opens: bool,
    /// Whether large answers over loopback are compressed: the browser may be
    /// behind a forwarded port. Over loopback alone, compressing takes longer
    /// than sending. Answers over the tailnet always are.
    pub compress: bool,
}

#[derive(Default)]
struct Live {
    /// The streams each page holds. One that dropped without a word stays, with none.
    pages: HashMap<String, usize>,
    /// When each page was asked for that has not connected or left yet.
    coming: Vec<Instant>,
    timer: Option<JoinHandle<()>>,
}

impl Live {
    fn connected(&self) -> bool {
        self.pages.values().any(|streams| *streams > 0)
    }

    fn expected(&mut self) -> bool {
        self.coming.retain(|asked| asked.elapsed() < paced(LOAD_GRACE));
        !self.coming.is_empty()
    }

    /// Takes one page off those on their way.
    fn arrived(&mut self) {
        if !self.coming.is_empty() {
            self.coming.remove(0);
        }
    }
}

struct App {
    options: Options,
    /// Host headers answered on loopback and on the tailnet, with the port.
    loopback_hosts: Vec<String>,
    tailnet_hosts: Vec<String>,
    /// Names this run to its page, which keeps the comments until they are sent.
    session: String,
    /// The cookie a device gets for the link, and its name.
    pass: String,
    cookie: String,
    /// The addresses that got it, from which alone it works.
    holders: Mutex<HashSet<IpAddr>>,
    /// Each review read, by scope.
    reviews: Mutex<HashMap<String, Arc<Loaded>>>,
    /// Counts reviews read, so what was made for an older read of a scope is never taken for a newer one.
    reads: std::sync::atomic::AtomicU64,
    /// The files each review leaves alone, by path, with their blobs; read once it is asked for.
    unchanged: Mutex<HashMap<String, Arc<Catalog>>>,
    live: Mutex<Live>,
    started: Instant,
    outcome: Mutex<Option<oneshot::Sender<Outcome>>>,
    gzip: Mutex<HashMap<String, Bytes>>,
    /// Bumped when the repository changes, so open pages can offer a refresh.
    changes: tokio::sync::watch::Sender<u64>,
    /// The index of HEAD's history that searches read, once one has asked.
    history: Mutex<Vec<history::Shared>>,
    /// `owner/name` on GitHub, once found.
    repository: Mutex<Option<String>>,
    /// The page of pull requests after the last one sent, asked for ahead: by its search and cursor.
    next_pulls: Mutex<Option<NextPulls>>,
}

type PullsPage = Result<(Vec<protocol::PullRequest>, Option<String>), String>;
type NextPulls = ((String, Option<String>), tokio::sync::watch::Receiver<Option<PullsPage>>);

pub struct Session {
    /// One port for both addresses, so a link to either names the other.
    pub port: u16,
    pub outcome: oneshot::Receiver<Outcome>,
}

/// Where the reviewer's settings live, shared by every review on this machine.
pub fn settings_path() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::install::home_dir().join(".config"))
        .join("patch/settings.json")
}

/// The saved settings as a JSON object, or an empty one.
fn read_settings() -> serde_json::Value {
    std::fs::read(settings_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Puts the settings into the page itself, so its first paint already uses them.
fn with_settings(html: &[u8]) -> Vec<u8> {
    let settings = read_settings().to_string().replace('<', "\\u003c");
    let script = format!("<script>window.__PATCH_SETTINGS__={settings}</script></head>");
    String::from_utf8_lossy(html).replacen("</head>", &script, 1).into_bytes()
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::install::home_dir().join(".local/state"))
        .join("patch")
}

/// The first port free on both addresses, from the range the user's previews
/// use when none is asked for.
async fn listen(port: u16, tailnet: Option<Ipv4Addr>) -> Result<(Vec<(Side, tokio::net::TcpListener)>, u16), String> {
    use tokio::net::TcpListener;
    let loopback = Ipv4Addr::LOCALHOST;
    let Some(ip) = tailnet else {
        let listener =
            TcpListener::bind((loopback, port)).await.map_err(|error| format!("Could not listen on port {port}: {error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        return Ok((vec![(Side::Loopback, listener)], port));
    };
    let tries: Vec<u16> = if port == 0 { (8766..=8799).chain([0; 8]).collect() } else { vec![port] };
    for port in tries {
        let Ok(outer) = TcpListener::bind((ip, port)).await else { continue };
        let port = outer.local_addr().map_err(|error| error.to_string())?.port();
        if let Ok(inner) = TcpListener::bind((loopback, port)).await {
            return Ok((vec![(Side::Loopback, inner), (Side::Tailnet, outer)], port));
        }
    }
    Err(if port == 0 { "Could not find a free port.".into() } else { format!("Could not listen on port {port}.") })
}

pub async fn start(options: Options) -> Result<Session, String> {
    let (listeners, port) = listen(options.port, options.tailnet.as_ref().map(|tailnet| tailnet.ip)).await?;
    let with_port = |hosts: &[String]| hosts.iter().map(|host| format!("{host}:{port}")).collect::<Vec<_>>();
    let loopback_hosts = with_port(&["127.0.0.1".into(), "localhost".into()]);
    let tailnet_hosts = options.tailnet.as_ref().map(|tailnet| with_port(&tailnet.hosts)).unwrap_or_default();

    let (sender, receiver) = oneshot::channel();
    let app = Arc::new(App {
        options,
        loopback_hosts,
        tailnet_hosts,
        session: crate::random_token(24),
        pass: crate::random_token(24),
        cookie: format!("{COOKIE}_{port}"),
        holders: Mutex::default(),
        reviews: Mutex::new(HashMap::new()),
        reads: std::sync::atomic::AtomicU64::new(0),
        unchanged: Mutex::new(HashMap::new()),
        live: Mutex::default(),
        started: Instant::now(),
        outcome: Mutex::new(Some(sender)),
        gzip: Mutex::new(HashMap::new()),
        changes: tokio::sync::watch::channel(0).0,
        history: Mutex::default(),
        repository: Mutex::default(),
        next_pulls: Mutex::default(),
    });
    tokio::spawn(watch_repository(app.clone()));
    if let Some(grace) = app.options.unopened {
        end_after(&app, grace, Outcome::Unopened);
    }
    let router = Router::new().fallback(handle).with_state(app.clone());
    for (side, listener) in listeners {
        let service = router.clone().layer(Extension(side)).into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, service).await;
        });
    }
    Ok(Session { port, outcome: receiver })
}

/// Checks the repository while a page is open and tells it when anything moved.
async fn watch_repository(app: Arc<App>) {
    let mut last: Option<String> = None;
    loop {
        tokio::time::sleep(paced(WATCH_EVERY)).await;
        if !app.live.lock().unwrap().connected() {
            continue;
        }
        let now = git::fingerprint(&app.options.root).await;
        if last.as_ref().is_some_and(|last| *last != now) {
            app.changes.send_modify(|version| *version += 1);
        }
        last = Some(now);
    }
}

/// Ends the review; false when it had already ended.
fn settle(app: &App, outcome: Outcome) -> bool {
    app.outcome.lock().unwrap().take().is_some_and(|sender| sender.send(outcome).is_ok())
}

fn json<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let mut response = (status, serde_json::to_vec(value).unwrap_or_default()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn error(status: StatusCode, message: &str) -> Response {
    json(status, &serde_json::json!({ "error": message }))
}

/// Whether the browser takes `coding`, and has not turned it down with q=0.
fn accepts(headers: &HeaderMap, coding: &str) -> bool {
    headers.get(header::ACCEPT_ENCODING).and_then(|value| value.to_str().ok()).is_some_and(|value| {
        value.split(',').any(|part| {
            let mut parts = part.split(';');
            parts.next().is_some_and(|name| name.trim().eq_ignore_ascii_case(coding))
                && !parts.any(|param| param.trim().strip_prefix("q=").and_then(|q| q.trim().parse::<f32>().ok()) == Some(0.0))
        })
    })
}

fn gzip(bytes: &[u8], level: u32) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    let _ = encoder.write_all(bytes);
    encoder.finish().unwrap_or_default()
}

/// Compresses a large JSON or text answer when it may cross a network and the
/// browser accepts gzip.
fn compressed(compress: bool, headers: &HeaderMap, mut response: Response, bytes: Vec<u8>) -> Response {
    if compress && bytes.len() > 8 * 1024 && accepts(headers, "gzip") {
        *response.body_mut() = Body::from(gzip(&bytes, 1));
        response.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    } else {
        *response.body_mut() = Body::from(bytes);
    }
    response
}

fn cookie_secret<'a>(headers: &'a HeaderMap, cookie: &str) -> Option<&'a str> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|pair| {
        let (name, value) = pair.trim().split_once('=')?;
        (name == cookie).then_some(value)
    })
}

/// Whether the device at a tailnet address may take the link's secret: any,
/// unless the machine has an owner, whose devices alone may.
async fn may_take(tailnet: &Tailnet, peer: Option<IpAddr>) -> bool {
    match (&tailnet.owner, peer) {
        (None, _) => true,
        (Some(owner), Some(ip)) => tailnet::account(&owner.cli, ip).await == Some(Account::Person(owner.account)),
        (Some(_), None) => false,
    }
}

/// The exact host, the same origin, and JSON for writes.
fn trusted(hosts: &[String], method: &Method, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if !hosts.iter().any(|allowed| allowed == host) {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok())
        && origin != format!("http://{host}")
    {
        return false;
    }
    // A write (anything but GET or HEAD, which only read) must be JSON.
    if method != Method::GET && method != Method::HEAD {
        let json = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').next() == Some("application/json"));
        if !json {
            return false;
        }
    }
    true
}

fn parse_scope(params: &HashMap<String, String>, fallback: &Scope) -> Result<Scope, String> {
    let get = |name: &str| params.get(name).filter(|value| !value.is_empty()).cloned();
    match params.get("scope").map(String::as_str) {
        Some("commits") => {
            let from = get("from").unwrap_or_default();
            let to = get("to").unwrap_or_else(|| from.clone());
            Ok(Scope::Commits { from, to })
        }
        Some("pr") => {
            let number: u64 = get("pr").and_then(|value| value.parse().ok()).filter(|n| *n > 0).ok_or("Unknown pull request.")?;
            Ok(Scope::Pr { number })
        }
        Some(kind) => match Mode::parse(kind) {
            Some(mode) => {
                let fallback_base = match (mode, fallback) {
                    (Mode::All, Scope::All { base }) => base.clone(),
                    _ => None,
                };
                Ok(Scope::view(mode, get("base").or(fallback_base)))
            }
            None => Ok(fallback.clone()),
        },
        None => Ok(fallback.clone()),
    }
}

async fn review(app: &App, scope: &Scope) -> Result<Review, String> {
    let root = &app.options.root;
    let (label, old, new, (patch, files)) = match scope {
        Scope::Pr { number } => {
            let pr = github::read_pull_request(root, *number).await?;
            (format!("PR #{} {}", pr.number, pr.title), pr.base_sha, pr.head_sha, (pr.patch, pr.files))
        }
        // Commits whose contents this partial clone lacks are read from GitHub, which has them.
        Scope::Commits { from, to } => {
            let commits = git::commits(root, from, to).await?;
            if !commits.lacking {
                return git::read_commits(root, scope, &commits).await;
            }
            let read = github::read_commits(root, &commits.parent, &commits.first, &commits.to).await;
            let read = read.map_err(|why| format!("{} Nor could GitHub give them: {why}", commits.lacking_message()))?;
            (commits.label(), commits.parent, commits.to, read)
        }
        _ => return git::read_review(root, scope).await,
    };
    let (_, branch) = git::current_branch(root).await;
    // GitHub's names for each file, taken only when they are one for one with the patch's files;
    // otherwise none are, and its images are not served.
    let in_patch = patch.lines().filter(|line| line.starts_with("diff --git ")).count();
    let side = |path: Option<String>| path.map(|path| git::Side { path, mode: String::new(), oid: String::new() });
    let changes = (files.len() == in_patch)
        .then(|| files.into_iter().map(|(old, new)| git::Change { old: side(old), new: side(new) }).collect());
    Ok(Review {
        repository: git::repository_name(root),
        branch,
        scope: scope.clone(),
        label,
        base: None,
        old: Ref::Commit(old),
        new: Ref::Commit(new),
        patch: git::checked(patch)?,
        changes,
        remote: true,
    })
}

/// A file at a commit of a review read from GitHub: from the repository when it has it, else
/// from GitHub. A partial clone may have the commit but not the file's contents.
async fn read_remote_side(
    root: &Path,
    sha: &str,
    path: &str,
    local: Result<Vec<u8>, String>,
    limit: u64,
) -> Result<Vec<u8>, String> {
    match local {
        Err(message) if message != git::TOO_LARGE => github::read_remote_bytes(root, sha, path, limit).await,
        local => local,
    }
}

/// A page of pull requests. Only a search names the repository; listing them finds it out
/// meanwhile, for the search to come.
async fn pulls(app: &Arc<App>, query: &str, after: Option<&str>) -> Result<(Vec<protocol::PullRequest>, Option<String>), String> {
    if query.is_empty() {
        let warm = app.clone();
        tokio::spawn(async move { repository(&warm).await });
        return github::list_pull_requests(&app.options.root, None, query, after).await;
    }
    let repository = repository(app).await?;
    github::list_pull_requests(&app.options.root, Some(&repository), query, after).await
}

/// `owner/name` on GitHub, asked of `gh` once.
async fn repository(app: &App) -> Result<String, String> {
    if let Some(name) = app.repository.lock().unwrap().clone() {
        return Ok(name);
    }
    let name = github::repository(&app.options.root).await?;
    *app.repository.lock().unwrap() = Some(name.clone());
    Ok(name)
}

/// `/api/commits`: a page of HEAD's history, or of what a search finds in it. The first page
/// pins HEAD in its cursor (`tip:where`), so the pages after it list the same history.
async fn commits(app: &App, params: &HashMap<String, String>) -> Result<CommitsResponse, String> {
    let root = app.options.root.clone();
    let query = params.get("q").map(|query| query.trim().to_string()).unwrap_or_default();
    let blocking = async |work: Box<dyn FnOnce() -> Result<CommitsResponse, String> + Send>| {
        tokio::task::spawn_blocking(work).await.map_err(|error| error.to_string())?
    };
    let (tip, from) = match params.get("after").filter(|after| !after.is_empty()) {
        Some(after) => {
            let cursor = after.split_once(':').and_then(|(tip, at)| Some((tip.to_string(), at.parse::<usize>().ok()?)));
            cursor.filter(|(tip, _)| history::is_id(tip)).ok_or("Not a page of commits.")?
        }
        None => {
            // A Jujutsu workspace's history is its working copy's parent's, which Git can't name.
            match git::head_and_branch(&root).await?.commit.filter(|tip| history::is_id(tip)) {
                Some(tip) => (tip, 0),
                None => return Ok(CommitsResponse { commits: Vec::new(), next: None }),
            }
        }
    };
    if query.is_empty() {
        return blocking(Box::new(move || {
            let (commits, more) = history::browse(&root, &tip, from)?;
            Ok(CommitsResponse { commits, next: more.then(|| format!("{tip}:{}", from + history::PAGE)) })
        }))
        .await;
    }
    // A commit named by its id is all that is wanted: found at once, without reading the history.
    if from == 0 {
        let (root, query) = (root.clone(), query.clone());
        let exact = tokio::task::spawn_blocking(move || history::exact(&root, &query)).await.ok().flatten();
        if let Some(exact) = exact {
            return Ok(CommitsResponse { commits: vec![exact], next: None });
        }
    }
    let index = history::index(&app.history, &root, &tip).await?;
    let (commits, next) =
        tokio::task::spawn_blocking(move || index.search(&query, from)).await.map_err(|error| error.to_string())?;
    Ok(CommitsResponse { commits, next: next.map(|at| format!("{tip}:{at}")) })
}

/// What a read of a review keeps for the files the page opens after it, without the diff
/// itself: its sides, the paths its diff has text for, every path it touches, and which read
/// it was.
struct Loaded {
    old: Ref,
    new: Ref,
    files: HashSet<String>,
    changed: HashSet<String>,
    /// Each changed file's sides, as Git recorded them with the patch; none for a pull request.
    changes: Option<Vec<git::Change>>,
    /// Read from GitHub: its files are read from GitHub when the repository lacks them.
    remote: bool,
    /// Names the patch, so a read that finds the same keeps the same number.
    digest: [u8; 32],
    read: u64,
}

/// What one read of a review lets the page open beyond its diff: the files it leaves alone,
/// by path with their blobs and the tree they are read from, and its changed files as they
/// are now, all from the same read.
struct Catalog {
    read: u64,
    tree: String,
    files: HashMap<String, String>,
    new: Ref,
    changed: Vec<String>,
    /// Whether every file the tree has is here; a partial clone may lack some, which a search of
    /// the tree would wait on.
    complete: bool,
}

/// The files a review leaves alone, which the page may open for context.
async fn unchanged(app: &App, key: &str) -> Result<Arc<Catalog>, String> {
    let Some(review) = app.reviews.lock().unwrap().get(key).cloned() else {
        return Err("Unknown review.".into());
    };
    // Commits are read as reviewed. A working tree or index is not a tree to read, but
    // what it leaves alone is as its base has it.
    let ((Ref::Commit(tree), _) | (_, Ref::Commit(tree))) = (&review.new, &review.old) else {
        return Err("Unknown review.".into());
    };
    let (tree, read) = (tree.clone(), review.read);
    if let Some(catalog) = app.unchanged.lock().unwrap().get(key).filter(|catalog| catalog.read == read) {
        return Ok(catalog.clone());
    }
    let root = &app.options.root;
    if tree != git::EMPTY_TREE && !git::has_commit(root, &tree).await {
        return Err("Fetch this pull request to open the files it leaves alone.".into());
    }
    // A partial clone may lack some of them: those it has can be opened.
    let (files, complete) = git::unchanged_files(root, &tree, &review.changed).await?;
    let mut changed: Vec<String> = review.changed.iter().cloned().collect();
    changed.sort();
    let catalog = Arc::new(Catalog { read, tree, files, new: review.new.clone(), changed, complete });
    // Kept only while it is still the scope's latest read; a newer one makes its own.
    let latest = app.reviews.lock().unwrap().get(key).is_some_and(|now| now.read == read);
    if latest {
        app.unchanged.lock().unwrap().insert(key.to_string(), catalog.clone());
    }
    Ok(catalog)
}

/// Text that need not be UTF-8, with its bad bytes as U+FFFD.
fn lossy(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

fn text(compress: bool, headers: &HeaderMap, text: String) -> Response {
    let mut response = Response::new(Body::empty());
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    compressed(compress, headers, response, text.into_bytes())
}

/// A stream ended: by itself that says only that the page went quiet.
fn on_disconnect(app: &Arc<App>, page: &str) {
    let mut live = app.live.lock().unwrap();
    // A page that left is counted no more.
    let Some(streams) = live.pages.get_mut(page) else { return };
    *streams = streams.saturating_sub(1);
    drop(live);
    end_after(app, SILENT_GRACE, Outcome::Closed);
}

/// A page said it is going: its tab closed, or it was reloaded.
fn on_leave(app: &Arc<App>, page: &str, unsent: bool) {
    let mut live = app.live.lock().unwrap();
    if live.pages.remove(page).is_none() {
        live.arrived(); // It goes before it ever connected.
    }
    drop(live);
    let grace = if unsent { paced(UNSENT_GRACE) } else { CLOSE_GRACE };
    end_after(app, grace, Outcome::Closed);
}

/// Ends the review after a while unless a page connects or is asked for first.
fn end_after(app: &Arc<App>, grace: Duration, outcome: Outcome) {
    let mut live = app.live.lock().unwrap();
    if live.connected() {
        return;
    }
    if let Some(timer) = live.timer.take() {
        timer.abort();
    }
    let app = app.clone();
    live.timer = Some(tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        // It was reloaded or opened again, and is on its way.
        if grace < SILENT_GRACE && app.live.lock().unwrap().expected() {
            return end_after(&app, SILENT_GRACE, outcome);
        }
        settle(&app, outcome);
    }));
}

/// Counts an open page while its event stream lives.
struct Connection(Arc<App>, String);

impl Drop for Connection {
    fn drop(&mut self) {
        on_disconnect(&self.0, &self.1);
    }
}

fn live_stream(app: Arc<App>, page: String) -> Response {
    {
        let mut live = app.live.lock().unwrap();
        if !live.pages.contains_key(&page) {
            live.arrived();
        }
        *live.pages.entry(page.clone()).or_default() += 1;
        if let Some(timer) = live.timer.take() {
            timer.abort();
        }
    }
    let changes = app.changes.subscribe();
    // Which run this is: a page drawn by an earlier one on this port must read its review again.
    let session = app.session.clone();
    let guard = Connection(app, page);
    let first =
        futures_util::stream::once(async move { Event::default().retry(Duration::from_secs(1)).event("session").data(session) });
    let changed = futures_util::stream::unfold(changes, |mut changes| async move {
        changes.changed().await.ok()?;
        let version = *changes.borrow_and_update();
        Some((Event::default().event("changed").data(version.to_string()), changes))
    });
    let stream = first.chain(changed).chain(futures_util::stream::pending()).map(move |event| {
        let _keep = &guard;
        Ok::<_, std::convert::Infallible>(event)
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response()
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The images the page previews, which every browser draws itself. `web/media.ts` has the same list.
fn image_type(path: &str) -> Option<&'static str> {
    let (_, ext) = path.rsplit_once('.')?;
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// `/api/media`: one side of a changed image, as it is. Only a side the diff gives the file is
/// read, from the read of the review the page drew (`read`): a later one may differ. A local
/// review's side is read as Git recorded it (git::read_change); a pull request's by its path at
/// its commit. An SVG opened on its own runs nothing and loads nothing (the CSP), and the page
/// draws it only in an `<img>`, which never does. HEAD answers the same without the bytes, so the
/// page can say why an image did not draw.
async fn media(app: &App, params: &HashMap<String, String>, headers: &HeaderMap, compress: bool) -> Response {
    let unknown = || error(StatusCode::NOT_FOUND, "Unknown file.");
    let key = params.get("key").map(String::as_str).unwrap_or_default();
    let path = params.get("path").map(String::as_str).unwrap_or_default();
    let Some(kind) = image_type(path) else { return unknown() };
    let Some(current) = app.reviews.lock().unwrap().get(key).cloned() else { return unknown() };
    if params.get("read").and_then(|read| read.parse::<u64>().ok()) != Some(current.read) {
        return error(StatusCode::CONFLICT, "The review was read again since. Refresh to see it.");
    }
    let old = match params.get("side").map(String::as_str) {
        Some("old") => true,
        Some("new") => false,
        _ => return unknown(),
    };
    let reference = if old { &current.old } else { &current.new };
    let root = &app.options.root;
    // Only a side Git (or, for a pull request, GitHub) recorded for the change is read.
    let Some(changes) = &current.changes else { return unknown() };
    let side = changes.iter().filter_map(|change| if old { change.old.as_ref() } else { change.new.as_ref() });
    let Some(side) = side.into_iter().find(|side| side.path == path) else { return unknown() };
    let read = match (current.remote, reference) {
        // A side read from GitHub, by its path at its commit: here if the repository has it.
        (true, Ref::Commit(sha)) => {
            let local = git::read_at_commit(root, sha, path, git::MEDIA_LIMIT).await;
            let read = read_remote_side(root, sha, path, local, git::MEDIA_LIMIT).await;
            read.map(|bytes| {
                use sha2::{Digest, Sha256};
                let digest: String = Sha256::digest(&bytes).iter().take(16).map(|byte| format!("{byte:02x}")).collect();
                (bytes, digest)
            })
        }
        _ => {
            // A side read by its id is the same for good: one the browser has needs no reading.
            if !matches!(reference, Ref::Worktree) && has_tag(headers, &side.oid) {
                return not_modified(&side.oid);
            }
            git::read_change(root, reference, side, git::MEDIA_LIMIT).await.map(|bytes| (bytes, side.oid.clone()))
        }
    };
    let (bytes, tag) = match read {
        Ok(read) => read,
        Err(message) if message == git::TOO_LARGE => return error(StatusCode::PAYLOAD_TOO_LARGE, &message),
        Err(message) if message == git::CHANGED => {
            return error(StatusCode::CONFLICT, "This file changed since the review was read. Refresh to see it.");
        }
        Err(_) => return unknown(),
    };
    // The URL stays while a working tree file changes, so the browser asks each time, and is told
    // when it already has it.
    if has_tag(headers, &tag) {
        return not_modified(&tag);
    }
    let mut response = not_modified(&tag);
    *response.status_mut() = StatusCode::OK;
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"),
    );
    out.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    // Only an SVG is text; the rest are compressed already.
    if kind == "image/svg+xml" {
        out.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    compressed(compress && kind == "image/svg+xml", headers, response, bytes)
}

/// Whether the browser already has what `tag` names.
fn has_tag(headers: &HeaderMap, tag: &str) -> bool {
    let tag = format!("\"{tag}\"");
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|given| given.trim().trim_start_matches("W/") == tag))
}

/// 304, named by `tag`, which the browser asks again for each time.
fn not_modified(tag: &str) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NOT_MODIFIED;
    let out = response.headers_mut();
    out.insert(header::ETAG, HeaderValue::from_str(&format!("\"{tag}\"")).unwrap());
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    response
}

fn compressible(path: &str) -> bool {
    [".js", ".css", ".html", ".svg", ".json", ".wasm"].iter().any(|ext| path.ends_with(ext))
}

/// A file of the page: from disk in development, else as built in.
enum Source {
    Disk(std::borrow::Cow<'static, [u8]>),
    Embedded(&'static Asset),
}

async fn source(app: &App, name: &str) -> Option<Source> {
    let dir = match &app.options.dev {
        Some(dir) => Some(dir.as_path()),
        None if PAGE.is_empty() => Some(Path::new(env!("PATCH_WEB_DIST"))),
        None => None,
    };
    match dir {
        Some(dir) if git::safe_path(name) => {
            // Nothing outside the folder, through a link in it either.
            let (Ok(dir), Ok(file)) = (tokio::fs::canonicalize(dir).await, tokio::fs::canonicalize(dir.join(name)).await) else {
                return None;
            };
            if !file.starts_with(&dir) {
                return None;
            }
            tokio::fs::read(file).await.ok().map(|bytes| Source::Disk(bytes.into()))
        }
        Some(_) => None,
        None => embedded(name).map(Source::Embedded),
    }
}

async fn asset(app: &App, headers: &HeaderMap, path: &str) -> Response {
    let path = if path == "/" { "/index.html" } else { path };
    let name = path.trim_start_matches('/');
    // Only page routes fall back to the page; a missing asset is a 404, never
    // HTML cached forever under the asset's name.
    let (path, found) = match source(app, name).await {
        Some(found) => (path, found),
        None if Path::new(name).extension().is_none() => match source(app, "index.html").await {
            Some(found) => ("/index.html", found),
            None => return (StatusCode::NOT_FOUND, "Not found").into_response(),
        },
        None => return (StatusCode::NOT_FOUND, "Not found").into_response(),
    };
    let immutable = path.starts_with("/a/");
    let mut response = Response::new(Body::empty());
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(path)));
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    if compressible(path) {
        out.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    let bytes: std::borrow::Cow<'static, [u8]> = match found {
        Source::Embedded(asset) => {
            if let Some(br) = asset.br.filter(|_| accepts(headers, "br")) {
                out.insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
                *response.body_mut() = Body::from(br);
                return response;
            }
            if let Some(gz) = asset.gz {
                if accepts(headers, "gzip") {
                    out.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                    *response.body_mut() = Body::from(gz);
                    return response;
                }
                // A browser that takes neither, if there is one.
                let mut raw = Vec::new();
                let _ = std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(gz), &mut raw);
                *response.body_mut() = Body::from(raw);
                return response;
            }
            asset.raw.unwrap_or_default().into()
        }
        Source::Disk(bytes) => bytes,
    };
    let bytes: std::borrow::Cow<'static, [u8]> = if path == "/index.html" {
        app.live.lock().unwrap().coming.push(Instant::now());
        with_settings(&bytes).into()
    } else {
        bytes
    };
    if compressible(path) && bytes.len() > 1024 && accepts(headers, "gzip") {
        let cached = immutable && app.options.dev.is_none();
        let packed = match cached.then(|| app.gzip.lock().unwrap().get(path).cloned()).flatten() {
            Some(packed) => packed,
            None => {
                let packed = Bytes::from(gzip(&bytes, 6));
                if cached {
                    app.gzip.lock().unwrap().insert(path.to_string(), packed.clone());
                }
                packed
            }
        };
        out.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        *response.body_mut() = Body::from(packed);
    } else {
        *response.body_mut() = Body::from(bytes);
    }
    response
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_string();
    let params: HashMap<String, String> = Query::try_from_uri(&parts.uri).map(|Query(q)| q).unwrap_or_default();
    let headers = parts.headers;
    let method = parts.method;
    let via = parts.extensions.get::<Side>().copied().unwrap_or(Side::Tailnet);
    let hosts = if via == Side::Tailnet { &app.tailnet_hosts } else { &app.loopback_hosts };
    let compress = via == Side::Tailnet || app.options.compress;
    let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(addr)| addr.ip());

    // The link carries the secret once; it then lives in a cookie. While the
    // page is on a tailnet, loopback takes the link too: a shared machine's
    // other users reach loopback as well.
    if let Some(tailnet) = &app.options.tailnet
        && let Some(peer) = peer
        && params.get("t") == Some(&tailnet.secret)
        && method == Method::GET
    {
        // The exact host and, when it says, the same origin, as for any request.
        let host_ok = trusted(hosts, &method, &headers);
        if host_ok && via == Side::Tailnet && !may_take(tailnet, Some(peer)).await {
            let why = "This review opens only on devices signed in to the Tailscale account that started it.";
            return (StatusCode::FORBIDDEN, why).into_response();
        }
        if host_ok {
            app.holders.lock().unwrap().insert(peer);
            // Lax, not Strict: a link followed from another site's page must
            // still bring it to `/`. Writes need JSON and the same origin anyway.
            let pass = &app.pass;
            let mut response = (StatusCode::SEE_OTHER, "").into_response();
            response.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!("{}={pass}; HttpOnly; SameSite=Lax; Path=/", app.cookie)).unwrap(),
            );
            return response;
        }
    }
    // The pass works only from where it was handed over. Whether to open the
    // page again tells nothing, and `patchr hook reopen` has no cookie.
    let passed = match &app.options.tailnet {
        None => via == Side::Loopback,
        Some(_) if via == Side::Loopback && method == Method::GET && path == "/api/reopen" => true,
        Some(_) => {
            cookie_secret(&headers, &app.cookie) == Some(app.pass.as_str())
                && peer.is_some_and(|peer| app.holders.lock().unwrap().contains(&peer))
        }
    };
    if !passed || !trusted(hosts, &method, &headers) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    let body = || async { axum::body::to_bytes(body, 32 * 1024 * 1024).await.unwrap_or_else(|_| Bytes::new()) };

    let page = params.get("page").cloned().unwrap_or_default();

    match (method.clone(), path.as_str()) {
        (Method::GET, "/api/review") => {
            let scope = match parse_scope(&params, &app.options.scope) {
                Ok(scope) => scope,
                Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            };
            match review(&app, &scope).await {
                Ok(current) => {
                    let scope_key = serde_json::to_string(&current.scope).unwrap_or_default();
                    let paths = review_paths(&current.patch);
                    // A path with a character Git's bytes could not be read as (U+FFFD) may name
                    // another file than the diff's: nothing is read by it.
                    let named = |set: HashSet<String>| set.into_iter().filter(|path| !path.contains('\u{FFFD}')).collect();
                    // A read that finds what the last one did is the same read: what a page drew
                    // from it (images, asked for by its number) stays good, so another tab, or a
                    // glance at the review from a script, changes nothing. "The same" is the patch,
                    // the commits on each side, and every side's path, mode and id: a change of
                    // mode alone shows no id in its patch.
                    use sha2::{Digest, Sha256};
                    let mut hasher = Sha256::new();
                    hasher.update(current.patch.as_bytes());
                    hasher.update(format!("{:?}{:?}{:?}", current.old, current.new, current.changes).as_bytes());
                    let digest: [u8; 32] = hasher.finalize().into();
                    let files = current.changes.as_ref().map(|changes| {
                        let path = |side: &Option<git::Side>| side.as_ref().map(|side| side.path.clone());
                        changes.iter().map(|change| ChangedPaths { old: path(&change.old), new: path(&change.new) }).collect()
                    });
                    // Numbered and kept at once, so two reads at the same moment agree.
                    let read = {
                        let mut reviews = app.reviews.lock().unwrap();
                        let same = reviews.get(&scope_key).filter(|last| last.digest == digest).map(|last| last.read);
                        let read = same.unwrap_or_else(|| app.reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
                        let loaded = Loaded {
                            old: current.old,
                            new: current.new,
                            files: named(paths.texts),
                            changed: paths.changed,
                            changes: current.changes,
                            remote: current.remote,
                            digest,
                            read,
                        };
                        reviews.insert(scope_key.clone(), Arc::new(loaded));
                        read
                    };
                    app.unchanged.lock().unwrap().remove(&scope_key);
                    let response = ReviewResponse {
                        repository: current.repository,
                        branch: current.branch,
                        scope: current.scope,
                        scope_key,
                        label: current.label,
                        base: current.base,
                        vcs: if crate::jj::of(&app.options.root).is_some() { protocol::Vcs::Jj } else { protocol::Vcs::Git },
                        patch: current.patch,
                        session: app.session.clone(),
                        read,
                        files,
                    };
                    let bytes = serde_json::to_vec(&response).unwrap_or_default();
                    compressed(compress, &headers, json(StatusCode::OK, &()), bytes)
                }
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/scopes") => {
            let root = &app.options.root;
            let requested = params.get("base").filter(|b| !b.is_empty()).map(String::as_str).or(match &app.options.scope {
                Scope::All { base } => base.as_deref(),
                _ => None,
            });
            let base = git::find_base(root, requested).await.ok().flatten();
            match git::list_branches(root).await {
                Ok(branches) => json(StatusCode::OK, &ScopesResponse { base, branches }),
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/commits") => match commits(&app, &params).await {
            Ok(page) => {
                let bytes = serde_json::to_vec(&page).unwrap_or_default();
                compressed(compress, &headers, json(StatusCode::OK, &()), bytes)
            }
            Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
        },
        (Method::GET, "/api/prs") => {
            let query = params.get("q").map(|query| query.trim().to_string()).unwrap_or_default();
            let after = params.get("after").filter(|after| !after.is_empty()).cloned();
            let fetched = app.next_pulls.lock().unwrap().take().filter(|(key, _)| *key == (query.clone(), after.clone()));
            let ahead = match fetched {
                Some((_, mut ready)) => ready.wait_for(Option::is_some).await.ok().and_then(|done| done.clone()),
                None => None,
            };
            let listed = match ahead {
                Some(listed) => listed,
                None => pulls(&app, &query, after.as_deref()).await,
            };
            match listed {
                Ok((pulls, next)) => {
                    // The next page is asked for now, so it is likely here when the list reaches its end.
                    if let Some(next) = &next {
                        let (send, ready) = tokio::sync::watch::channel(None);
                        *app.next_pulls.lock().unwrap() = Some(((query.clone(), Some(next.clone())), ready));
                        let (ahead, query, next) = (app.clone(), query.clone(), next.clone());
                        tokio::spawn(async move {
                            let _ = send.send(Some(self::pulls(&ahead, &query, Some(&next)).await));
                        });
                    }
                    json(StatusCode::OK, &PullRequestsResponse { pulls, next })
                }
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/file") => {
            let key = params.get("key").cloned().unwrap_or_default();
            let side = params.get("side").map(String::as_str);
            let file = params.get("path").cloned().unwrap_or_default();
            let current = app.reviews.lock().unwrap().get(&key).cloned();
            let Some(current) = current else {
                return error(StatusCode::NOT_FOUND, "Unknown file.");
            };
            let reference = match side {
                Some("old") => current.old.clone(),
                Some("new") => current.new.clone(),
                _ => return error(StatusCode::NOT_FOUND, "Unknown file."),
            };
            if !current.files.contains(&file) {
                return error(StatusCode::NOT_FOUND, "Unknown file.");
            }
            let root = &app.options.root;
            // `max` bounds the read itself, for a preview that would not use more.
            let max = params.get("max").and_then(|max| max.parse::<u64>().ok());
            let read = match (&reference, max) {
                // A review read from GitHub may name commits, or contents, the repository lacks.
                (Ref::Commit(sha), max) if current.remote => {
                    let limit = max.unwrap_or(git::TEXT_LIMIT);
                    let local = git::read_side_bytes(root, &reference, &file, limit).await;
                    read_remote_side(root, sha, &file, local, limit).await.map(lossy)
                }
                (_, Some(max)) => git::read_side_bytes(root, &reference, &file, max).await.map(lossy),
                (_, None) => git::read_side(root, &reference, &file).await,
            };
            match read {
                Ok(contents) => text(compress, &headers, contents),
                Err(message) if message == git::TOO_LARGE => error(StatusCode::PAYLOAD_TOO_LARGE, &message),
                Err(_) => (StatusCode::NOT_FOUND, "").into_response(),
            }
        }
        (Method::GET | Method::HEAD, "/api/media") => media(&app, &params, &headers, compress).await,
        (Method::GET, "/api/unchanged") => {
            let key = params.get("key").cloned().unwrap_or_default();
            match unchanged(&app, &key).await {
                Ok(catalog) => {
                    let mut paths: Vec<&String> = catalog.files.keys().collect();
                    paths.sort();
                    compressed(compress, &headers, json(StatusCode::OK, &()), serde_json::to_vec(&paths).unwrap_or_default())
                }
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/grep") => {
            let key = params.get("key").cloned().unwrap_or_default();
            let text = params.get("q").cloned().unwrap_or_default();
            if text.trim().chars().count() < 2 {
                return json(StatusCode::OK, &Vec::<GrepMatch>::new());
            }
            let catalog = match unchanged(&app, &key).await {
                Ok(catalog) => catalog,
                Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            };
            // Git would look for the missing files in every object it has, minutes in a large one.
            if !catalog.complete {
                return error(StatusCode::UNPROCESSABLE_ENTITY, "This partial clone lacks some of the files to search.");
            }
            let root = &app.options.root;
            // Only what the page may open: the changed files as the review has them now, which
            // /api/file reads, then the files the review leaves alone, as reviewed.
            let mut found = Vec::new();
            for path in &catalog.changed {
                if found.len() >= git::GREP_LIMIT {
                    break;
                }
                if let Ok(contents) = git::read_side(root, &catalog.new, path).await {
                    git::grep_text(path, &contents, &text, &mut found);
                }
            }
            match git::grep(root, &catalog.tree, &text, |path| catalog.files.contains_key(path), &mut found).await {
                Ok(()) => {
                    let matches: Vec<GrepMatch> =
                        found.into_iter().map(|(file, line, text)| GrepMatch { file, line, text }).collect();
                    compressed(compress, &headers, json(StatusCode::OK, &()), serde_json::to_vec(&matches).unwrap_or_default())
                }
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/unchanged/file") => {
            let key = params.get("key").cloned().unwrap_or_default();
            let path = params.get("path").cloned().unwrap_or_default();
            let blob = unchanged(&app, &key).await.ok().and_then(|catalog| catalog.files.get(&path).cloned());
            let Some(blob) = blob else {
                return error(StatusCode::NOT_FOUND, "Unknown file.");
            };
            match git::read_text(&app.options.root, &blob).await {
                Ok(contents) => text(compress, &headers, contents),
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::POST, "/api/submit") => {
            let Ok(submission) = serde_json::from_slice::<Submission>(&body().await) else {
                return error(StatusCode::BAD_REQUEST, "Not a review.");
            };
            // Written on a page another run drew, on this port before: its comments are about that review.
            if submission.session.as_ref().is_some_and(|session| *session != app.session) {
                return error(StatusCode::CONFLICT, "These comments are about another review.");
            }
            if settle(&app, Outcome::Submitted(submission)) {
                json(StatusCode::OK, &serde_json::json!({ "ok": true }))
            } else {
                error(StatusCode::CONFLICT, "This review has already ended.")
            }
        }
        (Method::GET, "/api/settings") => json(StatusCode::OK, &read_settings()),
        (Method::PUT, "/api/settings") => {
            let bytes = body().await;
            let valid = bytes.len() <= 64 * 1024
                && serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| value.is_object());
            if !valid {
                return error(StatusCode::BAD_REQUEST, "Settings must be a JSON object.");
            }
            let path = settings_path();
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            let saved = match path.parent() {
                Some(dir) => tokio::fs::create_dir_all(dir).await.is_ok(),
                None => false,
            } && tokio::fs::write(&temporary, &bytes).await.is_ok()
                && tokio::fs::rename(&temporary, &path).await.is_ok();
            if saved {
                json(StatusCode::OK, &serde_json::json!({ "ok": true }))
            } else {
                error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the settings.")
            }
        }
        (Method::POST, "/api/leave") => {
            on_leave(&app, &page, params.contains_key("unsent"));
            json(StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        (Method::GET, "/api/live") => live_stream(app.clone(), page),
        (Method::GET, "/api/reopen") => {
            let mut live = app.live.lock().unwrap();
            let lost = !live.connected() && !live.expected() && app.started.elapsed() > paced(OPENING);
            json(StatusCode::OK, &serde_json::json!({ "reopen": app.options.opens && lost }))
        }
        (Method::GET | Method::HEAD, _) => asset(&app, &headers, &path).await,
        _ => (StatusCode::METHOD_NOT_ALLOWED, "Method not allowed").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_page_nobody_opens_ends_its_review() {
        let options = Options {
            root: std::env::temp_dir(),
            scope: Scope::All { base: None },
            port: 0,
            tailnet: None,
            dev: None,
            unopened: Some(Duration::from_millis(20)),
            opens: false,
            compress: false,
        };
        let mut session = start(options).await.unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(5), &mut session.outcome).await.unwrap();
        assert!(matches!(outcome, Ok(Outcome::Unopened)));
    }

    fn params(query: &str) -> HashMap<String, String> {
        query.split('&').filter_map(|pair| pair.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn scopes_parse_and_keep_the_session_base() {
        let fallback = Scope::All { base: Some("develop".into()) };
        assert_eq!(parse_scope(&params("scope=all"), &fallback), Ok(Scope::All { base: Some("develop".into()) }));
        assert_eq!(parse_scope(&params("scope=staged"), &fallback), Ok(Scope::Staged { base: None }));
        assert_eq!(
            parse_scope(&params("scope=commits&from=abc1234"), &fallback),
            Ok(Scope::Commits { from: "abc1234".into(), to: "abc1234".into() })
        );
        assert_eq!(parse_scope(&params("scope=pr&pr=12"), &fallback), Ok(Scope::Pr { number: 12 }));
        assert!(parse_scope(&params("scope=pr&pr=x"), &fallback).is_err());
        assert_eq!(parse_scope(&params(""), &fallback), Ok(fallback.clone()));
    }

    #[test]
    fn scope_keys_match_the_page() {
        assert_eq!(serde_json::to_string(&Scope::Pr { number: 1 }).unwrap(), r#"{"kind":"pr","number":1}"#);
        assert_eq!(serde_json::to_string(&Scope::Staged { base: None }).unwrap(), r#"{"kind":"staged"}"#);
    }
}

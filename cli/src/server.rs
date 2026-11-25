//! One review session: an HTTP server for the page, resolved when the reviewer
//! submits or leaves. It listens on loopback, or on the Tailscale address in
//! remote mode, where every request must also carry the session's secret.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use rust_embed::RustEmbed;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::git::{self, Ref, Review};
use crate::github;
use crate::paths::patch_paths;
use crate::protocol::{Mode, ReviewResponse, Scope, ScopesResponse, Submission};

#[derive(RustEmbed)]
#[folder = "$PATCH_WEB_DIST"]
struct Page;

/// How long the page may be gone after it said it was leaving (a closed tab,
/// a reload) before the review counts as closed.
const LEAVE_GRACE: Duration = Duration::from_secs(8);
/// How long a page that vanished without a word (a sleeping laptop, a phone
/// that suspended the tab) may stay away.
const SILENT_GRACE: Duration = Duration::from_secs(30 * 60);
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

pub struct Options {
    pub root: PathBuf,
    pub scope: Scope,
    pub bind: SocketAddr,
    /// Host headers the server answers to.
    pub hosts: Vec<String>,
    /// Required on every request when the page is served beyond loopback.
    pub secret: Option<String>,
    /// Serve the page from this folder instead of the copy built in.
    pub dev: Option<PathBuf>,
    /// How long to wait for the page to be opened at all; None waits forever.
    pub unopened: Option<Duration>,
}

struct Live {
    connections: usize,
    leaving: bool,
    timer: Option<JoinHandle<()>>,
}

struct App {
    options: Options,
    /// Names this run to its page, which keeps the comments until they are sent.
    session: String,
    reviews: Mutex<HashMap<String, (Review, HashSet<String>)>>,
    live: Mutex<Live>,
    outcome: Mutex<Option<oneshot::Sender<Outcome>>>,
    gzip: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    /// Bumped when the repository changes, so open pages can offer a refresh.
    changes: tokio::sync::watch::Sender<u64>,
}

pub struct Session {
    pub url: String,
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

pub async fn start(options: Options, public_url: impl FnOnce(u16) -> String) -> Result<Session, String> {
    let listener = tokio::net::TcpListener::bind(options.bind)
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", options.bind))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let mut options = options;
    options.hosts = options.hosts.iter().map(|host| format!("{host}:{port}")).collect();

    let (sender, receiver) = oneshot::channel();
    let app = Arc::new(App {
        options,
        session: crate::random_token(24),
        reviews: Mutex::new(HashMap::new()),
        live: Mutex::new(Live { connections: 0, leaving: false, timer: None }),
        outcome: Mutex::new(Some(sender)),
        gzip: Mutex::new(HashMap::new()),
        changes: tokio::sync::watch::channel(0).0,
    });
    tokio::spawn(watch_repository(app.clone()));
    if let Some(grace) = app.options.unopened {
        end_after(&app, grace, Outcome::Unopened);
    }
    let router = Router::new().fallback(handle).with_state(app.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(Session { url: public_url(port), outcome: receiver })
}

/// Checks the repository while a page is open and tells it when anything moved.
async fn watch_repository(app: Arc<App>) {
    let mut last: Option<String> = None;
    loop {
        tokio::time::sleep(paced(WATCH_EVERY)).await;
        if app.live.lock().unwrap().connections == 0 {
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

fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|part| part.trim().starts_with("gzip")))
}

fn gzip(bytes: &[u8], level: u32) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    let _ = encoder.write_all(bytes);
    encoder.finish().unwrap_or_default()
}

/// Compresses a large JSON or text answer when the browser accepts gzip.
fn compressed(headers: &HeaderMap, mut response: Response, bytes: Vec<u8>) -> Response {
    if bytes.len() > 8 * 1024 && accepts_gzip(headers) {
        *response.body_mut() = Body::from(gzip(&bytes, 1));
        response.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    } else {
        *response.body_mut() = Body::from(bytes);
    }
    response
}

fn cookie_secret(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|pair| {
        let (name, value) = pair.trim().split_once('=')?;
        (name == COOKIE).then_some(value)
    })
}

/// The exact host, the same origin, JSON for writes, and in remote mode the secret.
fn trusted(app: &App, method: &Method, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if !app.options.hosts.iter().any(|allowed| allowed == host) {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok())
        && origin != format!("http://{host}")
    {
        return false;
    }
    if method != Method::GET {
        let json = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').next() == Some("application/json"));
        if !json {
            return false;
        }
    }
    match &app.options.secret {
        Some(secret) => cookie_secret(headers) == Some(secret.as_str()),
        None => true,
    }
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
    let Scope::Pr { number } = scope else {
        return git::read_review(root, scope).await;
    };
    let pr = github::read_pull_request(root, *number).await?;
    let (_, branch) = git::current_branch(root).await;
    Ok(Review {
        repository: git::repository_name(root),
        branch,
        scope: scope.clone(),
        label: format!("PR #{} {}", pr.number, pr.title),
        base: None,
        old: Ref::Commit(pr.base_sha),
        new: Ref::Commit(pr.head_sha),
        patch: pr.patch,
    })
}

fn on_disconnect(app: &Arc<App>) {
    let mut live = app.live.lock().unwrap();
    live.connections = live.connections.saturating_sub(1);
    if live.connections > 0 {
        return;
    }
    let grace = if live.leaving { paced(LEAVE_GRACE) } else { SILENT_GRACE };
    drop(live);
    end_after(app, grace, Outcome::Closed);
}

/// Ends the review after a while unless a page connects first.
fn end_after(app: &Arc<App>, grace: Duration, outcome: Outcome) {
    let mut live = app.live.lock().unwrap();
    // A page may have connected since the caller looked.
    if live.connections > 0 {
        return;
    }
    if let Some(timer) = live.timer.take() {
        timer.abort();
    }
    let app = app.clone();
    live.timer = Some(tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        settle(&app, outcome);
    }));
}

/// Counts an open page while its event stream lives.
struct Connection(Arc<App>);

impl Drop for Connection {
    fn drop(&mut self) {
        on_disconnect(&self.0);
    }
}

fn live_stream(app: Arc<App>) -> Response {
    {
        let mut live = app.live.lock().unwrap();
        live.connections += 1;
        live.leaving = false;
        if let Some(timer) = live.timer.take() {
            timer.abort();
        }
    }
    let changes = app.changes.subscribe();
    let guard = Connection(app);
    let first = futures_util::stream::once(async { Event::default().retry(Duration::from_secs(1)) });
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

fn content_type(path: &str) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .map(|kind| match kind {
            "text/html" | "text/css" | "text/javascript" | "application/javascript" | "image/svg+xml" => {
                format!("{kind}; charset=utf-8")
            }
            other => other.to_string(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
}

fn compressible(path: &str) -> bool {
    [".js", ".css", ".html", ".svg", ".json", ".wasm"].iter().any(|ext| path.ends_with(ext))
}

async fn asset(app: &App, headers: &HeaderMap, path: &str) -> Response {
    let path = if path == "/" { "/index.html" } else { path };
    let name = path.trim_start_matches('/');
    let bytes: Option<std::borrow::Cow<'static, [u8]>> = match &app.options.dev {
        Some(dir) if git::safe_path(name) => tokio::fs::read(dir.join(name)).await.ok().map(Into::into),
        Some(_) => None,
        None => Page::get(name).map(|file| file.data),
    };
    // Only page routes fall back to the page; a missing asset is a 404, never
    // HTML cached forever under the asset's name.
    let (path, bytes) = match bytes {
        Some(bytes) => (path, bytes),
        None if Path::new(name).extension().is_none() => match &app.options.dev {
            Some(dir) => match tokio::fs::read(dir.join("index.html")).await {
                Ok(bytes) => ("/index.html", bytes.into()),
                Err(_) => return (StatusCode::NOT_FOUND, "Not found").into_response(),
            },
            None => match Page::get("index.html") {
                Some(file) => ("/index.html", file.data),
                None => return (StatusCode::NOT_FOUND, "Not found").into_response(),
            },
        },
        None => return (StatusCode::NOT_FOUND, "Not found").into_response(),
    };
    let bytes: std::borrow::Cow<'static, [u8]> = if path == "/index.html" { with_settings(&bytes).into() } else { bytes };
    let immutable = path.starts_with("/a/");
    let mut response = Response::new(Body::empty());
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type(path)).unwrap());
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    if compressible(path) && bytes.len() > 1024 && accepts_gzip(headers) {
        let packed = if immutable && app.options.dev.is_none() {
            let cached = app.gzip.lock().unwrap().get(path).cloned();
            match cached {
                Some(packed) => packed,
                None => {
                    let packed = Arc::new(gzip(&bytes, 6));
                    app.gzip.lock().unwrap().insert(path.to_string(), packed.clone());
                    packed
                }
            }
        } else {
            Arc::new(gzip(&bytes, 6))
        };
        out.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        out.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
        *response.body_mut() = Body::from(packed.as_ref().clone());
    } else {
        *response.body_mut() = Body::from(bytes.into_owned());
    }
    response
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_string();
    let params: HashMap<String, String> = Query::try_from_uri(&parts.uri).map(|Query(q)| q).unwrap_or_default();
    let headers = parts.headers;
    let method = parts.method;

    // In remote mode the link carries the secret once; it then lives in a cookie.
    if let Some(secret) = &app.options.secret
        && params.get("t") == Some(secret)
        && method == Method::GET
    {
        let host_ok = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| app.options.hosts.iter().any(|allowed| allowed == host));
        if host_ok {
            let mut response = (StatusCode::SEE_OTHER, "").into_response();
            response.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!("{COOKIE}={secret}; HttpOnly; SameSite=Strict; Path=/")).unwrap(),
            );
            return response;
        }
    }
    if !trusted(&app, &method, &headers) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    let body = || async { axum::body::to_bytes(body, 32 * 1024 * 1024).await.unwrap_or_else(|_| Bytes::new()) };

    match (method.clone(), path.as_str()) {
        (Method::GET, "/api/review") => {
            let scope = match parse_scope(&params, &app.options.scope) {
                Ok(scope) => scope,
                Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            };
            match review(&app, &scope).await {
                Ok(current) => {
                    let scope_key = serde_json::to_string(&current.scope).unwrap_or_default();
                    let files = patch_paths(&current.patch);
                    let response = ReviewResponse {
                        repository: current.repository.clone(),
                        branch: current.branch.clone(),
                        scope: current.scope.clone(),
                        scope_key: scope_key.clone(),
                        label: current.label.clone(),
                        base: current.base.clone(),
                        patch: current.patch.clone(),
                        session: app.session.clone(),
                    };
                    app.reviews.lock().unwrap().insert(scope_key, (current, files));
                    let bytes = serde_json::to_vec(&response).unwrap_or_default();
                    compressed(&headers, json(StatusCode::OK, &()), bytes)
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
                Ok(branches) => {
                    let (commits, since) = git::list_commits(root, base.as_deref()).await;
                    json(StatusCode::OK, &ScopesResponse { base, since, branches, commits })
                }
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/prs") => {
            let query = params.get("q").map(String::as_str).unwrap_or("");
            match github::list_pull_requests(&app.options.root, query).await {
                Ok(list) => json(StatusCode::OK, &list),
                Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
            }
        }
        (Method::GET, "/api/file") => {
            let key = params.get("key").cloned().unwrap_or_default();
            let side = params.get("side").map(String::as_str);
            let file = params.get("path").cloned().unwrap_or_default();
            let current = app.reviews.lock().unwrap().get(&key).cloned();
            let Some((current, files)) = current else {
                return error(StatusCode::NOT_FOUND, "Unknown file.");
            };
            let reference = match side {
                Some("old") => current.old.clone(),
                Some("new") => current.new.clone(),
                _ => return error(StatusCode::NOT_FOUND, "Unknown file."),
            };
            if !files.contains(&file) {
                return error(StatusCode::NOT_FOUND, "Unknown file.");
            }
            let root = &app.options.root;
            let text = match (&current.scope, &reference) {
                // A pull request's commits may not be in the local repository; read them from GitHub then.
                (Scope::Pr { .. }, Ref::Commit(sha)) if !git::has_commit(root, sha).await => {
                    github::read_remote_file(root, sha, &file).await
                }
                _ => git::read_side(root, &reference, &file).await,
            };
            match text {
                Ok(text) => {
                    let mut response = Response::new(Body::empty());
                    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
                    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                    compressed(&headers, response, text.into_bytes())
                }
                Err(_) => (StatusCode::NOT_FOUND, "").into_response(),
            }
        }
        (Method::POST, "/api/submit") => {
            let Ok(submission) = serde_json::from_slice::<Submission>(&body().await) else {
                return error(StatusCode::BAD_REQUEST, "Unknown decision.");
            };
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
            app.live.lock().unwrap().leaving = true;
            json(StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        (Method::GET, "/api/live") => live_stream(app.clone()),
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
            bind: "127.0.0.1:0".parse().unwrap(),
            hosts: vec![],
            secret: None,
            dev: None,
            unopened: Some(Duration::from_millis(20)),
        };
        let mut session = start(options, |port| port.to_string()).await.unwrap();
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

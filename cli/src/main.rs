//! `patchr review` opens the change in the browser and prints the reviewer's
//! feedback on stdout. Everything meant for a human goes to stderr, so stdout
//! carries only the result the agent acts on.

mod feedback;
mod git;
mod github;
mod install;
mod paths;
mod protocol;
mod server;

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::{ExitCode, Stdio};

use protocol::{Mode, Scope};
use server::Outcome;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn help() -> String {
    format!(
        "patchr {VERSION}: a browser diff review loop for coding agents

Usage:
  patchr review [directory] [--base <ref>] [--uncommitted | --staged] [--remote | --local] [--no-open]
  patchr install [--all] [--dry-run]   Add /patch to every agent harness found
  patchr uninstall                     Remove what install wrote

review opens the change in the browser and waits. By default it shows
everything a pull request would: the branch since it left its base, plus
uncommitted and untracked files. When the reviewer submits, the feedback is
printed on stdout as Markdown and patchr exits.

--remote serves the page on this machine's Tailscale address, behind a
one-time link, for a browser on another device. It is the default over SSH;
--local keeps the page on 127.0.0.1.

Environment:
  PATCH_BROWSER   Program that opens the page; \"none\" prints the URL only.
  PATCH_PORT      Port to listen on instead of a random one.
"
    )
}

/// Random letters and digits from the system's random source.
pub fn random_token(length: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = vec![0u8; length];
    let filled = std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_ok();
    if !filled {
        // No /dev/urandom (Windows): hash what differs between runs.
        use sha2::{Digest, Sha256};
        let seed = format!("{:?}{}{:p}", std::time::SystemTime::now(), std::process::id(), &bytes);
        bytes = Sha256::digest(seed.as_bytes()).iter().cycle().take(length).copied().collect();
    }
    bytes.iter().map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char).collect()
}

struct Args {
    directory: Option<String>,
    base: Option<String>,
    mode: Mode,
    remote: Option<bool>,
    open: bool,
    port: Option<u16>,
    dev: bool,
}

fn parse_review(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args {
        directory: None,
        base: None,
        mode: Mode::All,
        remote: None,
        open: true,
        port: std::env::var("PATCH_PORT").ok().and_then(|p| p.parse().ok()),
        dev: false,
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value = |name: &str| inline.clone().or_else(|| iter.next().cloned()).ok_or(format!("{name} needs a value."));
        match flag {
            "--base" => parsed.base = Some(value("--base")?),
            "--port" => parsed.port = Some(value("--port")?.parse().map_err(|_| "--port needs a number.")?),
            "--uncommitted" => parsed.mode = Mode::Uncommitted,
            "--staged" => parsed.mode = Mode::Staged,
            "--remote" => parsed.remote = Some(true),
            "--local" => parsed.remote = Some(false),
            "--no-open" => parsed.open = false,
            "--dev" => parsed.dev = true,
            flag if flag.starts_with('-') => return Err(format!("Unknown option {flag}.")),
            _ if parsed.directory.is_none() => parsed.directory = Some(arg.clone()),
            _ => return Err("Pass at most one directory.".into()),
        }
    }
    Ok(parsed)
}

fn open_browser(url: &str) {
    let browser = std::env::var("PATCH_BROWSER").or_else(|_| std::env::var("BROWSER")).ok();
    if browser.as_deref() == Some("none") {
        return;
    }
    let mut command = match browser {
        Some(browser) => {
            let mut command = std::process::Command::new(browser);
            command.arg(url);
            command
        }
        None if cfg!(target_os = "macos") => {
            let mut command = std::process::Command::new("open");
            command.arg(url);
            command
        }
        None if cfg!(windows) => {
            let mut command = std::process::Command::new("cmd");
            command.args(["/c", "start", "", url]);
            command
        }
        None => {
            let mut command = std::process::Command::new("xdg-open");
            command.arg(url);
            command
        }
    };
    let _ = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// This machine's Tailscale address and name, for serving the page to the tailnet.
fn tailscale() -> Option<(Ipv4Addr, String)> {
    let output = std::process::Command::new("tailscale").args(["status", "--json"]).stderr(Stdio::null()).output().ok()?;
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let me = status.get("Self")?;
    let name = me.get("DNSName")?.as_str()?.trim_end_matches('.').to_string();
    let ip = me.get("TailscaleIPs")?.as_array()?.iter().filter_map(|ip| ip.as_str()?.parse::<Ipv4Addr>().ok()).next()?;
    Some((ip, name))
}

/// The first free port in the range the user's previews use.
fn free_port(ip: Ipv4Addr) -> u16 {
    (8766..=8799).find(|port| std::net::TcpListener::bind((ip, *port)).is_ok()).unwrap_or(0)
}

async fn review(args: &[String]) -> Result<(), String> {
    let args = parse_review(args)?;
    let directory = PathBuf::from(args.directory.clone().unwrap_or_else(|| ".".into()));
    let root = git::find_root(&directory).await?;
    if let Some(base) = &args.base {
        git::find_base(&root, Some(base)).await?;
    }
    let scope = Scope::view(args.mode, if args.mode == Mode::All { args.base.clone() } else { None });
    let dev = args.dev.then(|| PathBuf::from(env!("PATCH_WEB_DIST")));

    let over_ssh = std::env::var_os("SSH_CONNECTION").is_some();
    let remote = args.remote.unwrap_or(over_ssh);
    let (options, public): (server::Options, Box<dyn FnOnce(u16) -> String>) = if remote {
        let (ip, name) = tailscale().ok_or(
            "Remote review needs Tailscale on this machine. Use --local and forward the port with ssh -L instead.",
        )?;
        let secret = random_token(24);
        let short = name.split('.').next().unwrap_or(&name).to_string();
        let port = args.port.unwrap_or_else(|| free_port(ip));
        let link = name.clone();
        let token = secret.clone();
        (
            server::Options {
                root: root.clone(),
                scope,
                bind: SocketAddr::new(IpAddr::V4(ip), port),
                hosts: vec![name.clone(), short, ip.to_string()],
                secret: Some(secret),
                dev,
            },
            Box::new(move |port| format!("http://{link}:{port}/?t={token}")),
        )
    } else {
        (
            server::Options {
                root: root.clone(),
                scope,
                bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), args.port.unwrap_or(0)),
                hosts: vec!["127.0.0.1".into(), "localhost".into()],
                secret: None,
                dev,
            },
            Box::new(|port| format!("http://127.0.0.1:{port}/")),
        )
    };

    let session = server::start(options, public).await?;
    eprintln!("Patch is open at {}", session.url);
    if remote {
        eprintln!("Open that link on any device on your tailnet. It works for this review only.");
    } else if args.open && !over_ssh {
        open_browser(&session.url);
    }

    let outcome = tokio::select! {
        outcome = session.outcome => outcome.unwrap_or(Outcome::Closed),
        _ = tokio::signal::ctrl_c() => std::process::exit(130),
    };
    // Let the page receive its answer before the process ends.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let root_text = root.to_string_lossy().into_owned();
    let text = match outcome {
        Outcome::Submitted(submission) => feedback::format(&submission, &git::repository_name(&root), &root_text),
        Outcome::Closed => feedback::CLOSED.to_string(),
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{text}");
    let _ = stdout.flush();
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = match args.split_first() {
        Some((command, rest)) => (command.as_str(), rest.to_vec()),
        None => ("review", Vec::new()),
    };
    let result: Result<(), String> = match command {
        "-v" | "--version" => {
            println!("{VERSION}");
            Ok(())
        }
        "-h" | "--help" | "help" => {
            println!("{}", help());
            Ok(())
        }
        "install" => install::install(rest.iter().any(|a| a == "--all"), rest.iter().any(|a| a == "--dry-run"))
            .map_err(|error| error.to_string()),
        "uninstall" => install::uninstall().map_err(|error| error.to_string()),
        _ => {
            // `patchr ../repo` and `patchr --base main` read as a review.
            let review_args = if command == "review" { rest } else { args.clone() };
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
            match runtime {
                Ok(runtime) => runtime.block_on(review(&review_args)),
                Err(error) => Err(error.to_string()),
            }
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("patchr: {message}");
            ExitCode::from(2)
        }
    }
}

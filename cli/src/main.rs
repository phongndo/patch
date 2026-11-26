//! `patchr review` opens the change in the browser and prints the reviewer's
//! feedback on stdout. Everything meant for a human goes to stderr, so stdout
//! carries only the result the agent acts on.

mod channel;
mod feedback;
mod git;
mod github;
mod harness;
mod install;
mod paths;
mod protocol;
mod server;
#[cfg(unix)]
mod slot;
mod tailnet;
mod update;

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::{ExitCode, Stdio};

use protocol::{Mode, Scope};
use server::Outcome;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// In every build, so `install` can tell a Patch from another program.
pub const ABOUT: &str = "a browser diff review loop for coding agents";

fn help() -> String {
    format!(
        "patchr {VERSION}: {ABOUT}

Usage:
  patchr review [directory] [--base <ref>] [--uncommitted | --staged] [--remote | --local] [--no-open]
  patchr install [--all] [--dry-run]   Add /patch to every agent harness found
  patchr update                        Update Patch, however it was installed
  patchr uninstall                     Remove what install wrote

review opens the change in the browser and waits. By default it shows
everything a pull request would: the branch since it left its base, plus
uncommitted and untracked files. When the reviewer submits, the feedback is
printed on stdout as Markdown and patchr exits.

On a machine signed in to Tailscale, the page is also served on its tailnet
address, and the link printed opens on any of your devices there. --local
keeps the page on 127.0.0.1; --remote fails without Tailscale.

Environment:
  PATCH_BROWSER   Program that opens the page; \"none\" prints the URL only.
  PATCH_PORT      Port to listen on instead of a random one.
  PATCH_REMOTE    1 or 0: --remote or --local, unless one is passed.
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

/// How long a Codex review waits for someone to open its page.
const UNOPENED_GRACE: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);

struct Args {
    directory: Option<String>,
    base: Option<String>,
    mode: Mode,
    remote: Option<bool>,
    open: bool,
    port: Option<u16>,
    dev: bool,
    /// A harness adapter runs this, so a closed review has no model to tell.
    adapter: bool,
    /// A path in the repository to review when the user names none.
    near: Option<String>,
    /// The Codex thread that gets the feedback, instead of stdout.
    codex: Option<String>,
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
        adapter: false,
        near: None,
        codex: None,
    };
    // What the user typed is read on its own: it can neither reach an adapter's
    // flags nor take them as values.
    match args.iter().position(|arg| arg == "--typed") {
        Some(at) => {
            parsed.adapter = true;
            let typed = args.get(at + 1).ok_or("--typed needs a value.")?;
            parse_words(&mut parsed, &harness::split(typed)?, false)?;
            parse_words(&mut parsed, &[&args[..at], &args[at + 2..]].concat(), true)?;
        }
        None => parse_words(&mut parsed, args, false)?,
    }
    Ok(parsed)
}

fn parse_words(parsed: &mut Args, args: &[String], adapter: bool) -> Result<(), String> {
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
            "--near" if adapter => parsed.near = Some(value("--near")?),
            "--codex" if adapter => parsed.codex = Some(value("--codex")?),
            flag if flag.starts_with('-') => return Err(format!("Unknown option {flag}.")),
            _ if parsed.directory.is_none() => parsed.directory = Some(arg.clone()),
            _ => return Err("Pass at most one directory.".into()),
        }
    }
    Ok(())
}

/// Opens a running review's page again when no browser has it any more.
pub fn reopen(url: &str) {
    // A review listens on loopback at the port of any link it printed. Only one
    // that opens a browser itself does again; its answer says whether it wants to.
    let authority = url.strip_prefix("http://").and_then(|rest| rest.split('/').next()).unwrap_or_default();
    let Some(port) = authority.rsplit_once(':').and_then(|(_, port)| port.parse::<u16>().ok()) else { return };
    let host = format!("127.0.0.1:{port}");
    let ask = || -> std::io::Result<String> {
        let wait = std::time::Duration::from_secs(2);
        let mut stream = std::net::TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), wait)?;
        stream.set_read_timeout(Some(wait))?;
        write!(stream, "GET /api/reopen HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer)?;
        Ok(answer)
    };
    if ask().is_ok_and(|answer| answer.ends_with("{\"reopen\":true}")) {
        let query = url.split_once('?').map(|(_, query)| format!("?{query}")).unwrap_or_default();
        open_browser(&format!("http://{host}/{query}"));
    }
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

async fn review(args: &[String]) -> Result<(), String> {
    let args = parse_review(args)?;
    let near = match (&args.directory, &args.near) {
        (None, Some(path)) => harness::repository_near(path).await,
        _ => None,
    };
    let root = match near {
        Some(root) => root,
        None => git::find_root(&PathBuf::from(args.directory.clone().unwrap_or_else(|| ".".into()))).await?,
    };
    install::refresh(&root);
    if let Some(base) = &args.base {
        git::find_base(&root, Some(base)).await?;
    }
    let scope = Scope::view(args.mode, if args.mode == Mode::All { args.base.clone() } else { None });
    // A Codex review has no harness process to end it.
    let unopened = args.codex.is_some().then_some(UNOPENED_GRACE);
    let dev = args.dev.then(|| PathBuf::from(env!("PATCH_WEB_DIST")));

    let over_ssh = std::env::var_os("SSH_CONNECTION").is_some();
    let wanted = args.remote.or_else(|| match std::env::var("PATCH_REMOTE").ok()?.as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    });
    let machine = if wanted == Some(false) { None } else { tailnet::find().await };
    if wanted == Some(true) && machine.is_none() {
        return Err("--remote needs Tailscale running on this machine. Without it, forward the port with ssh -L.".into());
    }
    let secret = random_token(24);
    let tailnet = |machine: &tailnet::Machine| {
        let mut hosts = vec![machine.ip.to_string()];
        if machine.name != hosts[0] {
            let short = machine.name.split('.').next().unwrap_or(&machine.name).to_string();
            hosts.extend([machine.name.clone(), short]);
        }
        server::Tailnet {
            ip: machine.ip,
            hosts,
            secret: secret.clone(),
            owner: machine.owner.map(|account| server::Owner { account, cli: machine.cli.clone() }),
        }
    };
    let opens = args.open && !over_ssh;
    let options = |tailnet| server::Options {
        root: root.clone(),
        scope: scope.clone(),
        port: args.port.unwrap_or(0),
        tailnet,
        dev: dev.clone(),
        unopened,
        opens,
        compress: over_ssh,
    };

    let (mut session, machine) = match &machine {
        Some(machine) => match server::start(options(Some(tailnet(machine)))).await {
            Ok(session) => (session, Some(machine)),
            // An address Tailscale named but this machine cannot listen on.
            Err(why) if wanted.is_none() => {
                eprintln!("Not on the tailnet: {why}");
                (server::start(options(None)).await?, None)
            }
            Err(why) => return Err(why),
        },
        None => (server::start(options(None)).await?, None),
    };
    // Loopback takes the link as well while the page is on the tailnet.
    let query = if machine.is_some() { format!("?t={secret}") } else { String::new() };
    let local = format!("http://127.0.0.1:{}/{query}", session.port);
    match machine {
        Some(machine) => {
            eprintln!("Patch is open at http://{}:{}/{query}", machine.name, session.port);
            let who = if machine.owner.is_some() { "Your devices on Tailscale" } else { "Devices on your tailnet" };
            eprintln!("{who} can open that link, for this review only; on this machine it is also at {local}");
        }
        None => eprintln!("Patch is open at {local}"),
    }
    if opens {
        open_browser(&local);
    }

    let outcome = tokio::select! {
        outcome = &mut session.outcome => outcome.unwrap_or(Outcome::Closed),
        _ = tokio::signal::ctrl_c() => std::process::exit(130),
    };
    let root_text = root.to_string_lossy().into_owned();
    let text = match outcome {
        Outcome::Submitted(submission) => Some(feedback::format(&submission, &git::repository_name(&root), &root_text)),
        Outcome::Unopened => None,
        Outcome::Closed => (!args.adapter).then(|| feedback::CLOSED.to_string()),
    };
    let submitted = text.as_ref().is_some_and(|text| text != feedback::CLOSED);
    // Kept before anything can fail: the page closes as soon as it has its answer.
    let output = match &text {
        Some(text) if args.adapter && args.codex.is_none() => Some(harness::receipt(text)),
        _ => text.clone(),
    };
    // Let the page receive its answer before the process ends.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    if let Some(thread) = &args.codex {
        harness::finish_codex(thread, text.as_deref());
    } else if let Some(output) = output {
        let mut stdout = std::io::stdout().lock();
        let printed = writeln!(stdout, "{output}").and_then(|()| stdout.flush());
        // Nobody is reading any more; an adapter's receipt already kept it.
        if printed.is_err() && submitted && !args.adapter {
            let file = harness::keep(&random_token(24), &output).map_err(|error| error.to_string())?;
            return Err(format!("Nothing read the feedback. It is kept in {}", file.display()));
        }
    }
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
        "install" => install::install(rest.iter().any(|a| a == "--all"), rest.iter().any(|a| a == "--dry-run")),
        "update" => update::update(),
        "hook" if rest.first().is_some_and(|name| name == "codex") => {
            harness::codex_hook();
            Ok(())
        }
        "hook" if rest.first().is_some_and(|name| name == "delivered") => {
            if let Some(receipt) = rest.get(1) {
                harness::delivered(receipt);
            }
            Ok(())
        }
        "hook" if rest.first().is_some_and(|name| name == "reopen") => {
            if let Some(url) = rest.get(1) {
                reopen(url);
            }
            Ok(())
        }
        "uninstall" => install::uninstall(),
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

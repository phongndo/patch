//! `patchr update`: one command however Patch was installed. Its package manager
//! does the upgrade where there is one; otherwise the install script does, from
//! the latest release. The new version then writes its own harness files, which
//! the next review would otherwise do.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::channel::{self, Channel};
use crate::install::{bin_path, copied_from, home_dir};

const SCRIPT: &str = "https://github.com/phongndo/patch/releases/latest/download/install.sh";

fn run(program: &Path, args: &[String]) -> Result<(), String> {
    // Not where the user is: a project there may configure the package manager.
    let status = Command::new(program).args(args).current_dir(home_dir()).status();
    let status = status.map_err(|error| format!("Could not run {}: {error}", program.display()))?;
    if status.success() { Ok(()) } else { Err(format!("{} {} failed.", program.display(), args.join(" "))) }
}

/// Fetches the whole script before running any of it.
fn run_script() -> Result<(), String> {
    let url = std::env::var("PATCH_INSTALL_SCRIPT").unwrap_or_else(|_| SCRIPT.into());
    let output = Command::new("curl").args(["-fsSL", "--retry", "3", &url]).output();
    let output = output.map_err(|error| format!("Could not run curl: {error}"))?;
    if !output.status.success() {
        return Err(format!("Could not download {url}: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let mut shell = Command::new("sh").stdin(Stdio::piped()).spawn().map_err(|error| format!("Could not run sh: {error}"))?;
    if let Some(mut stdin) = shell.stdin.take() {
        let _ = stdin.write_all(&output.stdout);
    }
    let status = shell.wait().map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err("The install script failed.".into()) }
}

/// The patchr that mise selects for the user, wherever its versions are.
fn mise_patchr() -> Result<PathBuf, String> {
    let output = Command::new("mise").args(["which", "patchr"]).current_dir(home_dir()).stderr(Stdio::null()).output();
    let path = output.ok().filter(|output| output.status.success()).map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let path = path.filter(|path| !path.is_empty()).map(PathBuf::from);
    path.ok_or("mise selects no Patch for your home folder. Where it does, run: mise exec -- patchr install".into())
}

pub fn update() -> Result<(), String> {
    let bin = bin_path();
    let installed = bin.canonicalize().or_else(|_| std::env::current_exe().and_then(std::fs::canonicalize));
    let installed = installed.map_err(|error| error.to_string())?;
    // A copy is its package manager's too, where it came from one.
    let origin = copied_from().filter(|_| bin.exists());
    let channel = match (channel::of(&installed), origin) {
        (Channel::Unmanaged, Some(origin)) => channel::of(&origin),
        (channel, _) => channel,
    };
    let copied = channel::of(&installed) == Channel::Unmanaged;
    match &channel {
        // The script ends with the new version's own `patchr install`.
        Channel::Unmanaged => return run_script(),
        Channel::Nix if copied => return Err("Patch came from Nix. Run: nix run --refresh github:phongndo/patch -- install".into()),
        Channel::Nix => return Err("Patch came from Nix. Update the profile or flake that has it; your harnesses follow.".into()),
        Channel::Homebrew { .. } | Channel::Mise { .. } => {}
    }
    let command = channel.upgrade().ok_or("Update Patch with the package manager that installed it, then run its patchr install.")?;
    eprintln!("Updating with: {}", command.join(" "));
    run(Path::new(&command[0]), &command[1..])?;
    let updated = match &channel {
        Channel::Homebrew { prefix, formula } => prefix.join("opt").join(formula).join("bin/patchr"),
        _ => mise_patchr()?,
    };
    run(&updated, &["install".into()])
}

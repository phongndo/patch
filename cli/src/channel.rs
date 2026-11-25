//! How a `patchr` was installed, read from where it is: what its package manager
//! calls it, and a path that stays right across upgrades.

use std::path::{Path, PathBuf};

use crate::install::{bin_path, home_dir};

#[derive(Debug, PartialEq)]
pub enum Channel {
    Homebrew { prefix: PathBuf, formula: String },
    Mise { tool: PathBuf, inside: PathBuf },
    Nix,
    /// A file nobody else manages: the install script's, npm's or a build's.
    Unmanaged,
}

/// The channel of a binary's real path, with every link resolved.
pub fn of(real: &Path) -> Channel {
    let parts: Vec<_> = real.components().collect();
    let names: Vec<_> = parts.iter().map(|part| part.as_os_str().to_string_lossy()).collect();
    let path = |range: &[std::path::Component]| range.iter().collect::<PathBuf>();
    // npm's own folders may be inside a Node that mise or Homebrew installed.
    if names.iter().any(|name| name == "node_modules") {
        return Channel::Unmanaged;
    }
    if real.starts_with("/nix/store") {
        return Channel::Nix;
    }
    if let Some(at) = names.iter().position(|name| name == "Cellar").filter(|at| at + 2 < names.len()) {
        return Channel::Homebrew { prefix: path(&parts[..at]), formula: names[at + 1].to_string() };
    }
    if let Some(at) = names.windows(2).position(|pair| pair[0] == "mise" && pair[1] == "installs").filter(|at| at + 4 < names.len()) {
        return Channel::Mise { tool: path(&parts[..at + 3]), inside: path(&parts[at + 4..]) };
    }
    Channel::Unmanaged
}

impl Channel {
    /// Where this channel keeps its current version, for a link that follows upgrades.
    /// None when it has no such path, as for a version pinned below the latest.
    pub fn stable(&self, real: &Path) -> Option<PathBuf> {
        let candidates = match self {
            Channel::Homebrew { prefix, formula } => vec![prefix.join("opt").join(formula).join("bin/patchr")],
            // What the user's own config selects, pinned or not. `latest` would leave a pin behind.
            Channel::Mise { tool, inside } => vec![tool.join("global").join(inside)],
            Channel::Nix => {
                let path = std::env::var_os("PATH").unwrap_or_default();
                let user = std::env::var_os("USER").unwrap_or_default();
                std::env::split_paths(&path)
                    .chain([
                        home_dir().join(".nix-profile/bin"),
                        home_dir().join(".local/state/nix/profile/bin"),
                        Path::new("/etc/profiles/per-user").join(user).join("bin"),
                        "/run/current-system/sw/bin".into(),
                    ])
                    .filter(|dir| dir.is_absolute() && !dir.starts_with("/nix/store"))
                    .map(|dir| dir.join("patchr"))
                    .collect()
            }
            Channel::Unmanaged => Vec::new(),
        };
        let ours = bin_path();
        let our_dir = ours.parent().and_then(|dir| dir.canonicalize().ok());
        candidates
            .into_iter()
            .filter(|path| path.parent().and_then(|dir| dir.canonicalize().ok()) != our_dir)
            .find(|path| path.canonicalize().is_ok_and(|target| target == real))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_each_manager_by_its_folders() {
        let homebrew = of(Path::new("/opt/homebrew/Cellar/patchr/0.1.0/bin/patchr"));
        assert_eq!(homebrew, Channel::Homebrew { prefix: "/opt/homebrew".into(), formula: "patchr".into() });

        let mise = of(Path::new("/h/.local/share/mise/installs/github-phongndo-patch/0.1.0/patchr"));
        let tool = PathBuf::from("/h/.local/share/mise/installs/github-phongndo-patch");
        assert_eq!(mise, Channel::Mise { tool, inside: "patchr".into() });

        assert_eq!(of(Path::new("/nix/store/abc-patchr-0.1.0/bin/patchr")), Channel::Nix);
        assert_eq!(of(Path::new("/h/.local/bin/patchr")), Channel::Unmanaged);
    }

    #[test]
    fn npm_is_unmanaged_wherever_node_came_from() {
        let npm = "lib/node_modules/@phongndo/patchr-darwin-arm64/bin/patchr";
        assert_eq!(of(&Path::new("/h/.local/share/mise/installs/node/26.13.1").join(npm)), Channel::Unmanaged);
        assert_eq!(of(&Path::new("/opt/homebrew/Cellar/node/26").join(npm)), Channel::Unmanaged);
    }

    #[cfg(unix)]
    #[test]
    fn a_stable_path_follows_the_current_version_only() {
        let root = std::env::temp_dir().join(format!("patch-channel-{}", std::process::id()));
        let tool = root.join("mise/installs/github-phongndo-patch");
        for version in ["0.1.0", "0.2.0"] {
            std::fs::create_dir_all(tool.join(version)).unwrap();
            std::fs::write(tool.join(version).join("patchr"), "").unwrap();
        }
        std::os::unix::fs::symlink("./0.2.0", tool.join("latest")).unwrap();
        let stable = |version: &str| {
            let real = tool.join(version).join("patchr").canonicalize().unwrap();
            of(&real).stable(&real)
        };
        assert_eq!(stable("0.2.0"), None);
        std::os::unix::fs::symlink("./0.1.0", tool.join("global")).unwrap();
        assert_eq!(stable("0.1.0"), Some(tool.canonicalize().unwrap().join("global/patchr")));
        assert_eq!(stable("0.2.0"), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

//! A file reached through a handle on its folder. A path can be pointed elsewhere
//! between checking it and writing to it; the folder behind a handle cannot.

use std::ffi::OsString;
use std::fs::File;
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::os::fd::OwnedFd;
use std::path::{Component, Path};

use rustix::fs::{AtFlags, Mode, OFlags, fchmod, fstat, mkdirat, open, openat, renameat, stat, statat, unlinkat};

const FOLDER: OFlags = OFlags::RDONLY.union(OFlags::DIRECTORY).union(OFlags::CLOEXEC);

pub struct Slot {
    /// The deepest folder that exists.
    folder: OwnedFd,
    /// The folders still to be made in it.
    missing: Vec<OsString>,
    name: OsString,
    outside: (u64, u64),
}

type Id = rustix::fs::Stat;

#[allow(clippy::unnecessary_cast)] // their types differ between systems
fn id(stat: &Id) -> (u64, u64) {
    (stat.st_dev as u64, stat.st_ino as u64)
}

/// Whether a folder is another or inside it, by what they are, not by their paths.
fn is_within(folder: &OwnedFd, other: (u64, u64)) -> Result<bool> {
    let mut at = openat(folder, ".", FOLDER, Mode::empty())?;
    loop {
        let here = id(&fstat(&at)?);
        if here == other {
            return Ok(true);
        }
        let parent = openat(&at, "..", FOLDER, Mode::empty())?;
        if id(&fstat(&parent)?) == here {
            return Ok(false);
        }
        at = parent;
    }
}

impl Slot {
    /// The file at a path with no links left to follow. Fails inside `outside`.
    pub fn open(path: &Path, outside: &Path) -> Result<Slot> {
        let parent = path.parent().ok_or(ErrorKind::InvalidInput)?;
        let name = path.file_name().ok_or(ErrorKind::InvalidInput)?.to_os_string();
        let exists = parent.ancestors().find(|dir| dir.is_dir()).ok_or(ErrorKind::NotFound)?;
        let missing = parent.strip_prefix(exists).map_err(Error::other)?.components();
        let missing = missing.map(|part| match part {
            Component::Normal(part) => Ok(part.to_os_string()),
            _ => Err(Error::from(ErrorKind::InvalidInput)),
        });
        let slot = Slot {
            folder: open(exists, FOLDER, Mode::empty())?,
            missing: missing.collect::<Result<_>>()?,
            name,
            outside: id(&stat(outside)?),
        };
        slot.check(&slot.folder)?;
        Ok(slot)
    }

    fn check(&self, folder: &OwnedFd) -> Result<()> {
        if is_within(folder, self.outside)? { Err(ErrorKind::PermissionDenied.into()) } else { Ok(()) }
    }

    /// The folder itself, made if need be, checked at every step.
    fn folder(&self) -> Result<OwnedFd> {
        let mut at = openat(&self.folder, ".", FOLDER, Mode::empty())?;
        self.check(&at)?;
        for part in &self.missing {
            match mkdirat(&at, part, Mode::from_raw_mode(0o777)) {
                Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
            at = openat(&at, part, FOLDER | OFlags::NOFOLLOW, Mode::empty())?;
            self.check(&at)?;
        }
        Ok(at)
    }

    pub fn read(&self) -> Result<Vec<u8>> {
        if !self.missing.is_empty() {
            return Err(ErrorKind::NotFound.into());
        }
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut bytes = Vec::new();
        File::from(openat(&self.folder, &self.name, flags, Mode::empty())?).read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    /// Replaces the file in one step, keeping its permissions.
    pub fn replace(&self, text: &str) -> Result<()> {
        let folder = self.folder()?;
        let temporary = format!(".patchr-{}.tmp", crate::random_token(12));
        let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut file = File::from(openat(&folder, &temporary, flags, Mode::from_raw_mode(0o666))?);
        let replaced = file
            .write_all(text.as_bytes())
            .and_then(|()| match statat(&folder, &self.name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(old) => Ok(fchmod(&file, Mode::from_raw_mode(old.st_mode))?),
                Err(_) => Ok(()),
            })
            .and_then(|()| Ok(renameat(&folder, &temporary, &folder, &self.name)?));
        if replaced.is_err() {
            let _ = unlinkat(&folder, &temporary, AtFlags::empty());
        }
        replaced
    }

    /// The file itself, made if need be, for locking.
    pub fn file(&self) -> Result<File> {
        let flags = OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        Ok(openat(self.folder()?, &self.name, flags, Mode::from_raw_mode(0o666))?.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn writes_where_it_looked_even_when_the_path_is_moved() {
        let root = std::env::temp_dir().join(format!("patch-slot-{}", std::process::id()));
        let (config, repository) = (root.join("config"), root.join("repository"));
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(repository.join("deep")).unwrap();
        fs::write(config.join("a"), "old").unwrap();
        fs::set_permissions(config.join("a"), fs::Permissions::from_mode(0o600)).unwrap();

        let slot = Slot::open(&config.join("a"), &repository).unwrap();
        let fresh = Slot::open(&config.join("new/folder/b"), &repository).unwrap();
        // The folder moves away and its path now leads into the repository.
        fs::rename(&config, root.join("moved")).unwrap();
        symlink(&repository, &config).unwrap();
        assert_eq!(slot.read().unwrap(), b"old");
        slot.replace("new").unwrap();
        fresh.replace("new").unwrap();
        assert_eq!(fs::read_to_string(root.join("moved/a")).unwrap(), "new");
        assert_eq!(fs::metadata(root.join("moved/a")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(root.join("moved/new/folder/b")).unwrap(), "new");
        assert_eq!(fs::read_dir(&repository).unwrap().count(), 1);

        // Inside it, however it is reached, or once its folder has moved there.
        assert!(Slot::open(&repository.join("deep/c"), &repository).is_err());
        assert!(Slot::open(&config.join("deep/c"), &repository).is_err());
        fs::rename(root.join("moved"), repository.join("moved")).unwrap();
        assert!(slot.replace("newer").is_err());
        assert_eq!(fs::read_to_string(repository.join("moved/a")).unwrap(), "new");

        // A folder still to be made that has become a link is not followed.
        let late = Slot::open(&root.join("late/d"), &repository).unwrap();
        symlink(&repository, root.join("late")).unwrap();
        assert!(late.replace("new").is_err());
        assert!(!repository.join("d").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}

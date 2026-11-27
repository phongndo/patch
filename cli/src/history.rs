//! The commits the picker lists and searches. Browsing pages through `git log` from the HEAD the
//! first page pinned, which is quick however deep it goes. A search reads the whole history once
//! per HEAD into a compact index, then scans it in memory, each page resuming at the commit after
//! the last one examined. Both run off the server's one thread: reading and scanning a large
//! history takes seconds and milliseconds.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use memchr::memmem;

use crate::git::Result;
use crate::protocol::Commit;

/// The commits a page lists.
pub const PAGE: usize = 100;

/// Each commit as `git log` writes it: its id, when it was committed, its author, a NUL, its
/// subject. An author's name holds neither a NUL nor a newline, and a subject no newline.
const FORMAT: &str = "--format=%H %ct %an%x00%s";

/// Git, read-only and never asking anything, as `git::run` runs it, for a blocking thread.
fn git(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(["-c", "log.showSignature=false", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::jj::git_env_blocking(&mut command, root);
    command
}

/// A commit's id, time, author and subject, as `FORMAT` writes them.
type Fields<'a> = (&'a [u8], u32, &'a [u8], &'a [u8]);

/// One line of `FORMAT`, split.
fn fields(line: &[u8]) -> Option<Fields<'_>> {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let space = memchr::memchr(b' ', line)?;
    let (id, rest) = (&line[..space], &line[space + 1..]);
    let space = memchr::memchr(b' ', rest)?;
    let time = std::str::from_utf8(&rest[..space]).ok()?.parse::<u32>().unwrap_or(0);
    let rest = &rest[space + 1..];
    let nul = memchr::memchr(0, rest)?;
    Some((id, time, &rest[..nul], &rest[nul + 1..]))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn commit(id: &str, short: usize, time: u32, author: &[u8], subject: &[u8], now: u64) -> Commit {
    Commit {
        sha: id.to_string(),
        short: id[..short.min(id.len())].to_string(),
        subject: text(subject),
        author: text(author),
        when: relative(now, time as u64),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or(0)
}

fn plural(count: u64, one: &str) -> String {
    if count == 1 { format!("1 {one}") } else { format!("{count} {one}s") }
}

/// How long ago `then` was, as Git says it for `%cr`.
pub fn relative(now: u64, then: u64) -> String {
    let Some(diff) = now.checked_sub(then) else { return "in the future".into() };
    if diff < 90 {
        return format!("{} ago", plural(diff, "second"));
    }
    let minutes = (diff + 30) / 60;
    if minutes < 90 {
        return format!("{} ago", plural(minutes, "minute"));
    }
    let hours = (minutes + 30) / 60;
    if hours < 36 {
        return format!("{} ago", plural(hours, "hour"));
    }
    let days = (hours + 12) / 24;
    if days < 14 {
        return format!("{} ago", plural(days, "day"));
    }
    if days < 70 {
        return format!("{} ago", plural((days + 3) / 7, "week"));
    }
    if days < 365 {
        return format!("{} ago", plural((days + 15) / 30, "month"));
    }
    if days < 1825 {
        let months = (days * 12 * 2 + 365) / (365 * 2);
        let (years, months) = (months / 12, months % 12);
        return if months == 0 {
            format!("{} ago", plural(years, "year"))
        } else {
            format!("{}, {} ago", plural(years, "year"), plural(months, "month"))
        };
    }
    format!("{} ago", plural((days + 183) / 365, "year"))
}

/// How many letters of an id name a commit here, as `%h` would show them.
fn short_length(root: &Path, tip: &str) -> usize {
    let short = git(root, &["rev-parse", "--short", tip]).output().ok().map(|output| output.stdout);
    short.map(|out| out.trim_ascii().len()).filter(|length| *length >= 4).unwrap_or(7)
}

/// HEAD's commit, which pins the history the pages list; none on an unborn branch.
#[cfg(test)]
pub fn head(root: &Path) -> Option<String> {
    let output = git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).output().ok()?;
    let id = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && is_id(&id)).then_some(id)
}

/// A full commit id, as a cursor carries it.
pub fn is_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// The commits of `tip`'s history from `skip` on, and whether there are more.
pub fn browse(root: &Path, tip: &str, skip: usize) -> Result<(Vec<Commit>, bool)> {
    let (skip, count) = (format!("--skip={skip}"), format!("--max-count={}", PAGE + 1));
    let output = git(root, &["log", FORMAT, &skip, &count, tip, "--"]).output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Git could not list the commits.".into());
    }
    let short = short_length(root, tip);
    let now = now();
    let mut commits: Vec<Commit> = output
        .stdout
        .split_inclusive(|byte| *byte == b'\n')
        .filter_map(fields)
        .map(|(id, time, author, subject)| commit(&text(id), short, time, author, subject, now))
        .collect();
    let more = commits.len() > PAGE;
    commits.truncate(PAGE);
    Ok((commits, more))
}

/// One commit, by an id or a prefix of one the user typed, if it names one.
pub fn exact(root: &Path, typed: &str) -> Option<Commit> {
    let typed = typed.trim().to_ascii_lowercase();
    if !(7..=64).contains(&typed.len()) || !typed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let output =
        git(root, &["log", FORMAT, "--no-walk", "--end-of-options", &format!("{typed}^{{commit}}"), "--"]).output().ok()?;
    let (id, time, author, subject) = fields(output.stdout.split_inclusive(|byte| *byte == b'\n').next()?)?;
    let id = text(id);
    // Git also takes hex digits for a branch or tag of that name: only an id that starts so counts.
    if !id.starts_with(&typed) {
        return None;
    }
    Some(commit(&id, short_length(root, &id), time, author, subject, now()))
}

/// Every commit of a history, compactly: about 110 bytes each, where `git log` writes 140. It
/// is kept in the runs it was read in, each its own segment, so nothing is copied to join them.
pub struct Index {
    /// Shared with the index of an earlier HEAD whose history this one holds.
    segments: Vec<Arc<Segment>>,
    /// How many commits come before each segment.
    firsts: Vec<usize>,
    /// Bytes in a commit's id.
    width: usize,
    /// Letters of an id that name it here.
    short: usize,
    count: usize,
}

/// A run of commits, in the history's order.
#[derive(Default)]
struct Segment {
    /// Each commit's id as bytes, `width` each.
    ids: Vec<u8>,
    times: Vec<u32>,
    /// Each commit's author and subject, "author\0subject\n", with ASCII letters lowercased: what
    /// a search scans.
    lower: Vec<u8>,
    /// Which bytes of `lower` were capitals, a bit each: with it, `lower` gives the text back,
    /// at an eighth of the memory a copy would take.
    capitals: Vec<u64>,
    /// Where each commit's text starts, and one more where the last ends.
    starts: Vec<u32>,
}

fn hex_value(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}

/// Below this many commits, one `git log` reads the history faster than several would.
const ON_ITS_OWN: usize = 20_000;
/// The most `git log`s reading one history at a time; more stop paying off.
const READERS: usize = 12;

impl Segment {
    /// Everything `git log` with `args` writes, read as it comes; `input` is written to it first,
    /// and `count` commits are expected, if known.
    fn read(root: &Path, args: &[&str], input: Option<&[u8]>, width: usize, count: usize) -> Result<Segment> {
        let mut command = git(root, args);
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdout = child.stdout.take().ok_or("Git has no output.")?;
        let read = std::thread::scope(|scope| {
            // Written on its own, so a full pipe either way never waits on the other.
            if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
                scope.spawn(move || std::io::Write::write_all(&mut stdin, input));
            }
            let mut segment = Segment {
                ids: Vec::with_capacity(count * width),
                times: Vec::with_capacity(count),
                // An author and a subject come to about 80 bytes.
                lower: Vec::with_capacity(count * 88),
                starts: Vec::with_capacity(count + 1),
                ..Segment::default()
            };
            segment.starts.push(0);
            let mut reader = BufReader::with_capacity(1 << 20, stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                if reader.read_until(b'\n', &mut line).map_err(|error| error.to_string())? == 0 {
                    return Ok::<_, String>(segment);
                }
                let Some((id, time, author, subject)) = fields(&line) else { continue };
                if id.len() != width * 2 {
                    continue;
                }
                segment.ids.extend(id.as_chunks::<2>().0.iter().map(|[high, low]| hex_value(*high) << 4 | hex_value(*low)));
                segment.times.push(time);
                segment.lower.extend_from_slice(author);
                segment.lower.push(0);
                segment.lower.extend_from_slice(subject);
                segment.lower.push(b'\n');
                segment.starts.push(u32::try_from(segment.lower.len()).map_err(|_| "The history is too large to search.")?);
            }
        });
        if !child.wait().map_err(|error| error.to_string())?.success() {
            return Err("Git could not read the history.".into());
        }
        let mut segment = read?;
        segment.lower.shrink_to_fit();
        segment.fold();
        Ok(segment)
    }

    fn len(&self) -> usize {
        self.times.len()
    }

    /// Lowercases the text read, noting each capital.
    fn fold(&mut self) {
        self.capitals = vec![0; self.lower.len().div_ceil(64)];
        for (at, byte) in self.lower.iter_mut().enumerate() {
            if byte.is_ascii_uppercase() {
                self.capitals[at / 64] |= 1 << (at % 64);
                *byte = byte.to_ascii_lowercase();
            }
        }
    }

    fn span(&self, at: usize) -> (usize, usize) {
        (self.starts[at] as usize, self.starts[at + 1] as usize)
    }

    /// The byte at `at` of the text as it was written.
    fn byte(&self, at: usize) -> u8 {
        let byte = self.lower[at];
        if self.capitals[at / 64] >> (at % 64) & 1 == 1 { byte.to_ascii_uppercase() } else { byte }
    }

    /// Whether the text at `at` is `written`, capitals and all.
    fn written(&self, at: usize, written: &[u8]) -> bool {
        written.iter().enumerate().all(|(offset, byte)| self.byte(at + offset) == *byte)
    }

    /// Commit `at`'s author and subject as written.
    fn text(&self, at: usize) -> Vec<u8> {
        let (start, end) = self.span(at);
        (start..end).map(|at| self.byte(at)).collect()
    }
}

impl Index {
    /// Reads all of `tip`'s history: a blocking read of about a second in a large repository.
    /// Most of it is Git taking each commit apart, so a long history is read in runs, each by its
    /// own `git log`, at the same time.
    pub fn build(root: &Path, tip: &str) -> Result<Index> {
        let width = tip.len() / 2;
        let listed = git(root, &["rev-list", tip, "--"]).output().map_err(|error| error.to_string())?;
        if !listed.status.success() {
            return Err("Git could not list the history.".into());
        }
        let listed = listed.stdout;
        let total = memchr::memchr_iter(b'\n', &listed).count();
        let readers = std::thread::available_parallelism().map_or(1, |cores| cores.get()).clamp(1, READERS);
        let segments: Vec<Segment> = if total < ON_ITS_OWN || readers == 1 {
            vec![Segment::read(root, &["log", FORMAT, tip, "--"], None, width, total)?]
        } else {
            // Runs of the list as it is, cut at its lines, each with how many commits it holds.
            let per = total.div_ceil(readers);
            let mut runs: Vec<(&[u8], usize)> = Vec::with_capacity(readers);
            let (mut start, mut lines) = (0, 0);
            for end in memchr::memchr_iter(b'\n', &listed) {
                lines += 1;
                if lines == per {
                    runs.push((&listed[start..=end], lines));
                    (start, lines) = (end + 1, 0);
                }
            }
            if lines > 0 {
                runs.push((&listed[start..], lines));
            }
            let args = ["log", "--no-walk=unsorted", "--stdin", FORMAT];
            std::thread::scope(|scope| {
                let reading: Vec<_> = runs
                    .into_iter()
                    .map(|(run, count)| scope.spawn(move || Segment::read(root, &args, Some(run), width, count)))
                    .collect();
                reading
                    .into_iter()
                    .map(|reading| reading.join().map_err(|_| "Reading the history failed.".to_string())?)
                    .collect::<Result<Vec<Segment>>>()
            })?
        };
        let index = Index::of(segments.into_iter().map(Arc::new).collect(), width, short_length(root, tip));
        if index.count != total {
            return Err("Git read another history than it listed.".into());
        }
        Ok(index)
    }

    fn of(segments: Vec<Arc<Segment>>, width: usize, short: usize) -> Index {
        let mut firsts = Vec::with_capacity(segments.len());
        let mut count = 0;
        for segment in &segments {
            firsts.push(count);
            count += segment.len();
        }
        Index { segments, firsts, width, short, count }
    }

    /// `tip`'s history from the index of `kept`: when `tip` is `kept_tip` with a line of commits
    /// on it, only those are read, and put before the rest, which is shared. That is the order
    /// `git log` gives them. A merge among them may weave its branch's commits into the rest, so
    /// then, or when much came since, all of it is read.
    pub fn build_on(root: &Path, kept: &Index, kept_tip: &str, tip: &str) -> Result<Index> {
        let after = git(root, &["merge-base", "--is-ancestor", kept_tip, tip]).status().is_ok_and(|status| status.success());
        let since = format!("^{kept_tip}");
        let listed = after.then(|| git(root, &["rev-list", "--parents", tip, &since, "--"]).output().ok()).flatten();
        let Some(listed) = listed.filter(|listed| listed.status.success()) else { return Index::build(root, tip) };
        // Each line is a commit and its parents: one parent apiece is a line.
        let merges = listed.stdout.split(|byte| *byte == b'\n').any(|line| line.iter().filter(|byte| **byte == b' ').count() > 1);
        if merges {
            return Index::build(root, tip);
        }
        let total = memchr::memchr_iter(b'\n', &listed.stdout).count();
        if total >= ON_ITS_OWN || kept.width != tip.len() / 2 {
            return Index::build(root, tip);
        }
        let new = Segment::read(root, &["log", FORMAT, tip, &since, "--"], None, kept.width, total)?;
        if new.len() != total {
            return Err("Git read another history than it listed.".into());
        }
        let segments = std::iter::once(Arc::new(new)).chain(kept.segments.iter().cloned()).collect();
        Ok(Index::of(segments, kept.width, short_length(root, tip)))
    }

    pub fn len(&self) -> usize {
        self.count
    }

    /// The segment holding commit `at`, and where in it.
    fn locate(&self, at: usize) -> (&Segment, usize) {
        let which = self.firsts.partition_point(|first| *first <= at) - 1;
        (&self.segments[which], at - self.firsts[which])
    }

    fn id(&self, at: usize) -> &[u8] {
        let (segment, at) = self.locate(at);
        &segment.ids[at * self.width..(at + 1) * self.width]
    }

    fn commit(&self, at: usize, now: u64) -> Commit {
        let id: String = self.id(at).iter().map(|byte| format!("{byte:02x}")).collect();
        let (segment, local) = self.locate(at);
        let record = segment.text(local);
        let record = record.strip_suffix(b"\n").unwrap_or(&record);
        let nul = memchr::memchr(0, record).unwrap_or(record.len());
        commit(&id, self.short, segment.times[local], &record[..nul], record.get(nul + 1..).unwrap_or_default(), now)
    }

    /// The commits from `from` on whose author, subject or id has every word of `query`, up to a
    /// page of them, and where the next page starts, if anything is left to examine.
    pub fn search(&self, query: &str, from: usize) -> (Vec<Commit>, Option<usize>) {
        let words: Vec<Word> = query.split_whitespace().map(Word::new).collect();
        let found = self.find(&words, from, PAGE);
        let now = now();
        (found.0.into_iter().map(|at| self.commit(at, now)).collect(), found.1)
    }

    fn find(&self, words: &[Word], from: usize, limit: usize) -> (Vec<usize>, Option<usize>) {
        let mut found = Vec::new();
        if words.is_empty() || from >= self.len() {
            return (found, None);
        }
        let matches = |at: usize| words.iter().all(|word| word.in_record(self, at));
        let full = |found: Vec<usize>, at: usize| {
            let next = Some(at + 1).filter(|next| *next < self.len());
            (found, next)
        };
        // The longest word that could only be in the text leads: its hits are the only candidates,
        // and the scan for it is one pass over memory. Ids are short words, checked per commit.
        let lead = words.iter().filter(|word| word.leads()).max_by_key(|word| word.bytes.len());
        let Some(lead) = lead else {
            for at in from..self.len() {
                if matches(at) {
                    found.push(at);
                    if found.len() == limit {
                        return full(found, at);
                    }
                }
            }
            return (found, None);
        };
        let (_, mut local) = self.locate(from);
        let shown = self.segments.iter().zip(&self.firsts);
        for (segment, &first) in shown.skip_while(|(segment, first)| *first + segment.len() <= from) {
            let mut offset = segment.starts[local] as usize;
            while let Some(hit) = lead.finder.find(&segment.lower[offset..]) {
                let hit = offset + hit;
                // The commit whose text holds it.
                let at = segment.starts.partition_point(|start| (*start as usize) <= hit) - 1;
                if matches(first + at) {
                    found.push(first + at);
                    if found.len() == limit {
                        return full(found, first + at);
                    }
                }
                offset = segment.starts[at + 1] as usize;
            }
            local = 0;
        }
        (found, None)
    }
}

/// A word of a search: capitals in it match only capitals; one of hex digits may also start an id.
struct Word {
    /// The word lowercased, as the text it is looked for in is.
    bytes: Vec<u8>,
    /// The word as typed, when it has capitals, which must be in the text too.
    written: Option<Vec<u8>>,
    /// The word lowercased beyond ASCII, when it has other letters: the text has only its ASCII
    /// lowercased, so such a word is matched against each commit's text lowercased whole.
    folded: Option<String>,
    hex: bool,
    finder: memmem::Finder<'static>,
}

impl Word {
    fn new(word: &str) -> Word {
        let written = word.chars().any(char::is_uppercase).then(|| word.as_bytes().to_vec());
        let bytes = word.as_bytes().to_ascii_lowercase();
        let hex = bytes.len() >= 4 && bytes.iter().all(u8::is_ascii_hexdigit);
        let finder = memmem::Finder::new(&bytes).into_owned();
        let folded = (written.is_none() && !word.is_ascii()).then(|| word.to_lowercase());
        Word { bytes, written, folded, hex, finder }
    }

    /// Whether the scan for it can lead a search: one pass over the lowercased text finds it.
    fn leads(&self) -> bool {
        !self.hex && self.folded.is_none()
    }

    fn in_record(&self, index: &Index, at: usize) -> bool {
        if self.hex && self.starts_id(index.id(at)) {
            return true;
        }
        let (segment, at) = index.locate(at);
        if let Some(folded) = &self.folded {
            return String::from_utf8_lossy(&segment.text(at)).to_lowercase().contains(folded.as_str());
        }
        let (start, end) = segment.span(at);
        let mut hits = self.finder.find_iter(&segment.lower[start..end]);
        match &self.written {
            None => hits.next().is_some(),
            Some(written) => hits.any(|hit| segment.written(start + hit, written)),
        }
    }

    fn starts_id(&self, id: &[u8]) -> bool {
        self.bytes.len() <= id.len() * 2
            && self.bytes.iter().enumerate().all(|(at, digit)| {
                let byte = id[at / 2];
                let nibble = if at % 2 == 0 { byte >> 4 } else { byte & 0xf };
                hex_value(*digit) == nibble
            })
    }
}

/// The index of one HEAD's history, read once however many ask for it at the same time.
pub struct Shared {
    /// HEAD, and the shallow boundary: deepening a shallow clone adds history without moving HEAD.
    tip: String,
    ready: tokio::sync::watch::Receiver<Option<std::result::Result<Arc<Index>, String>>>,
}

/// How many HEADs' indexes are kept: the current one, and the one before for a search still paging
/// through it. They share most of their memory.
const KEPT: usize = 2;

/// Where a shallow clone's history stops, as a short fingerprint; empty for a whole history.
fn shallow(root: &Path) -> String {
    let path = git(root, &["rev-parse", "--path-format=absolute", "--git-path", "shallow"]).output().ok();
    let path = path.and_then(|output| String::from_utf8(output.stdout).ok()).map(|path| path.trim().to_string());
    match path.and_then(|path| std::fs::read(path).ok()) {
        Some(boundary) => {
            use sha2::{Digest, Sha256};
            Sha256::digest(&boundary).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
        }
        None => String::new(),
    }
}

/// How long reading a history may take before a search gives up on it.
const READ_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// The index for `tip`: one kept for it, else one read now, built on the newest finished one of
/// the same shallow boundary.
pub async fn index(kept: &std::sync::Mutex<Vec<Shared>>, root: &Path, tip: &str) -> Result<Arc<Index>> {
    let boundary = {
        let root = root.to_path_buf();
        tokio::task::spawn_blocking(move || shallow(&root)).await.unwrap_or_default()
    };
    let key = format!("{tip} {boundary}");
    let mut ready = {
        let mut kept = kept.lock().unwrap();
        match kept.iter().position(|shared| shared.tip == key) {
            Some(at) => {
                let shared = kept.remove(at);
                let ready = shared.ready.clone();
                kept.insert(0, shared);
                ready
            }
            None => {
                let earlier = kept.iter().find_map(|shared| {
                    let (earlier, earlier_boundary) = shared.tip.split_once(' ')?;
                    match &*shared.ready.borrow() {
                        Some(Ok(index)) if earlier_boundary == boundary => Some((index.clone(), earlier.to_string())),
                        _ => None,
                    }
                });
                let (send, ready) = tokio::sync::watch::channel(None);
                let (root, owned) = (root.to_path_buf(), tip.to_string());
                // On its own, so a page that stops waiting does not stop the read for the next one.
                tokio::spawn(async move {
                    let built = tokio::task::spawn_blocking(move || {
                        match earlier {
                            Some((index, earlier)) => Index::build_on(&root, &index, &earlier, &owned),
                            None => Index::build(&root, &owned),
                        }
                        .map(Arc::new)
                    })
                    .await;
                    let _ = send.send(Some(built.unwrap_or_else(|error| Err(error.to_string()))));
                });
                kept.insert(0, Shared { tip: key, ready: ready.clone() });
                kept.truncate(KEPT);
                ready
            }
        }
    };
    // A Git that hangs (a network filesystem) fails the search; the read is left to end on its own.
    let done = tokio::time::timeout(READ_LIMIT, ready.wait_for(Option::is_some))
        .await
        .map_err(|_| "Reading the history took too long.".to_string())?
        .map_err(|_| "The history could not be read.".to_string())?
        .clone();
    done.unwrap_or_else(|| Err("The history could not be read.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(records: &[(&str, &str, &str)]) -> Index {
        let mut segment = Segment { starts: vec![0], ..Segment::default() };
        for (id, author, subject) in records {
            let id = format!("{id:0<40}");
            segment
                .ids
                .extend(id.as_bytes().as_chunks::<2>().0.iter().map(|[high, low]| hex_value(*high) << 4 | hex_value(*low)));
            segment.times.push(0);
            segment.lower.extend(format!("{author}\0{subject}\n").bytes());
            segment.starts.push(segment.lower.len() as u32);
        }
        // Split in two, as a parallel read would leave it, to search across the seam.
        let half = records.len() / 2;
        let cut = segment.starts[half] as usize;
        let second = Segment {
            ids: segment.ids.split_off(half * 20),
            times: segment.times.split_off(half),
            lower: segment.lower.split_off(cut),
            starts: segment.starts[half..].iter().map(|start| start - cut as u32).collect(),
            capitals: Vec::new(),
        };
        segment.starts.truncate(half + 1);
        let mut second = second;
        segment.fold();
        second.fold();
        Index::of(vec![Arc::new(segment), Arc::new(second)], 20, 7)
    }

    #[test]
    fn every_word_is_in_the_author_subject_or_id_and_capitals_match_capitals() {
        let three = index(&[
            ("aaaa1", "Nikita Popov", "[SCEV] Use loop guards"),
            ("bbbb2", "phongndo", "[SCEV] Conditions on switch edges as loop guards"),
            ("cccc3", "Florian Hahn", "[LV] Vectorize switch"),
        ]);
        let found = |query: &str| {
            let words: Vec<Word> = query.split_whitespace().map(Word::new).collect();
            three.find(&words, 0, 10).0
        };
        assert_eq!(found("loop guards"), [0, 1]);
        assert_eq!(found("guards loop"), [0, 1]);
        assert_eq!(found("vectorize"), [2]);
        assert_eq!(found("Vectorize"), [2]);
        assert_eq!(found("VECTORIZE"), Vec::<usize>::new());
        assert_eq!(found("Nikita"), [0]);
        // Letters beyond ASCII: lowercase finds either case, capitals only capitals.
        let accented = index(&[("dddd4", "Émilie Ørsted", "Fix ÉCOLE"), ("eeee5", "émilie", "fix école")]);
        let find = |query: &str| {
            let words: Vec<Word> = query.split_whitespace().map(Word::new).collect();
            accented.find(&words, 0, 10).0
        };
        assert_eq!(find("émilie"), [0, 1]);
        assert_eq!(find("école fix"), [0, 1]);
        assert_eq!(find("Émilie"), [0]);
        assert_eq!(find("ørsted"), [0]);
        // The text comes back as written, from its lowercase and its capitals.
        let commit = three.commit(2, 0);
        assert_eq!((commit.author.as_str(), commit.subject.as_str()), ("Florian Hahn", "[LV] Vectorize switch"));
        assert_eq!(three.commit(0, 0).sha, format!("{:0<40}", "aaaa1"));
        assert_eq!(found("switch phong"), [1]);
        assert_eq!(found("SCEV"), [0, 1]);
        assert_eq!(found("Scev"), Vec::<usize>::new());
        assert_eq!(found("bbbb"), [1]);
        assert_eq!(found("cccc3 vectorize"), [2]);
        assert_eq!(found("nothing"), Vec::<usize>::new());
    }

    #[test]
    fn a_page_resumes_after_the_last_commit_examined() {
        let records: Vec<(String, &str, String)> = (0..25)
            .map(|at| (format!("{at:x}"), "ann", format!("change {}", if at % 2 == 0 { "even" } else { "odd" })))
            .collect();
        let records: Vec<(&str, &str, &str)> =
            records.iter().map(|(id, author, subject)| (&id[..], *author, &subject[..])).collect();
        let index = index(&records);
        let words = [Word::new("even")];
        let (first, next) = index.find(&words, 0, 5);
        assert_eq!(first, [0, 2, 4, 6, 8]);
        let (second, next) = index.find(&words, next.unwrap(), 5);
        assert_eq!(second, [10, 12, 14, 16, 18]);
        let (third, next) = index.find(&words, next.unwrap(), 5);
        assert_eq!(third, [20, 22, 24]);
        assert_eq!(next, None);
    }

    /// Every commit of an index, in its order.
    fn ids(index: &Index) -> Vec<String> {
        (0..index.len()).map(|at| index.commit(at, 0).sha).collect()
    }

    #[test]
    fn built_on_an_earlier_index_is_what_a_fresh_read_finds_after_a_line_of_commits_or_a_merge() {
        let dir = std::env::temp_dir().join(format!("patch-history-{}", crate::random_token(8)));
        std::fs::create_dir(&dir).unwrap();
        let run = |args: &[&str], date: u64| {
            let date = format!("{} +0000", 1_700_000_000 + date);
            let status = Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false"])
                .args(args)
                .current_dir(&dir)
                .env("GIT_AUTHOR_DATE", &date)
                .env("GIT_COMMITTER_DATE", &date)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .stdout(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        let commit = |message: &str, date: u64| run(&["commit", "-q", "--allow-empty", "-m", message], date);
        let tip = || head(&dir).unwrap();
        run(&["init", "-q", "-b", "main"], 0);
        for n in 0..5 {
            commit(&format!("main {n}"), 1000 + n * 100);
        }
        // A side branch whose commits fall between main's in time.
        run(&["switch", "-q", "-c", "side", "main~3"], 0);
        commit("side a", 1250);
        commit("side b", 1350);
        run(&["switch", "-q", "main"], 0);
        let first = tip();
        let kept = Index::build(&dir, &first).unwrap();
        // A line of commits: built on, in git log's order.
        commit("main 5", 2000);
        commit("main 6", 2100);
        let line = tip();
        let on = Index::build_on(&dir, &kept, &first, &line).unwrap();
        assert_eq!(ids(&on), ids(&Index::build(&dir, &line).unwrap()));
        assert_eq!(on.segments.len(), kept.segments.len() + 1);
        // A merge weaves the side branch's commits in among main's: read again, in the same order.
        run(&["merge", "-q", "--no-ff", "-m", "merge side", "side"], 2200);
        let merged = tip();
        let on = Index::build_on(&dir, &kept, &first, &merged).unwrap();
        let fresh = Index::build(&dir, &merged).unwrap();
        assert_eq!(ids(&on), ids(&fresh));
        let subjects: Vec<String> = (0..fresh.len()).map(|at| fresh.commit(at, 0).subject).collect();
        // The side branch's commits are among main's older ones, by their time: not before them.
        assert_eq!(&subjects[..6], ["merge side", "main 6", "main 5", "main 4", "side b", "main 3"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn times_read_as_git_says_them() {
        let now = 1_000_000_000;
        assert_eq!(relative(now, now - 1), "1 second ago");
        assert_eq!(relative(now, now - 600), "10 minutes ago");
        assert_eq!(relative(now, now - 3 * 3600), "3 hours ago");
        assert_eq!(relative(now, now - 3 * 86400), "3 days ago");
        assert_eq!(relative(now, now - 30 * 86400), "4 weeks ago");
        assert_eq!(relative(now, now - 200 * 86400), "7 months ago");
        assert_eq!(relative(now, now - 400 * 86400), "1 year, 1 month ago");
        assert_eq!(relative(now, now - 3000 * 86400), "8 years ago");
        assert_eq!(relative(now, now + 5), "in the future");
    }
}

#[cfg(test)]
mod bench {
    #[test]
    #[ignore]
    fn build_time() {
        let root = std::path::PathBuf::from(std::env::var("BENCH_REPO").unwrap());
        let tip = super::head(&root).unwrap();
        let started = std::time::Instant::now();
        let index = super::Index::build(&root, &tip).unwrap();
        eprintln!("built {} commits in {:?}", index.len(), started.elapsed());
        // Built on an index of five commits back: the same history, read in a fraction.
        let earlier = super::git(&root, &["rev-parse", "HEAD~5"]).output().unwrap().stdout;
        let earlier = String::from_utf8(earlier).unwrap().trim().to_string();
        let kept = super::Index::build(&root, &earlier).unwrap();
        let started = std::time::Instant::now();
        let on = super::Index::build_on(&root, &kept, &earlier, &tip).unwrap();
        eprintln!("built on an earlier index in {:?}", started.elapsed());
        assert_eq!(on.len(), index.len());
        for at in [0, 1, 4, 5, 6, 1000, index.len() - 1] {
            assert_eq!(on.commit(at, 0).sha, index.commit(at, 0).sha);
            assert_eq!(on.commit(at, 0).subject, index.commit(at, 0).subject);
        }
    }
}

const std = @import("std");

pub const max_patch_bytes = 64 * 1024 * 1024;
pub const Mode = enum { working, staged, branch };
/// `default` leaves the choice to Git (its `diff.algorithm`, else Myers).
pub const Algorithm = enum { default, histogram, patience };
pub const Options = struct {
    ignore_whitespace: bool = false,
    algorithm: Algorithm = .default,
    /// Where to write the attributes Patch diffs with: Git's function-header
    /// drivers for C-family, Rust, Zig and others, then the person's own
    /// global attributes, which override them (as a repository's own
    /// .gitattributes overrides both). Empty leaves attributes to Git.
    attributes: []const u8 = "",
    /// Full blob ids in `index` lines, which saved reviews are keyed by (Git
    /// abbreviates them unless a file is binary). Off only to read a
    /// comparison as Patch once did, to find progress saved under it.
    full_index: bool = true,
    /// In branch mode, one commit to review on its own; empty for them all.
    commit: []const u8 = "",
    /// An objects directory of Patch's own (absolute) where Git can keep
    /// the objects it makes while diffing a merge, so it never writes them
    /// into the repository; empty lets Git use the repository's.
    scratch: []const u8 = "",
};
pub const Review = struct {
    patch: []const u8,
    /// The comparison as Git shows it by default, when `patch` hides changes
    /// (ignoring whitespace drops whole files); empty means `patch` itself.
    /// Saved progress is keyed to it, so view options never lose a review.
    identity: []const u8 = "",
    /// The repository's top level, for questions asked after parsing.
    root: []const u8 = "",
    repository: []const u8,
    branch: []const u8,
    base: []const u8,
    /// The checked-out branch ("HEAD" when detached), whatever the mode.
    head: []const u8 = "",
    /// Local and remote-tracking branches, newest commit first, one per line.
    branches: []const u8 = "",
    title: []const u8,
    kind: []const u8 = "git",
    mode: ?[]const u8 = null,
    /// The repository's objects directory, absolute.
    objects: []const u8 = "",
    /// Branch mode: the commits under review, oldest first, and the commits
    /// the range runs between.
    commits: []const Commit = &.{},
    merge_base: []const u8 = "",
    tip: []const u8 = "",
};
pub const RawFile = struct { path: []const u8, old: []const u8, new: []const u8, mode: []const u8 };
pub const Commit = struct {
    id: []const u8,
    /// Parent ids, separated by spaces.
    parents: []const u8,
    author: []const u8,
    time: i64,
    message: []const u8,
    /// What it changes, as blob ids (none for a merge).
    files: []const RawFile = &.{},
    pub fn subject(self: Commit) []const u8 {
        const end = std.mem.indexOfScalar(u8, self.message, '\n') orelse self.message.len;
        return std.mem.trimEnd(u8, self.message[0..end], " \r");
    }
    pub fn merge(self: Commit) bool {
        return std.mem.indexOfScalar(u8, self.parents, ' ') != null;
    }
};
/// The app's environment, which Git runs in when Patch adds to it.
pub var environ: ?*const std.process.Environ.Map = null;
/// Patch's own objects for one repository: every version of a file it has
/// shown, so a later review can diff against what was reviewed. Git writes
/// there seeing only the store (with the repository's objects as
/// alternates it would find an object there and touch the repository's
/// copy) and reads with the repository's objects behind the store's.
pub const Store = struct {
    /// The store's objects directory, absolute; temporary files go beside it.
    objects: []const u8,
    /// The repository's objects directory, absolute.
    repository: []const u8,
    /// Whether the store holds an object, loose as Patch writes them.
    pub fn has(self: Store, io: std.Io, id: []const u8) bool {
        if (id.len < 4) return false;
        var buffer: [4096]u8 = undefined;
        const path = std.fmt.bufPrint(&buffer, "{s}/{s}/{s}", .{ self.objects, id[0..2], id[2..] }) catch return false;
        std.Io.Dir.cwd().access(io, path, .{}) catch return false;
        return true;
    }
};

const flags = &.{ "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--unified=5" };

fn command(gpa: std.mem.Allocator, io: std.Io, cwd: []const u8, args: []const []const u8, difference: bool) ![]u8 {
    return exec(gpa, io, cwd, args, .{ .difference = difference });
}
const Run = struct {
    /// Exit status 1 means "there are differences", not failure.
    difference: bool = false,
    /// Run against a store: writing sees only the store; reading sees the
    /// repository's objects behind it.
    store: ?Store = null,
    writes: bool = false,
    /// A temporary index, for building trees.
    index: []const u8 = "",
    /// Standard input, passed through a temporary file beside the store.
    input: ?[]const u8 = null,
};
var temporary_count = std.atomic.Value(u32).init(0);
/// A path for a temporary file beside the store's objects.
fn temporary(gpa: std.mem.Allocator, io: std.Io, store: Store, tag: []const u8) ![]u8 {
    const count = temporary_count.fetchAdd(1, .monotonic);
    const now = std.Io.Clock.real.now(io).nanoseconds;
    return std.fmt.allocPrint(gpa, "{s}/../{s}-{d}-{d}", .{ store.objects, tag, now, count });
}
fn exec(gpa: std.mem.Allocator, io: std.Io, cwd: []const u8, args: []const []const u8, options: Run) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(gpa);
    try argv.appendSlice(gpa, &.{ "git", "--no-optional-locks", "-c", "core.quotepath=false" });
    try argv.appendSlice(gpa, args);
    var map: ?std.process.Environ.Map = null;
    defer if (map) |*value| value.deinit();
    if (options.store != null or options.index.len > 0) {
        var value = if (environ) |base| try base.clone(gpa) else std.process.Environ.Map.init(gpa);
        errdefer value.deinit();
        if (options.store) |store| {
            try value.put("GIT_OBJECT_DIRECTORY", store.objects);
            if (options.writes) _ = value.swapRemove("GIT_ALTERNATE_OBJECT_DIRECTORIES") else try value.put("GIT_ALTERNATE_OBJECT_DIRECTORIES", store.repository);
        }
        if (options.index.len > 0) try value.put("GIT_INDEX_FILE", options.index);
        map = value;
    }
    var input_path: ?[]u8 = null;
    var input: ?std.Io.File = null;
    defer {
        if (input) |file| file.close(io);
        if (input_path) |path| {
            std.Io.Dir.cwd().deleteFile(io, path) catch {};
            gpa.free(path);
        }
    }
    if (options.input) |bytes| {
        input_path = try temporary(gpa, io, options.store orelse return error.GitCommandFailed, "input");
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = input_path.?, .data = bytes });
        input = try std.Io.Dir.cwd().openFile(io, input_path.?, .{});
    }
    var child = try std.process.spawn(io, .{
        .argv = argv.items,
        .cwd = .{ .path = cwd },
        .environ_map = if (map) |*value| value else null,
        .expand_arg0 = .expand,
        .stdin = if (input) |file| .{ .file = file } else .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
    });
    defer child.kill(io);
    var buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
    var reader: std.Io.File.MultiReader = undefined;
    reader.init(gpa, io, buffer.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer reader.deinit();
    while (reader.fill(64, .none)) |_| {
        if (reader.reader(0).buffered().len > max_patch_bytes) return error.StreamTooLong;
        if (reader.reader(1).buffered().len > 64 * 1024) return error.StreamTooLong;
    } else |err| switch (err) {
        error.EndOfStream => {},
        else => |e| return e,
    }
    try reader.checkAnyError();
    const term = try child.wait(io);
    const stdout = try reader.toOwnedSlice(0);
    switch (term) {
        .exited => |code| if (code == 0 or (options.difference and code == 1)) return stdout,
        else => {},
    }
    gpa.free(stdout);
    return error.GitCommandFailed;
}

/// Configuration and flags for one kind of diff: `config` goes before the
/// subcommand, `view` after Patch's fixed flags.
const Style = struct { config: []const []const u8 = &.{}, view: []const []const u8 = &.{} };
fn diff(gpa: std.mem.Allocator, io: std.Io, root: []const u8, style: Style, before: []const []const u8, after: []const []const u8, difference: bool) ![]u8 {
    return diffWith(gpa, io, root, style, "diff", before, after, .{ .difference = difference });
}
fn diffWith(gpa: std.mem.Allocator, io: std.Io, root: []const u8, style: Style, subcommand: []const u8, before: []const []const u8, after: []const []const u8, run: Run) ![]u8 {
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    try args.appendSlice(gpa, style.config);
    try args.append(gpa, subcommand);
    try args.appendSlice(gpa, before);
    try args.appendSlice(gpa, flags);
    try args.appendSlice(gpa, style.view);
    try args.appendSlice(gpa, after);
    return exec(gpa, io, root, args.items, run);
}

/// Hunk headers name the enclosing function through Git's diff drivers, but
/// only for paths whose attributes choose one. Without them Git takes the last
/// unindented line, which in C is often a goto label and in C++ an access
/// specifier, and in Rust or Zig the impl or struct around the method.
const default_attributes =
    \\*.c diff=cpp
    \\*.h diff=cpp
    \\*.cc diff=cpp
    \\*.cpp diff=cpp
    \\*.cxx diff=cpp
    \\*.c++ diff=cpp
    \\*.hh diff=cpp
    \\*.hpp diff=cpp
    \\*.hxx diff=cpp
    \\*.h++ diff=cpp
    \\*.inl diff=cpp
    \\*.ipp diff=cpp
    \\*.tpp diff=cpp
    \\*.cu diff=cpp
    \\*.cuh diff=cpp
    \\*.m diff=objc
    \\*.mm diff=objc
    \\*.rs diff=rust
    \\*.go diff=golang
    \\*.py diff=python
    \\*.pyi diff=python
    \\*.java diff=java
    \\*.kt diff=kotlin
    \\*.kts diff=kotlin
    \\*.cs diff=csharp
    \\*.sh diff=bash
    \\*.bash diff=bash
    \\*.css diff=css
    \\*.html diff=html
    \\*.htm diff=html
    \\*.md diff=markdown
    \\*.dts diff=dts
    \\*.dtsi diff=dts
    \\*.f diff=fortran
    \\*.f90 diff=fortran
    \\*.f95 diff=fortran
    \\*.f03 diff=fortran
    \\*.f08 diff=fortran
    \\*.rb diff=ruby
    \\*.php diff=php
    \\*.pl diff=perl
    \\*.pm diff=perl
    \\*.ex diff=elixir
    \\*.exs diff=elixir
    \\*.tex diff=tex
    \\*.zig diff=patch-zig
    \\
;
/// Git has no Zig driver; this one names functions (methods too, being
/// indented), tests, and container declarations. Its name is Patch's own so it
/// never replaces a driver the person configured.
const zig_funcname = "diff.patch-zig.xfuncname=^[ \t]*((pub[ \t]+)?((export|extern|inline|noinline)[ \t]+)*fn[ \t]+[A-Za-z_@].*|test[ \t].*|(pub[ \t]+)?(const|var)[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*(:[^=]*)?=[ \t]*((extern|packed)[ \t]+)?(struct|enum|union|opaque)([^A-Za-z0-9_].*)?)$";

/// Writes Patch's attributes to `path`, followed by the person's global
/// attributes file (`git var` resolves core.attributesFile and its XDG default).
fn writeAttributes(gpa: std.mem.Allocator, io: std.Io, root: []const u8, path: []const u8) !void {
    var contents: std.ArrayList(u8) = .empty;
    defer contents.deinit(gpa);
    try contents.appendSlice(gpa, default_attributes);
    if (command(gpa, io, root, &.{ "var", "GIT_ATTR_GLOBAL" }, false)) |raw| {
        defer gpa.free(raw);
        const global = std.mem.trimEnd(u8, raw, "\r\n");
        if (global.len > 0) if (std.Io.Dir.cwd().readFileAlloc(io, global, gpa, .limited(1024 * 1024))) |bytes| {
            defer gpa.free(bytes);
            try contents.append(gpa, '\n');
            try contents.appendSlice(gpa, bytes);
        } else |_| {};
    } else |_| {}
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents.items });
}

/// Fills `out` with whether each path is marked `linguist-generated`: true
/// or false where an attribute says so, null where none does. Paths go to
/// Git in batches, each answered in order.
pub fn generated(gpa: std.mem.Allocator, io: std.Io, root: []const u8, paths: []const []const u8, out: []?bool) void {
    @memset(out, null);
    var start: usize = 0;
    while (start < paths.len) {
        const end = @min(paths.len, start + 256);
        defer start = end;
        var args: std.ArrayList([]const u8) = .empty;
        defer args.deinit(gpa);
        args.appendSlice(gpa, &.{ "check-attr", "-z", "linguist-generated", "--" }) catch return;
        args.appendSlice(gpa, paths[start..end]) catch return;
        const output = command(gpa, io, root, args.items, false) catch return;
        defer gpa.free(output);
        parseGenerated(output, paths[start..end], out[start..end]);
    }
}
/// `git check-attr -z` answers each path with path, attribute and value,
/// every field ending in NUL.
fn parseGenerated(output: []const u8, paths: []const []const u8, out: []?bool) void {
    var fields = std.mem.splitScalar(u8, output, 0);
    var index: usize = 0;
    while (index < paths.len) : (index += 1) {
        const path = fields.next() orelse return;
        _ = fields.next() orelse return;
        const value = fields.next() orelse return;
        if (!std.mem.eql(u8, path, paths[index])) return;
        out[index] = if (std.mem.eql(u8, value, "set") or std.mem.eql(u8, value, "true")) true else if (std.mem.eql(u8, value, "unset") or std.mem.eql(u8, value, "false")) false else null;
    }
}

const NewFile = struct {
    io: std.Io,
    root: []const u8,
    path: []const u8,
    full_index: bool,
    output: ?[]u8 = null,
    failure: ?anyerror = null,
    fn run(self: *NewFile) void {
        const style = Style{ .view = if (self.full_index) &.{"--full-index"} else &.{} };
        self.output = diff(std.heap.page_allocator, self.io, self.root, style, &.{"--no-index"}, &.{ "--", "/dev/null", self.path }, true) catch |err| {
            self.failure = err;
            return;
        };
    }
};

/// Branch names, most recently committed first: local branches as `name`,
/// remote-tracking ones as `remote/name`, without the remotes' HEAD aliases.
fn branchList(gpa: std.mem.Allocator, io: std.Io, root: []const u8) []const u8 {
    const raw = command(gpa, io, root, &.{ "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes" }, false) catch return "";
    var out: std.ArrayList(u8) = .empty;
    var lines = std.mem.tokenizeAny(u8, raw, "\r\n");
    while (lines.next()) |ref| {
        const name = if (std.mem.startsWith(u8, ref, "refs/heads/")) ref["refs/heads/".len..] else if (std.mem.startsWith(u8, ref, "refs/remotes/")) ref["refs/remotes/".len..] else continue;
        if (std.mem.endsWith(u8, name, "/HEAD")) continue;
        if (out.items.len > 0) out.append(gpa, '\n') catch return out.items;
        out.appendSlice(gpa, name) catch return out.items;
    }
    return out.items;
}

/// Git's config and flags for diffs under these options. The attributes
/// file must already be written (`read` writes it).
fn styles(gpa: std.mem.Allocator, options: Options, attributes: bool) !struct { shown: Style, keyed: ?Style } {
    var config: std.ArrayList([]const u8) = .empty;
    if (attributes and options.attributes.len > 0) try config.appendSlice(gpa, &.{ "-c", try std.fmt.allocPrint(gpa, "core.attributesFile={s}", .{options.attributes}), "-c", zig_funcname });
    var view: std.ArrayList([]const u8) = .empty;
    if (options.full_index) try view.append(gpa, "--full-index");
    if (options.ignore_whitespace) try view.append(gpa, "--ignore-all-space");
    switch (options.algorithm) {
        .default => {},
        .histogram => try view.append(gpa, "--histogram"),
        .patience => try view.append(gpa, "--patience"),
    }
    // Ignoring whitespace drops files whose only changes are whitespace, so
    // the default diff also runs to list those files.
    return .{ .shown = .{ .config = config.items, .view = view.items }, .keyed = if (options.ignore_whitespace) .{ .config = config.items, .view = view.items[0..@intFromBool(options.full_index)] } else null };
}

const empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// `head_ref` names the branch to review against `base` in branch mode; empty
/// means the checked-out HEAD.
pub fn read(gpa: std.mem.Allocator, io: std.Io, path: []const u8, mode: Mode, base: []const u8, head_ref: []const u8, options: Options) !Review {
    const located = command(gpa, io, path, &.{ "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-path", "objects" }, false) catch return error.InvalidRepository;
    var located_lines = std.mem.tokenizeAny(u8, located, "\r\n");
    const root = located_lines.next() orelse return error.InvalidRepository;
    const objects = located_lines.next() orelse "";
    const branch_raw = try command(gpa, io, root, &.{ "branch", "--show-current" }, false);
    const branch_name = std.mem.trimEnd(u8, branch_raw, "\r\n");
    const branch = if (branch_name.len == 0) "detached HEAD" else branch_name;
    const head_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "HEAD" }, false) catch null;
    const head = if (head_raw) |bytes| std.mem.trimEnd(u8, bytes, "\r\n") else empty_tree;
    // Without the attributes file, hunk headers fall back to Git's defaults.
    const attributes = options.attributes.len > 0 and if (writeAttributes(gpa, io, root, options.attributes)) true else |_| false;
    const style = try styles(gpa, options, attributes);
    const shown = style.shown;
    const keyed = style.keyed;
    var patch: []const u8 = undefined;
    var identity: []const u8 = "";
    var commits: []const Commit = &.{};
    var merge_base: []const u8 = "";
    var tip: []const u8 = "";
    switch (mode) {
        .branch => {
            if (head_raw == null) return error.NoInitialCommit;
            const reference = try std.fmt.allocPrint(gpa, "{s}^{{commit}}", .{base});
            const revision_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "--end-of-options", reference }, false) catch return error.InvalidBaseBranch;
            const revision = std.mem.trimEnd(u8, revision_raw, "\r\n");
            tip = if (head_ref.len > 0) blk: {
                const tip_reference = try std.fmt.allocPrint(gpa, "{s}^{{commit}}", .{head_ref});
                const tip_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "--end-of-options", tip_reference }, false) catch return error.InvalidHeadBranch;
                break :blk std.mem.trimEnd(u8, tip_raw, "\r\n");
            } else head;
            if (command(gpa, io, root, &.{ "merge-base", revision, tip }, false)) |raw| {
                merge_base = std.mem.trimEnd(u8, raw, "\r\n");
            } else |_| {}
            commits = listCommits(gpa, io, root, try std.fmt.allocPrint(gpa, "{s}..{s}", .{ revision, tip })) catch &.{};
            if (options.commit.len > 0) {
                const commit = for (commits) |commit| {
                    if (std.mem.eql(u8, commit.id, options.commit)) break commit;
                } else return error.CommitNotFound;
                if (commit.merge()) {
                    // What the merge's author changed beyond Git's own merge.
                    const scratch: ?Store = if (options.scratch.len > 0) .{ .objects = options.scratch, .repository = objects } else null;
                    const run = Run{ .store = scratch };
                    patch = try diffWith(gpa, io, root, shown, "show", &.{ "--remerge-diff", "--format=" }, &.{ commit.id, "--" }, run);
                    if (keyed) |style_keyed| identity = try diffWith(gpa, io, root, style_keyed, "show", &.{ "--remerge-diff", "--format=" }, &.{ commit.id, "--" }, run);
                } else {
                    const parent = if (commit.parents.len > 0) commit.parents else empty_tree;
                    patch = try diff(gpa, io, root, shown, &.{}, &.{ parent, commit.id, "--" }, false);
                    if (keyed) |style_keyed| identity = try diff(gpa, io, root, style_keyed, &.{}, &.{ parent, commit.id, "--" }, false);
                }
            } else {
                const range = try std.fmt.allocPrint(gpa, "{s}...{s}", .{ revision, tip });
                patch = try diff(gpa, io, root, shown, &.{}, &.{ range, "--" }, false);
                if (keyed) |style_keyed| identity = try diff(gpa, io, root, style_keyed, &.{}, &.{ range, "--" }, false);
            }
        },
        .staged => {
            patch = try diff(gpa, io, root, shown, &.{"--cached"}, &.{ head, "--" }, false);
            if (keyed) |style_keyed| identity = try diff(gpa, io, root, style_keyed, &.{"--cached"}, &.{ head, "--" }, false);
        },
        .working => {
            const tracked = try diff(gpa, io, root, shown, &.{}, &.{ head, "--" }, false);
            const untracked = try command(gpa, io, root, &.{ "ls-files", "--others", "--exclude-standard", "-z" }, false);
            var output: std.ArrayList(u8) = .empty;
            try output.appendSlice(gpa, tracked);
            // New files are all additions, so whitespace never hides them.
            var keyed_output: std.ArrayList(u8) = .empty;
            if (keyed) |style_keyed| try keyed_output.appendSlice(gpa, try diff(gpa, io, root, style_keyed, &.{}, &.{ head, "--" }, false));
            var paths = std.mem.tokenizeScalar(u8, untracked, 0);
            while (true) {
                var jobs: [4]NewFile = undefined;
                var threads: [4]?std.Thread = .{ null, null, null, null };
                var count: usize = 0;
                for (&jobs, 0..) |*job, index| {
                    const file = paths.next() orelse break;
                    job.* = .{ .io = io, .root = root, .path = file, .full_index = options.full_index };
                    threads[index] = std.Thread.spawn(.{}, NewFile.run, .{job}) catch null;
                    if (threads[index] == null) job.run();
                    count += 1;
                }
                if (count == 0) break;
                for (threads[0..count]) |thread| if (thread) |value| value.join();
                defer for (jobs[0..count]) |job| if (job.output) |bytes| std.heap.page_allocator.free(bytes);
                for (jobs[0..count]) |job| {
                    if (job.failure) |err| return err;
                    const bytes = job.output.?;
                    if (output.items.len + bytes.len > max_patch_bytes) return error.PatchTooLarge;
                    try output.appendSlice(gpa, bytes);
                    if (keyed != null) try keyed_output.appendSlice(gpa, bytes);
                }
            }
            patch = output.items;
            if (keyed != null) identity = keyed_output.items;
        },
    }
    return .{
        .patch = patch,
        .identity = identity,
        .root = root,
        .objects = objects,
        .commits = commits,
        .merge_base = merge_base,
        .tip = tip,
        .repository = std.fs.path.basename(root),
        .branch = switch (mode) {
            .working => "working tree",
            .staged => "index",
            .branch => branch,
        },
        .base = if (mode == .branch) base else branch,
        .head = if (branch_name.len == 0) "HEAD" else branch_name,
        .branches = branchList(gpa, io, root),
        .title = switch (mode) {
            .working => "Working changes",
            .staged => "Staged changes",
            .branch => "Branch changes",
        },
        .mode = @tagName(mode),
    };
}

/// The commits in `range`, oldest first (at most 500, the newest), each with
/// the files it changes. Merges list no files.
pub fn listCommits(gpa: std.mem.Allocator, io: std.Io, root: []const u8, range: []const u8) ![]const Commit {
    const output = try command(gpa, io, root, &.{ "log", "--reverse", "--topo-order", "--max-count=500", "-z", "--no-abbrev", "--raw", "--no-renames", "--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%B%x1f", range, "--" }, false);
    return parseCommits(gpa, output);
}
/// `git log -z --raw` with each commit's fields between unit separators:
/// a record separator, then id, parents, author, time and message, then the
/// raw entries, each `:mode mode old new status` and a path, NUL-separated.
fn parseCommits(gpa: std.mem.Allocator, output: []const u8) ![]const Commit {
    var commits: std.ArrayList(Commit) = .empty;
    var records = std.mem.splitScalar(u8, output, 0x1e);
    _ = records.next();
    while (records.next()) |record| {
        var fields = std.mem.splitScalar(u8, record, 0x1f);
        const id = fields.next() orelse continue;
        const parents = fields.next() orelse continue;
        const author = fields.next() orelse continue;
        const time = std.fmt.parseInt(i64, fields.next() orelse continue, 10) catch 0;
        const message = std.mem.trimEnd(u8, fields.next() orelse continue, "\n");
        var files: std.ArrayList(RawFile) = .empty;
        var tokens = std.mem.splitScalar(u8, fields.rest(), 0);
        while (tokens.next()) |raw_token| {
            const token = std.mem.trimStart(u8, raw_token, "\n");
            if (token.len == 0 or token[0] != ':') continue;
            const path = tokens.next() orelse break;
            var parts = std.mem.tokenizeScalar(u8, token[1..], ' ');
            _ = parts.next();
            const mode = parts.next() orelse continue;
            const old = parts.next() orelse continue;
            const new = parts.next() orelse continue;
            try files.append(gpa, .{ .path = path, .old = if (std.mem.trim(u8, old, "0").len == 0) "" else old, .new = if (std.mem.trim(u8, new, "0").len == 0) "" else new, .mode = mode });
        }
        try commits.append(gpa, .{ .id = id, .parents = parents, .author = author, .time = time, .message = message, .files = files.items });
    }
    return commits.items;
}

/// Pairs a range's commits before and after a rewrite: `same` when the
/// commit's change is unchanged.
pub const Pair = struct { old: []const u8, new: []const u8, same: bool };
pub fn rangeDiff(gpa: std.mem.Allocator, io: std.Io, root: []const u8, old_range: []const u8, new_range: []const u8) ![]const Pair {
    const output = try command(gpa, io, root, &.{ "range-diff", "--no-color", "--no-patch", "--abbrev=40", old_range, new_range }, false);
    return parsePairs(gpa, output);
}
/// `1:  <old> = 1:  <new> subject`, with `!` for a changed pair and `<`/`>`
/// for commits on one side only.
fn parsePairs(gpa: std.mem.Allocator, output: []const u8) ![]const Pair {
    var pairs: std.ArrayList(Pair) = .empty;
    var lines = std.mem.tokenizeScalar(u8, output, '\n');
    while (lines.next()) |line| {
        var parts = std.mem.tokenizeAny(u8, line, " \t");
        _ = parts.next() orelse continue;
        const old = parts.next() orelse continue;
        const relation = parts.next() orelse continue;
        _ = parts.next() orelse continue;
        const new = parts.next() orelse continue;
        if (relation.len != 1 or (relation[0] != '=' and relation[0] != '!')) continue;
        if (!hex(old) or !hex(new)) continue;
        try pairs.append(gpa, .{ .old = old, .new = new, .same = relation[0] == '=' });
    }
    return pairs.items;
}
fn hex(text: []const u8) bool {
    if (text.len < 7) return false;
    for (text) |char| if (!std.ascii.isHex(char)) return false;
    return true;
}
/// Whether the repository still has this commit.
pub fn hasCommit(gpa: std.mem.Allocator, io: std.Io, root: []const u8, id: []const u8) bool {
    const reference = std.fmt.allocPrint(gpa, "{s}^{{commit}}", .{id}) catch return false;
    defer gpa.free(reference);
    const output = command(gpa, io, root, &.{ "cat-file", "-e", reference }, false) catch return false;
    gpa.free(output);
    return true;
}

/// Configuration that keeps Git from writing anything beside a temporary
/// index (a split index or a file-system monitor would).
const quiet_index = [_][]const u8{ "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false" };

/// Writes working-tree files into the store as `git add` would (clean
/// filters and line endings applied), setting `out` to their ids in order.
pub fn snapshot(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, paths: []const []const u8, out: [][]const u8) !void {
    var start: usize = 0;
    while (start < paths.len) {
        const end = @min(paths.len, start + 128);
        defer start = end;
        var args: std.ArrayList([]const u8) = .empty;
        defer args.deinit(gpa);
        try args.appendSlice(gpa, &.{ "hash-object", "-w", "--" });
        try args.appendSlice(gpa, paths[start..end]);
        const output = try exec(gpa, io, root, args.items, .{ .store = store, .writes = true });
        var lines = std.mem.tokenizeAny(u8, output, "\r\n");
        for (out[start..end]) |*id| id.* = lines.next() orelse return error.GitCommandFailed;
    }
}
/// Writes bytes into the store as a blob, returning its id.
pub fn writeBlob(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, bytes: []const u8) ![]const u8 {
    const output = try exec(gpa, io, root, &.{ "hash-object", "-w", "--no-filters", "--stdin" }, .{ .store = store, .writes = true, .input = bytes });
    return std.mem.trimEnd(u8, output, "\r\n");
}
/// Copies blobs from the repository into the store, so a later `git gc`
/// cannot take a reviewed version away. Blobs the repository lacks are skipped.
pub fn copyBlobs(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, ids: []const []const u8) !void {
    if (ids.len == 0) return;
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(gpa);
    for (ids) |id| {
        try input.appendSlice(gpa, id);
        try input.append(gpa, '\n');
    }
    const output = try exec(gpa, io, root, &.{ "cat-file", "--batch" }, .{ .store = store, .input = input.items });
    defer gpa.free(output);
    var paths: std.ArrayList([]const u8) = .empty;
    defer {
        for (paths.items) |path| {
            std.Io.Dir.cwd().deleteFile(io, path) catch {};
            gpa.free(path);
        }
        paths.deinit(gpa);
    }
    // Each answer: "<id> <type> <size>\n<bytes>\n", or "<id> missing\n".
    var at: usize = 0;
    while (at < output.len) {
        const line_end = std.mem.indexOfScalarPos(u8, output, at, '\n') orelse break;
        var header = std.mem.tokenizeScalar(u8, output[at..line_end], ' ');
        at = line_end + 1;
        _ = header.next();
        const kind = header.next() orelse continue;
        const size = std.fmt.parseInt(usize, header.next() orelse continue, 10) catch break;
        if (at + size > output.len) break;
        const bytes = output[at .. at + size];
        at += size + 1;
        if (!std.mem.eql(u8, kind, "blob")) continue;
        const path = try temporary(gpa, io, store, "blob");
        std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = bytes }) catch {
            gpa.free(path);
            continue;
        };
        try paths.append(gpa, path);
    }
    if (paths.items.len == 0) return;
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    try args.appendSlice(gpa, &.{ "hash-object", "-w", "--no-filters", "--" });
    try args.appendSlice(gpa, paths.items);
    gpa.free(try exec(gpa, io, root, args.items, .{ .store = store, .writes = true }));
}
/// The bytes of these blobs, by id, read from the store with the
/// repository's objects behind it; blobs neither has are left out. Ids are
/// asked in batches so no one answer runs past Git's output bound.
pub fn readBlobs(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, ids: []const []const u8) !std.StringHashMapUnmanaged([]const u8) {
    var result: std.StringHashMapUnmanaged([]const u8) = .empty;
    var start: usize = 0;
    while (start < ids.len) {
        const end = @min(ids.len, start + 256);
        defer start = end;
        try readBatch(gpa, io, root, store, ids[start..end], &result);
    }
    return result;
}
/// Reads one batch of blobs. A batch whose answer is too long to take is
/// halved and read again, so only a blob too large on its own is left out.
fn readBatch(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, ids: []const []const u8, result: *std.StringHashMapUnmanaged([]const u8)) !void {
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(gpa);
    for (ids) |id| if (id.len > 0) {
        try input.appendSlice(gpa, id);
        try input.append(gpa, '\n');
    };
    if (input.items.len == 0) return;
    const output = exec(gpa, io, root, &.{ "cat-file", "--batch" }, .{ .store = store, .input = input.items }) catch |err| switch (err) {
        error.StreamTooLong => {
            if (ids.len < 2) return;
            const half = ids.len / 2;
            try readBatch(gpa, io, root, store, ids[0..half], result);
            return readBatch(gpa, io, root, store, ids[half..], result);
        },
        else => return err,
    };
    var at: usize = 0;
    while (at < output.len) {
        const line_end = std.mem.indexOfScalarPos(u8, output, at, '\n') orelse break;
        var header = std.mem.tokenizeScalar(u8, output[at..line_end], ' ');
        at = line_end + 1;
        const id = header.next() orelse continue;
        const kind = header.next() orelse continue;
        const size = std.fmt.parseInt(usize, header.next() orelse continue, 10) catch break;
        if (at + size > output.len) break;
        if (std.mem.eql(u8, kind, "blob")) try result.put(gpa, id, output[at .. at + size]);
        at += size + 1;
    }
}
/// Runs a read-only Git command in the repository and returns its output.
/// Exit status 1 is an answer, not a failure (`git grep` finding nothing).
pub fn ask(gpa: std.mem.Allocator, io: std.Io, root: []const u8, args: []const []const u8) ![]u8 {
    return exec(gpa, io, root, args, .{ .difference = true });
}
/// `ask`, with bytes for the command to read on its standard input (kept
/// in a temporary file beside the store, which also answers for objects).
pub fn askWith(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, args: []const []const u8, input: []const u8) ![]u8 {
    return exec(gpa, io, root, args, .{ .difference = true, .store = store, .input = input });
}
/// Which of these objects neither the store nor the repository has.
pub fn missing(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, ids: []const []const u8) !std.StringHashMapUnmanaged(void) {
    var result: std.StringHashMapUnmanaged(void) = .empty;
    if (ids.len == 0) return result;
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(gpa);
    for (ids) |id| {
        try input.appendSlice(gpa, id);
        try input.append(gpa, '\n');
    }
    const output = try exec(gpa, io, root, &.{ "cat-file", "--batch-check" }, .{ .store = store, .input = input.items });
    var lines = std.mem.tokenizeScalar(u8, output, '\n');
    while (lines.next()) |line| if (std.mem.endsWith(u8, line, " missing")) {
        try result.put(gpa, line[0 .. line.len - " missing".len], {});
    };
    return result;
}
pub const TreeEntry = struct { mode: []const u8, id: []const u8, path: []const u8 };
/// Builds a tree in the store from blobs anywhere (a temporary index, then
/// `write-tree`), so versions diff with their paths and attributes.
pub fn tree(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, entries: []const TreeEntry) ![]const u8 {
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(gpa);
    for (entries) |entry| try input.print(gpa, "{s} {s}\t{s}\x00", .{ entry.mode, entry.id, entry.path });
    const index = try temporary(gpa, io, store, "index");
    defer {
        std.Io.Dir.cwd().deleteFile(io, index) catch {};
        gpa.free(index);
    }
    gpa.free(try exec(gpa, io, root, &(quiet_index ++ [_][]const u8{ "update-index", "-z", "--index-info" }), .{ .store = store, .writes = true, .index = index, .input = input.items }));
    const output = try exec(gpa, io, root, &(quiet_index ++ [_][]const u8{ "write-tree", "--missing-ok" }), .{ .store = store, .writes = true, .index = index });
    return std.mem.trimEnd(u8, output, "\r\n");
}
/// Diffs two trees (or subtrees, `<tree>:<path>`) from the store, as `read`
/// diffs a comparison.
pub fn diffTrees(gpa: std.mem.Allocator, io: std.Io, root: []const u8, store: Store, options: Options, a: []const u8, b: []const u8) ![]u8 {
    const style = try styles(gpa, options, options.attributes.len > 0);
    return diffWith(gpa, io, root, style.shown, "diff", &.{}, &.{ a, b, "--" }, .{ .store = store });
}

test "check-attr answers mark generated paths, explicit opt-outs, and silence" {
    const paths = [_][]const u8{ "gen/out.c", "dist/app.js", "src/main.zig", "vendor/x.c" };
    var out: [paths.len]?bool = undefined;
    @memset(&out, null);
    parseGenerated("gen/out.c\x00linguist-generated\x00set\x00dist/app.js\x00linguist-generated\x00false\x00src/main.zig\x00linguist-generated\x00unspecified\x00vendor/x.c\x00linguist-generated\x00true\x00", &paths, &out);
    try std.testing.expectEqual(@as(?bool, true), out[0]);
    try std.testing.expectEqual(@as(?bool, false), out[1]);
    try std.testing.expectEqual(@as(?bool, null), out[2]);
    try std.testing.expectEqual(@as(?bool, true), out[3]);
    // An answer out of order leaves the rest unknown rather than misassigned.
    @memset(&out, null);
    parseGenerated("src/main.zig\x00linguist-generated\x00set\x00", &paths, &out);
    try std.testing.expectEqual(@as(?bool, null), out[0]);
}

test "only supported comparison modes are accepted" {
    try std.testing.expect(std.meta.stringToEnum(Mode, "working") == .working);
    try std.testing.expect(std.meta.stringToEnum(Mode, "--exec") == null);
}

test "commits list their files, and merges none" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const output = "\x1eaaaa\x1fpppp\x1fAda\x1f1700000000\x1fFix the parser\n\nBody line.\n\x1f\x00\n:100644 100644 1111 2222 M\x00src/a b.c\x00:000000 100755 0000000000 3333 A\x00new.sh\x00\x1ebbbb\x1fpppp qqqq\x1fAda\x1f1700000001\x1fMerge main\n\x1f\x00";
    const commits = try parseCommits(arena.allocator(), output);
    try std.testing.expectEqual(@as(usize, 2), commits.len);
    try std.testing.expectEqualStrings("Fix the parser", commits[0].subject());
    try std.testing.expectEqualStrings("Fix the parser\n\nBody line.", commits[0].message);
    try std.testing.expectEqual(@as(usize, 2), commits[0].files.len);
    try std.testing.expectEqualStrings("src/a b.c", commits[0].files[0].path);
    try std.testing.expectEqualStrings("", commits[0].files[1].old);
    try std.testing.expectEqualStrings("100755", commits[0].files[1].mode);
    try std.testing.expect(commits[1].merge());
    try std.testing.expectEqual(@as(usize, 0), commits[1].files.len);
}

test "range-diff pairs rewritten commits and skips one-sided ones" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const output = "1:  3a77da75cb7e132c2c487fe750b153fbc114803d = 1:  3ebb6b910bf8b5d30d79c41784e532eb3de32cfc add h\n2:  c56dd2128499db622f2e954af8c1ff72fad8a99c ! 2:  339ca6d121579733e690bbbdf40652f7077504d8 g returns 1\n-:  ---------------------------------------- > 3:  1111111111111111111111111111111111111111 new\n3:  2222222222222222222222222222222222222222 < -:  ---------------------------------------- gone\n";
    const pairs = try parsePairs(arena.allocator(), output);
    try std.testing.expectEqual(@as(usize, 2), pairs.len);
    try std.testing.expect(pairs[0].same);
    try std.testing.expect(!pairs[1].same);
    try std.testing.expectEqualStrings("339ca6d121579733e690bbbdf40652f7077504d8", pairs[1].new);
}

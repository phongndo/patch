const std = @import("std");

pub const max_patch_bytes = 64 * 1024 * 1024;
pub const Mode = enum { working, staged, branch };
pub const Review = struct {
    patch: []const u8,
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
};

const flags = &.{ "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--unified=5" };

fn command(gpa: std.mem.Allocator, io: std.Io, cwd: []const u8, args: []const []const u8, difference: bool) ![]u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(gpa);
    try argv.appendSlice(gpa, &.{ "git", "--no-optional-locks", "-c", "core.quotepath=false" });
    try argv.appendSlice(gpa, args);
    const result = try std.process.run(gpa, io, .{
        .argv = argv.items,
        .cwd = .{ .path = cwd },
        .stdout_limit = .limited(max_patch_bytes),
        .stderr_limit = .limited(64 * 1024),
        .expand_arg0 = .expand,
    });
    defer gpa.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code == 0 or (difference and code == 1)) return result.stdout,
        else => {},
    }
    gpa.free(result.stdout);
    return error.GitCommandFailed;
}

fn diff(gpa: std.mem.Allocator, io: std.Io, root: []const u8, before: []const []const u8, after: []const []const u8, difference: bool) ![]u8 {
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    try args.append(gpa, "diff");
    try args.appendSlice(gpa, before);
    try args.appendSlice(gpa, flags);
    try args.appendSlice(gpa, after);
    return command(gpa, io, root, args.items, difference);
}

const NewFile = struct {
    io: std.Io,
    root: []const u8,
    path: []const u8,
    output: ?[]u8 = null,
    failure: ?anyerror = null,
    fn run(self: *NewFile) void {
        self.output = diff(std.heap.page_allocator, self.io, self.root, &.{"--no-index"}, &.{ "--", "/dev/null", self.path }, true) catch |err| {
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

/// `head_ref` names the branch to review against `base` in branch mode; empty
/// means the checked-out HEAD.
pub fn read(gpa: std.mem.Allocator, io: std.Io, path: []const u8, mode: Mode, base: []const u8, head_ref: []const u8) !Review {
    const root_raw = command(gpa, io, path, &.{ "rev-parse", "--show-toplevel" }, false) catch return error.InvalidRepository;
    const root = std.mem.trimEnd(u8, root_raw, "\r\n");
    const branch_raw = try command(gpa, io, root, &.{ "branch", "--show-current" }, false);
    const branch_name = std.mem.trimEnd(u8, branch_raw, "\r\n");
    const branch = if (branch_name.len == 0) "detached HEAD" else branch_name;
    const head_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "HEAD" }, false) catch null;
    const head = if (head_raw) |bytes| std.mem.trimEnd(u8, bytes, "\r\n") else "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    var patch: []const u8 = undefined;
    switch (mode) {
        .branch => {
            if (head_raw == null) return error.NoInitialCommit;
            const reference = try std.fmt.allocPrint(gpa, "{s}^{{commit}}", .{base});
            const revision_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "--end-of-options", reference }, false) catch return error.InvalidBaseBranch;
            const tip = if (head_ref.len > 0) blk: {
                const tip_reference = try std.fmt.allocPrint(gpa, "{s}^{{commit}}", .{head_ref});
                const tip_raw = command(gpa, io, root, &.{ "rev-parse", "--verify", "--end-of-options", tip_reference }, false) catch return error.InvalidHeadBranch;
                break :blk std.mem.trimEnd(u8, tip_raw, "\r\n");
            } else head;
            const range = try std.fmt.allocPrint(gpa, "{s}...{s}", .{ std.mem.trimEnd(u8, revision_raw, "\r\n"), tip });
            patch = try diff(gpa, io, root, &.{}, &.{ range, "--" }, false);
        },
        .staged => patch = try diff(gpa, io, root, &.{"--cached"}, &.{ head, "--" }, false),
        .working => {
            const tracked = try diff(gpa, io, root, &.{}, &.{ head, "--" }, false);
            const untracked = try command(gpa, io, root, &.{ "ls-files", "--others", "--exclude-standard", "-z" }, false);
            var output: std.ArrayList(u8) = .empty;
            try output.appendSlice(gpa, tracked);
            var paths = std.mem.tokenizeScalar(u8, untracked, 0);
            while (true) {
                var jobs: [4]NewFile = undefined;
                var threads: [4]?std.Thread = .{ null, null, null, null };
                var count: usize = 0;
                for (&jobs, 0..) |*job, index| {
                    const file = paths.next() orelse break;
                    job.* = .{ .io = io, .root = root, .path = file };
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
                }
            }
            patch = output.items;
        },
    }
    return .{
        .patch = patch,
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

test "only supported comparison modes are accepted" {
    try std.testing.expect(std.meta.stringToEnum(Mode, "working") == .working);
    try std.testing.expect(std.meta.stringToEnum(Mode, "--exec") == null);
}

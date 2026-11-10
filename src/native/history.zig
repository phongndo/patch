//! Brings earlier reviews to a comparison just read: whether each file's
//! change was reviewed, what changed since the version that was, and where
//! notes left on earlier versions sit now. Runs on the loading thread.
const std = @import("std");
const git = @import("git.zig");
const patch = @import("patch.zig");
const review = @import("review.zig");

pub const Context = struct {
    /// Everything allocated here lives as long as the comparison (an arena).
    alloc: std.mem.Allocator,
    io: std.Io,
    root: []const u8,
    /// Absent for an imported patch: then only records match, by content.
    store: ?git.Store,
    options: git.Options,
    /// In a commit's review, its message as last seen (its blob), when the
    /// commit was seen before a rewrite. Every commit's message shares one
    /// path, so only this says whether the message changed.
    earlier_message: []const u8 = "",
};

fn regular(mode: []const u8) bool {
    return std.mem.eql(u8, mode, "100644") or std.mem.eql(u8, mode, "100755");
}

/// Writes the working tree's versions of changed files into the store, so
/// they can be compared with once they change. False when a file changed
/// after Git read it: its id no longer matches the one in the diff.
/// `only`, when given, picks the files to write now.
pub fn snapshot(context: Context, files: []const patch.File, only: ?[]const bool) bool {
    const store = context.store orelse return true;
    var paths: std.ArrayList([]const u8) = .empty;
    var wanted: std.ArrayList([]const u8) = .empty;
    for (files, 0..) |file, index| {
        if (only) |picked| if (!picked[index]) continue;
        if (file.message or file.new_blob.len == 0 or !regular(file.mode) or store.has(context.io, file.new_blob)) continue;
        paths.append(context.alloc, file.path) catch return true;
        wanted.append(context.alloc, file.new_blob) catch return true;
    }
    if (paths.items.len == 0) return true;
    const ids = context.alloc.alloc([]const u8, paths.items.len) catch return true;
    git.snapshot(context.alloc, context.io, context.root, store, paths.items, ids) catch return true;
    for (ids, wanted.items) |id, blob| if (!std.mem.eql(u8, id, blob)) return false;
    return true;
}

/// The blobs that reviews of these files refer to and the store lacks, to
/// copy in from the repository (staged and committed versions live there,
/// where `git gc` could take them once unreachable).
pub fn toKeep(context: Context, files: []const patch.File, records: []const review.Record) []const []const u8 {
    const store = context.store orelse return &.{};
    var ids: std.ArrayList([]const u8) = .empty;
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    for (files) |file| for (records) |record| {
        if (!std.mem.eql(u8, record.path, file.path)) continue;
        for ([_][]const u8{ record.old, record.new }) |id| {
            if (id.len == 0 or seen.contains(id) or store.has(context.io, id)) continue;
            seen.put(context.alloc, id, {}) catch return ids.items;
            ids.append(context.alloc, id) catch return ids.items;
        }
    };
    return ids.items;
}

/// Removes loose objects from the store that nothing refers to (`referenced`:
/// reviewed and noted versions, and those shown now) and that nothing has
/// written for 30 days: versions shown but never reviewed, and the trees
/// built to diff them. Runs at most once a day.
pub fn prune(alloc: std.mem.Allocator, io: std.Io, objects: []const u8, referenced: *const std.StringHashMapUnmanaged(void)) void {
    const day: i96 = 24 * 60 * 60 * std.time.ns_per_s;
    const now = std.Io.Clock.real.now(io).nanoseconds;
    const cwd = std.Io.Dir.cwd();
    const marker = std.fmt.allocPrint(alloc, "{s}/../pruned", .{objects}) catch return;
    if (cwd.statFile(io, marker, .{})) |stat| {
        if (now - stat.mtime.nanoseconds < day) return;
    } else |_| {}
    cwd.writeFile(io, .{ .sub_path = marker, .data = "" }) catch return;
    var root = cwd.openDir(io, objects, .{ .iterate = true }) catch return;
    defer root.close(io);
    var folders = root.iterate();
    while (folders.next(io) catch return) |folder| {
        if (folder.kind != .directory or folder.name.len != 2) continue;
        var dir = root.openDir(io, folder.name, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        // Names first: the folder is not changed while it is read.
        var stale: std.ArrayList([]const u8) = .empty;
        var entries = dir.iterate();
        while (entries.next(io) catch break) |entry| {
            if (entry.kind != .file or entry.name.len != 38) continue;
            var id: [40]u8 = undefined;
            @memcpy(id[0..2], folder.name);
            @memcpy(id[2..], entry.name);
            if (referenced.contains(&id)) continue;
            const stat = dir.statFile(io, entry.name, .{}) catch continue;
            if (now - stat.mtime.nanoseconds < 30 * day) continue;
            stale.append(alloc, alloc.dupe(u8, entry.name) catch continue) catch continue;
        }
        for (stale.items) |name| dir.deleteFile(io, name) catch {};
    }
}

/// The files whose working-tree version a comparison needs at once: those
/// reviewed in another version, and those with notes left on another.
pub fn urgent(alloc: std.mem.Allocator, files: []const patch.File, records: []const review.Record, notes: []const review.Note) []const bool {
    const picked = alloc.alloc(bool, files.len) catch return &.{};
    for (files, picked) |file, *pick| {
        pick.* = false;
        for (records) |record| if (std.mem.eql(u8, record.path, file.path) and !std.mem.eql(u8, record.new, file.new_blob)) {
            pick.* = true;
        };
        for (notes) |note| if (!note.old and std.mem.eql(u8, note.path, file.path) and !std.mem.eql(u8, note.blob, file.new_blob)) {
            pick.* = true;
        };
    }
    return picked;
}

const Kind = enum { since, base, note };
const Pair = struct { kind: Kind, path: []const u8, from: []const u8, to: []const u8, from_mode: []const u8, to_mode: []const u8, file: usize, note: usize = 0 };

/// Marks each file's prior review, works out what changed since for files
/// reviewed in an earlier version, and moves `notes` (this comparison's)
/// to the versions shown. Comparisons that need versions the store and
/// repository no longer have fall back: no changes-since, notes outdated.
pub fn apply(context: Context, files: []patch.File, records: []const review.Record, notes: []review.Note) void {
    for (files) |*file| {
        file.prior = review.classify(records, file.*);
        if (file.message) {
            if (file.prior != .same) file.prior = if (context.earlier_message.len > 0 and !std.mem.eql(u8, context.earlier_message, file.new_blob)) .changed else .none;
        } else if (file.prior == .changed) if (review.latest(records, file.path)) |record| {
            if (std.mem.eql(u8, record.new, file.new_blob)) file.prior = .base;
        };
        file.reviewed = file.prior == .same or file.prior == .rebased;
    }
    var pairs: std.ArrayList(Pair) = .empty;
    if (context.store != null) for (files, 0..) |file, index| {
        if (file.prior != .changed or file.new_blob.len == 0) continue;
        if (file.message) {
            pairs.append(context.alloc, .{ .kind = .since, .path = file.path, .from = context.earlier_message, .to = file.new_blob, .from_mode = "100644", .to_mode = "100644", .file = index }) catch return;
            continue;
        }
        const record = review.latest(records, file.path) orelse continue;
        pairs.append(context.alloc, .{ .kind = .since, .path = file.path, .from = record.new, .to = file.new_blob, .from_mode = record.mode, .to_mode = file.mode, .file = index }) catch return;
        if (record.old.len > 0 and file.old_blob.len > 0 and !std.mem.eql(u8, record.old, file.old_blob))
            pairs.append(context.alloc, .{ .kind = .base, .path = file.path, .from = record.old, .to = file.old_blob, .from_mode = "100644", .to_mode = "100644", .file = index }) catch return;
    };
    for (notes, 0..) |*note, note_index| {
        const index = find(files, note.path) orelse continue;
        const file = files[index];
        const side = if (note.old) file.old_blob else file.new_blob;
        if (note.blob.len == 0) {
            note.blob = side;
            continue;
        }
        if (std.mem.eql(u8, note.blob, side)) continue;
        if (side.len == 0 or context.store == null) {
            review.lose(note, side);
            continue;
        }
        pairs.append(context.alloc, .{ .kind = .note, .path = file.path, .from = note.blob, .to = side, .from_mode = "100644", .to_mode = "100644", .file = index, .note = note_index }) catch return;
    }
    if (pairs.items.len == 0) return;
    const diffs = compare(context, pairs.items) catch &.{};
    for (pairs.items, 0..) |pair, index| {
        const rows: ?[]patch.Row = if (index < diffs.len) diffs[index] else null;
        switch (pair.kind) {
            .since => if (rows) |found| {
                const since = context.alloc.create(patch.Since) catch continue;
                var additions: u32 = 0;
                var deletions: u32 = 0;
                for (found) |row| {
                    additions += @intFromBool(row.added);
                    deletions += @intFromBool(row.removed);
                }
                since.* = .{ .unified = found, .split = patch.pairRows(context.alloc, found) catch continue, .additions = additions, .deletions = deletions };
                files[pair.file].since = since;
            },
            .base => {},
            .note => if (rows) |found| review.follow(&notes[pair.note], found, pair.to) else review.lose(&notes[pair.note], pair.to),
        }
    }
    // Lines the base brought in, found among the changes since review.
    for (pairs.items, 0..) |pair, index| {
        if (pair.kind != .base) continue;
        const since = files[pair.file].since orelse continue;
        since.base_moved = true;
        const base_rows: []patch.Row = if (index < diffs.len) diffs[index] orelse continue else continue;
        markBase(since.unified, base_rows);
        markBase(since.split, base_rows);
    }
}
fn find(files: []const patch.File, path: []const u8) ?usize {
    for (files, 0..) |file, index| if (!file.message and std.mem.eql(u8, file.path, path)) return index;
    for (files, 0..) |file, index| if (std.mem.eql(u8, file.path, path)) return index;
    return null;
}
/// Marks changes since review that the base made too: the same line
/// removed, or the same line added, between the old sides.
fn markBase(rows: []patch.Row, base: []const patch.Row) void {
    for (rows) |*row| {
        if (!row.added and !row.removed) continue;
        var removed = !row.removed;
        var added = !row.added;
        for (base) |other| {
            if (!removed and other.removed and std.mem.eql(u8, other.left, row.left)) removed = true;
            if (!added and other.added and std.mem.eql(u8, other.right, row.right)) added = true;
            if (removed and added) break;
        }
        row.base = removed and added;
    }
}

/// Diffs each pair's versions, a round per pass so a path appears once on
/// each side of a round: one tree holds every round, `r<n>/a` and `r<n>/b`.
/// The result lines up with `pairs`; null where a version is missing.
fn compare(context: Context, pairs: []const Pair) ![]?[]patch.Row {
    const store = context.store.?;
    const results = try context.alloc.alloc(?[]patch.Row, pairs.len);
    @memset(results, null);
    // Leave out pairs whose versions neither the store nor the repository has.
    var ids: std.ArrayList([]const u8) = .empty;
    for (pairs) |pair| try ids.appendSlice(context.alloc, &.{ pair.from, pair.to });
    const missing = try git.missing(context.alloc, context.io, context.root, store, ids.items);
    var rounds: std.ArrayList(std.StringHashMapUnmanaged(usize)) = .empty;
    const round_of = try context.alloc.alloc(usize, pairs.len);
    var entries: std.ArrayList(git.TreeEntry) = .empty;
    for (pairs, 0..) |pair, index| {
        round_of[index] = std.math.maxInt(usize);
        if (missing.contains(pair.from) or missing.contains(pair.to)) continue;
        // A pair asked before shares its diff.
        var shared: ?usize = null;
        for (pairs[0..index], 0..) |earlier, earlier_index| if (round_of[earlier_index] != std.math.maxInt(usize) and std.mem.eql(u8, earlier.path, pair.path) and std.mem.eql(u8, earlier.from, pair.from) and std.mem.eql(u8, earlier.to, pair.to)) {
            shared = round_of[earlier_index];
            break;
        };
        if (shared) |round| {
            round_of[index] = round;
            continue;
        }
        var round: usize = 0;
        while (round < rounds.items.len and rounds.items[round].contains(pair.path)) round += 1;
        if (round == rounds.items.len) try rounds.append(context.alloc, .empty);
        try rounds.items[round].put(context.alloc, pair.path, index);
        round_of[index] = round;
        try entries.append(context.alloc, .{ .mode = if (regular(pair.from_mode)) pair.from_mode else "100644", .id = pair.from, .path = try std.fmt.allocPrint(context.alloc, "r{d}/a/{s}", .{ round, pair.path }) });
        try entries.append(context.alloc, .{ .mode = if (regular(pair.to_mode)) pair.to_mode else "100644", .id = pair.to, .path = try std.fmt.allocPrint(context.alloc, "r{d}/b/{s}", .{ round, pair.path }) });
    }
    if (entries.items.len == 0) return results;
    const tree = try git.tree(context.alloc, context.io, context.root, store, entries.items);
    for (rounds.items, 0..) |_, round| {
        const output = git.diffTrees(context.alloc, context.io, context.root, store, context.options, try std.fmt.allocPrint(context.alloc, "{s}:r{d}/a", .{ tree, round }), try std.fmt.allocPrint(context.alloc, "{s}:r{d}/b", .{ tree, round })) catch continue;
        const parsed = patch.parse(context.alloc, output) catch continue;
        for (pairs, 0..) |pair, index| {
            if (round_of[index] != round) continue;
            // Identical versions have no diff: every line stays where it is.
            results[index] = &.{};
            for (parsed) |file| if (std.mem.eql(u8, file.path, pair.path)) {
                results[index] = file.unified;
                break;
            };
        }
    }
    return results;
}

/// The commit message as a file of its own, first in a commit's review.
pub const message_path = "Commit message";
pub fn messageFile(alloc: std.mem.Allocator, message: []const u8) !patch.File {
    return patch.textFile(alloc, message_path, message);
}

pub const CommitState = enum { new, partial, reviewed, changed };
/// How far each commit's review has come: its message and every file
/// reviewed (or, after a rewrite, its unchanged twin was), some of them, or
/// none; `changed` when a reviewed commit was rewritten with edits.
pub fn commitStates(alloc: std.mem.Allocator, commits: []const git.Commit, records: []const review.Record, marks: []const review.Mark, pairs: []const git.Pair) []const CommitState {
    const states = alloc.alloc(CommitState, commits.len) catch return &.{};
    for (commits, states) |commit, *state| {
        var done: usize = 0;
        var total: usize = 1 + commit.files.len;
        const message_blob = patch.blobId(commit.message);
        for (records) |record| if (std.mem.eql(u8, record.path, message_path) and std.mem.eql(u8, record.new, &message_blob)) {
            done += 1;
            break;
        };
        for (commit.files) |raw| for (records) |record| {
            if (std.mem.eql(u8, record.path, raw.path) and std.mem.eql(u8, record.old, raw.old) and std.mem.eql(u8, record.new, raw.new) and (raw.new.len == 0 or std.mem.eql(u8, record.mode, raw.mode))) {
                done += 1;
                break;
            }
        };
        if (commit.merge()) total = 1;
        state.* = if (done >= total) .reviewed else if (done > 0) .partial else .new;
        if (marked(marks, commit.id)) state.* = .reviewed;
        if (state.* != .reviewed) for (pairs) |pair| if (std.mem.eql(u8, pair.new, commit.id) and marked(marks, pair.old)) {
            state.* = if (pair.same) .reviewed else .changed;
        };
    }
    return states;
}
fn marked(marks: []const review.Mark, id: []const u8) bool {
    for (marks) |mark| if (mark.reviewed and std.mem.eql(u8, mark.id, id)) return true;
    return false;
}

test "commit progress includes the file mode in its reviewed identity" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const message = "Make executable";
    const message_blob = patch.blobId(message);
    const commits = [_]git.Commit{.{ .id = "commit", .parents = "parent", .author = "A", .time = 0, .message = message, .files = &.{
        .{ .path = "run", .old = "same", .new = "same", .mode = "100755" },
        .{ .path = "deleted", .old = "old", .new = "", .mode = "000000" },
    } }};
    var records = [_]review.Record{
        .{ .path = message_path, .new = &message_blob },
        .{ .path = "run", .old = "same", .new = "same", .mode = "100644" },
        .{ .path = "deleted", .old = "old", .new = "" },
    };
    const states = commitStates(arena.allocator(), &commits, &records, &.{}, &.{});
    try std.testing.expectEqual(CommitState.partial, states[0]);
    records[1].mode = "100755";
    try std.testing.expectEqual(CommitState.reviewed, commitStates(arena.allocator(), &commits, &records, &.{}, &.{})[0]);
}

const std = @import("std");

pub const Row = struct {
    old: u32 = 0,
    old_offset: usize = 0,
    new_offset: usize = 0,
    new: u32 = 0,
    left: []const u8 = "",
    right: []const u8 = "",
    removed: bool = false,
    added: bool = false,
    meta: bool = false,
    /// The lexer state each side's line starts in, as an index into the
    /// app's table of highlighter states (0 is the state a hunk starts in),
    /// so a comment or string that spans lines keeps its color.
    old_carry: u16 = 0,
    new_carry: u16 = 0,
    /// In a diff since the last review: the change came with the base, not
    /// the author (the same line moved the same way between the bases).
    base: bool = false,
};
/// What earlier reviews say about a file's change: nothing; this exact
/// change was reviewed; the same change was, on another base; an earlier
/// version of the file was; or this very version was, over another base
/// (the diff differs though the result does not).
pub const Prior = enum { none, same, rebased, changed, base };
/// The diff from the version of a file last reviewed to the one under review.
pub const Since = struct {
    unified: []Row,
    split: []Row,
    additions: u32,
    deletions: u32,
    /// The old side moved too, so some lines may have come from the base.
    base_moved: bool = false,
};
pub const File = struct {
    path: []const u8,
    previous: []const u8 = "",
    status: enum { modified, added, deleted, renamed } = .modified,
    additions: u32 = 0,
    deletions: u32 = 0,
    unified: []Row,
    split: []Row,
    reviewed: bool = false,
    /// Only the header shows; reviewed files fold away so large reviews stay navigable.
    collapsed: bool = false,
    /// A lockfile or a path marked `linguist-generated`; it opens folded.
    generated: bool = false,
    /// Every change in it is whitespace, hidden while whitespace is ignored.
    whitespace_only: bool = false,
    /// Both sides' blob ids from the `index` line (Patch asks Git for full
    /// ids); empty for a side that does not exist or a patch that names none.
    old_blob: []const u8 = "",
    new_blob: []const u8 = "",
    /// The new side's file mode, for building trees of reviewed versions.
    mode: []const u8 = "100644",
    /// The change itself, wherever it applies: its path and the lines it
    /// removes and adds, whitespace aside (as `git patch-id` sees a change),
    /// so a rebase that leaves a change alone keeps its review.
    change: [16]u8 = @splat(0),
    /// A commit's message, shown first in the commit's review as a file.
    message: bool = false,
    prior: Prior = .none,
    /// The changes since the version last reviewed, when it is at hand.
    since: ?*Since = null,
    /// The rows shown are the changes since review: `since` and the full
    /// diff trade places, so everything that reads rows reads the shown ones.
    showing_since: bool = false,

    /// Shows the changes since review in place of the full diff, or back.
    pub fn swapSince(self: *File) void {
        const since = self.since orelse return;
        std.mem.swap([]Row, &self.unified, &since.unified);
        std.mem.swap([]Row, &self.split, &since.split);
        std.mem.swap(u32, &self.additions, &since.additions);
        std.mem.swap(u32, &self.deletions, &since.deletions);
        self.showing_since = !self.showing_since;
    }
    /// A new or deleted file shows one column, unless it is showing its
    /// changes since review, which have both sides.
    pub fn oneSided(self: File) bool {
        return !self.showing_since and (self.status == .added or self.status == .deleted);
    }
    /// The full diff's unified rows, whichever rows are shown.
    pub fn fullRows(self: File) []const Row {
        return if (self.showing_since) self.since.?.unified else self.unified;
    }
};

fn path(raw: []const u8) []const u8 {
    var value = std.mem.trim(u8, raw, "\r\n\t\"");
    if (std.mem.startsWith(u8, value, "a/") or std.mem.startsWith(u8, value, "b/")) value = value[2..];
    return value;
}

/// Split rows from unified ones: removed lines beside the added lines that replace them.
pub fn pairRows(gpa: std.mem.Allocator, unified: []const Row) ![]Row {
    return pair(gpa, unified);
}
fn pair(gpa: std.mem.Allocator, unified: []const Row) ![]Row {
    var rows: std.ArrayList(Row) = .empty;
    var index: usize = 0;
    while (index < unified.len) {
        const start = index;
        if (unified[index].removed) {
            while (index < unified.len and unified[index].removed) : (index += 1) {}
            const removed = unified[start..index];
            const add_start = index;
            while (index < unified.len and unified[index].added) : (index += 1) {}
            const added = unified[add_start..index];
            for (0..@max(removed.len, added.len)) |offset| {
                var row = Row{};
                if (offset < removed.len) {
                    row.old = removed[offset].old;
                    row.old_offset = removed[offset].old_offset;
                    row.left = removed[offset].left;
                    row.removed = true;
                }
                if (offset < added.len) {
                    row.new = added[offset].new;
                    row.new_offset = added[offset].new_offset;
                    row.right = added[offset].right;
                    row.added = true;
                }
                try rows.append(gpa, row);
            }
        } else {
            try rows.append(gpa, unified[index]);
            index += 1;
        }
    }
    return rows.items;
}

fn finish(gpa: std.mem.Allocator, files: *std.ArrayList(File), current: ?File, rows: *std.ArrayList(Row)) !void {
    if (current) |value| {
        var file = value;
        var old_offset: usize = 0;
        var new_offset: usize = 0;
        for (rows.items) |*row| {
            row.old_offset = old_offset;
            row.new_offset = new_offset;
            if (row.old > 0) old_offset += row.left.len + 1;
            if (row.new > 0) new_offset += row.right.len + 1;
        }
        file.unified = rows.items;
        file.split = try pair(gpa, rows.items);
        file.change = changeOf(file.path, rows.items);
        try files.append(gpa, file);
        rows.* = .empty;
    }
}

pub fn parse(gpa: std.mem.Allocator, patch: []const u8) ![]File {
    var files: std.ArrayList(File) = .empty;
    var rows: std.ArrayList(Row) = .empty;
    var current: ?File = null;
    var old: u32 = 0;
    var new: u32 = 0;
    var in_hunk = false;
    var lines = std.mem.splitScalar(u8, patch, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trimEnd(u8, raw, "\r");
        if (std.mem.startsWith(u8, line, "diff --git ")) {
            try finish(gpa, &files, current, &rows);
            const start = if (std.mem.lastIndexOf(u8, line, " b/")) |position| position + 1 else 11;
            current = .{ .path = path(line[start..]), .unified = &.{}, .split = &.{} };
            in_hunk = false;
            continue;
        }
        if (current == null and std.mem.startsWith(u8, line, "--- ")) {
            current = .{ .path = path(line[4..]), .unified = &.{}, .split = &.{} };
        }
        if (current == null) continue;
        if (std.mem.startsWith(u8, line, "@@ ")) {
            var parts = std.mem.tokenizeScalar(u8, line, ' ');
            _ = parts.next();
            const before = parts.next() orelse return error.InvalidHunk;
            const after = parts.next() orelse return error.InvalidHunk;
            old = std.fmt.parseInt(u32, before[1 .. std.mem.indexOfScalar(u8, before, ',') orelse before.len], 10) catch return error.InvalidHunk;
            new = std.fmt.parseInt(u32, after[1 .. std.mem.indexOfScalar(u8, after, ',') orelse after.len], 10) catch return error.InvalidHunk;
            try rows.append(gpa, .{ .meta = true, .left = line, .right = line });
            in_hunk = true;
        } else if (!in_hunk) {
            if (std.mem.startsWith(u8, line, "+++ ") and !std.mem.eql(u8, line[4..], "/dev/null")) current.?.path = path(line[4..]);
            if (std.mem.startsWith(u8, line, "index ")) blobs(&current.?, line[6..]);
            if (std.mem.startsWith(u8, line, "new file mode ")) current.?.mode = line[14..];
            if (std.mem.startsWith(u8, line, "new mode ")) current.?.mode = line[9..];
            if (std.mem.startsWith(u8, line, "new file mode")) current.?.status = .added;
            if (std.mem.startsWith(u8, line, "deleted file mode")) current.?.status = .deleted;
            if (std.mem.startsWith(u8, line, "rename from ")) {
                current.?.previous = line[12..];
                current.?.status = .renamed;
            }
            if (std.mem.startsWith(u8, line, "rename to ")) current.?.path = line[10..];
        } else if (line.len > 0) {
            switch (line[0]) {
                ' ' => {
                    try rows.append(gpa, .{ .old = old, .new = new, .left = line[1..], .right = line[1..] });
                    old += 1;
                    new += 1;
                },
                '-' => {
                    try rows.append(gpa, .{ .old = old, .left = line[1..], .removed = true });
                    old += 1;
                    current.?.deletions += 1;
                },
                '+' => {
                    try rows.append(gpa, .{ .new = new, .right = line[1..], .added = true });
                    new += 1;
                    current.?.additions += 1;
                },
                else => {},
            }
        }
    }
    try finish(gpa, &files, current, &rows);
    if (patch.len > 0 and files.items.len == 0) return error.InvalidPatch;
    return files.items;
}

/// `index <old>..<new>[ <mode>]`: a side Git shows as all zeros does not exist.
fn blobs(file: *File, text: []const u8) void {
    const dots = std.mem.indexOf(u8, text, "..") orelse return;
    const rest = text[dots + 2 ..];
    const space_at = std.mem.indexOfScalar(u8, rest, ' ');
    const old = text[0..dots];
    const new = if (space_at) |at| rest[0..at] else rest;
    if (space_at) |at| file.mode = rest[at + 1 ..];
    file.old_blob = if (std.mem.trim(u8, old, "0").len == 0) "" else old;
    file.new_blob = if (std.mem.trim(u8, new, "0").len == 0) "" else new;
}

fn changeOf(path_name: []const u8, rows: []const Row) [16]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(path_name);
    hash.update("\x00");
    for (rows) |row| {
        if (row.meta or !(row.removed or row.added)) continue;
        hash.update(if (row.removed) "-" else "+");
        var words = std.mem.tokenizeAny(u8, if (row.removed) row.left else row.right, " \t\r\x0b\x0c");
        while (words.next()) |word| hash.update(word);
        hash.update("\n");
    }
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return digest[0..16].*;
}

/// A file of plain lines, as a commit message reads: every line on the new
/// side, none marked added, its blob that of the text.
pub fn textFile(gpa: std.mem.Allocator, path_name: []const u8, text: []const u8) !File {
    var rows: std.ArrayList(Row) = .empty;
    var lines = std.mem.splitScalar(u8, text, '\n');
    var number: u32 = 1;
    var offset: usize = 0;
    while (lines.next()) |line| {
        try rows.append(gpa, .{ .new = number, .new_offset = offset, .right = std.mem.trimEnd(u8, line, "\r") });
        number += 1;
        offset += line.len + 1;
    }
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(path_name);
    hash.update("\x00");
    hash.update(text);
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    const id = blobId(text);
    return .{ .path = path_name, .status = .added, .unified = rows.items, .split = try gpa.dupe(Row, rows.items), .new_blob = try gpa.dupe(u8, &id), .change = digest[0..16].*, .message = true };
}

/// Git's id for a blob of these bytes.
pub fn blobId(bytes: []const u8) [40]u8 {
    var hash = std.crypto.hash.Sha1.init(.{});
    var header: [32]u8 = undefined;
    hash.update(std.fmt.bufPrint(&header, "blob {d}\x00", .{bytes.len}) catch unreachable);
    hash.update(bytes);
    var digest: [20]u8 = undefined;
    hash.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

pub const Hunk = struct { old_start: u32, old_count: u32, new_start: u32, new_count: u32 };
/// `@@ -a[,b] +c[,d] @@`: where a hunk sits on each side.
pub fn parseHunk(header: []const u8) ?Hunk {
    var parts = std.mem.tokenizeScalar(u8, header, ' ');
    if (!std.mem.eql(u8, parts.next() orelse return null, "@@")) return null;
    const before = parts.next() orelse return null;
    const after = parts.next() orelse return null;
    if (before.len < 2 or after.len < 2 or before[0] != '-' or after[0] != '+') return null;
    const old = range(before[1..]) orelse return null;
    const new = range(after[1..]) orelse return null;
    return .{ .old_start = old[0], .old_count = old[1], .new_start = new[0], .new_count = new[1] };
}
fn range(text: []const u8) ?[2]u32 {
    const comma = std.mem.indexOfScalar(u8, text, ',');
    const start = std.fmt.parseInt(u32, text[0 .. comma orelse text.len], 10) catch return null;
    const count = if (comma) |at| std.fmt.parseInt(u32, text[at + 1 ..], 10) catch return null else 1;
    return .{ start, count };
}
fn shifted(line: u32, shift: i64) u32 {
    return @intCast(std.math.clamp(@as(i64, line) + shift, 1, std.math.maxInt(u32)));
}
/// Where line `line` of a diff's old side lands on its new side, or null when
/// the diff removes or rewrites it. `rows` are the diff's unified rows. Lines
/// outside every hunk move with the lines added and removed above them.
pub fn mapLine(rows: []const Row, line: u32) ?u32 {
    var shift: i64 = 0;
    for (rows, 0..) |row, index| {
        if (!row.meta) continue;
        const hunk = parseHunk(row.left) orelse continue;
        // A side with no lines names the line before the hunk.
        const first = if (hunk.old_count == 0) hunk.old_start + 1 else hunk.old_start;
        const new_first = if (hunk.new_count == 0) hunk.new_start + 1 else hunk.new_start;
        if (line < first) return shifted(line, @as(i64, new_first) - first);
        if (line < first + hunk.old_count) {
            for (rows[index + 1 ..]) |inner| {
                if (inner.meta) break;
                if (inner.old == line) return if (inner.removed) null else inner.new;
            }
            return null;
        }
        shift = (@as(i64, new_first) + hunk.new_count) - (@as(i64, first) + hunk.old_count);
    }
    return shifted(line, shift);
}
/// The new-side line closest to old line `line`: where it went, or, when the
/// diff removed it, the first line after the change (else the last before).
pub fn nearestLine(rows: []const Row, line: u32) u32 {
    if (mapLine(rows, line)) |mapped| return mapped;
    var before: u32 = 0;
    var seen = false;
    for (rows) |row| {
        if (row.meta) {
            if (seen) break;
            before = 0;
            continue;
        }
        if (seen and row.new > 0) return row.new;
        if (row.old == line and row.removed) seen = true else if (row.new > 0) before = row.new;
    }
    return @max(1, before);
}

/// Whether one side of a hunk seems to begin inside a `/* … */` comment: its
/// first comment delimiter closes one. A closer with a quote or a slash before
/// it on its line (a string, a regular expression, a path) proves nothing, so
/// it does not count. `rows` starts after the hunk's header.
pub fn startsInBlockComment(rows: []const Row, old: bool) bool {
    for (rows) |row| {
        if (row.meta) return false;
        if ((if (old) row.old else row.new) == 0) continue;
        const text = if (old) row.left else row.right;
        const opens = std.mem.indexOf(u8, text, "/*");
        const closes = std.mem.indexOf(u8, text, "*/") orelse {
            if (opens != null) return false;
            continue;
        };
        if (opens) |at| if (at < closes) return false;
        return std.mem.indexOfAny(u8, text[0..closes], "\"'`/") == null;
    }
    return false;
}

const lockfiles = [_][]const u8{ "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "deno.lock", "Cargo.lock", "flake.lock", "go.sum", "Gemfile.lock", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "composer.lock", "Podfile.lock", "Package.resolved", "pubspec.lock", "mix.lock", "gradle.lockfile" };
/// Package managers' lockfiles, which are generated whether or not a
/// repository marks them `linguist-generated`.
pub fn isLockfile(path_name: []const u8) bool {
    const name = std.fs.path.basename(path_name);
    for (lockfiles) |lockfile| if (std.mem.eql(u8, name, lockfile)) return true;
    return false;
}

test "index lines name both sides' blobs and the new side's mode" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const files = try parse(arena.allocator(), "diff --git a/x.c b/x.c\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100755\n--- a/x.c\n+++ b/x.c\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/n.c b/n.c\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333\n--- /dev/null\n+++ b/n.c\n@@ -0,0 +1 @@\n+c\n");
    try std.testing.expectEqualStrings("1111111111111111111111111111111111111111", files[0].old_blob);
    try std.testing.expectEqualStrings("2222222222222222222222222222222222222222", files[0].new_blob);
    try std.testing.expectEqualStrings("100755", files[0].mode);
    try std.testing.expectEqualStrings("", files[1].old_blob);
    try std.testing.expectEqualStrings("100644", files[1].mode);
}

test "a change is its removed and added lines, wherever they sit and however indented" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const a = try parse(alloc, "diff --git a/x.c b/x.c\n--- a/x.c\n+++ b/x.c\n@@ -10,3 +10,3 @@ int f(void)\n a\n-  return 1;\n+  return 2;\n b\n");
    const moved = try parse(alloc, "diff --git a/x.c b/x.c\n--- a/x.c\n+++ b/x.c\n@@ -40,3 +41,3 @@\n z\n-\treturn 1;\n+\treturn  2;\n y\n");
    const other = try parse(alloc, "diff --git a/x.c b/x.c\n--- a/x.c\n+++ b/x.c\n@@ -10,3 +10,3 @@\n a\n-  return 1;\n+  return 3;\n b\n");
    try std.testing.expectEqualSlices(u8, &a[0].change, &moved[0].change);
    try std.testing.expect(!std.mem.eql(u8, &a[0].change, &other[0].change));
}

test "lines map across a diff, and removed ones find their neighbours" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // Old 1-10 becomes: line 3 rewritten as two lines, line 8 removed.
    const files = try parse(arena.allocator(), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,3 +2,4 @@\n two\n-three\n+three a\n+three b\n four\n@@ -7,3 +8,2 @@\n seven\n-eight\n nine\n");
    const rows = files[0].unified;
    try std.testing.expectEqual(@as(?u32, 1), mapLine(rows, 1));
    try std.testing.expectEqual(@as(?u32, 2), mapLine(rows, 2));
    try std.testing.expectEqual(@as(?u32, null), mapLine(rows, 3));
    try std.testing.expectEqual(@as(?u32, 5), mapLine(rows, 4));
    try std.testing.expectEqual(@as(?u32, 7), mapLine(rows, 6));
    try std.testing.expectEqual(@as(?u32, null), mapLine(rows, 8));
    try std.testing.expectEqual(@as(?u32, 9), mapLine(rows, 9));
    try std.testing.expectEqual(@as(?u32, 12), mapLine(rows, 12));
    try std.testing.expectEqual(@as(u32, 3), nearestLine(rows, 3));
    try std.testing.expectEqual(@as(u32, 9), nearestLine(rows, 8));
}

test "blob ids match Git's" {
    // printf 'hello\n' | git hash-object --stdin
    try std.testing.expectEqualStrings("ce013625030ba8dba906f756967f9e9ca394464a", &blobId("hello\n"));
}

test "a hunk side that first closes a comment starts inside one" {
    const rows = [_]Row{
        .{ .old = 4, .new = 4, .left = " * Returns the count.", .right = " * Returns the count." },
        .{ .old = 5, .new = 5, .left = " */", .right = " */" },
        .{ .new = 6, .right = "int count(void);", .added = true },
    };
    try std.testing.expect(startsInBlockComment(&rows, true));
    try std.testing.expect(startsInBlockComment(&rows, false));
    const opens = [_]Row{.{ .new = 1, .right = "/* a */ int x;" }};
    try std.testing.expect(!startsInBlockComment(&opens, false));
    // A glob, a regular expression and a string can all contain the closer.
    for ([_][]const u8{ "include: [\"src/**/*.ts\"],", "s.replace(/\\s*/g, \"\");", "x = '*/';" }) |text| {
        const row = [_]Row{.{ .new = 1, .right = text }};
        try std.testing.expect(!startsInBlockComment(&row, false));
    }
    // The next hunk's header ends the search.
    const later = [_]Row{ .{ .new = 1, .right = "int x;" }, .{ .meta = true, .left = "@@", .right = "@@" }, .{ .new = 9, .right = " */" } };
    try std.testing.expect(!startsInBlockComment(&later, false));
}

test "lockfiles are generated by name, wherever they sit" {
    try std.testing.expect(isLockfile("pnpm-lock.yaml"));
    try std.testing.expect(isLockfile("tools/rust/Cargo.lock"));
    try std.testing.expect(!isLockfile("src/lock.zig"));
}

test "native split rows align replacements and preserve original line anchors" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const files = try parse(arena.allocator(), "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5,2 +5,3 @@\n-old\n+new\n+extra\n context\n");
    try std.testing.expectEqual(@as(usize, 1), files.len);
    try std.testing.expectEqual(@as(u32, 2), files[0].additions);
    try std.testing.expectEqual(@as(u32, 1), files[0].deletions);
    try std.testing.expectEqual(@as(u32, 5), files[0].split[1].old);
    try std.testing.expectEqualStrings("new", files[0].split[1].right);
    try std.testing.expectEqual(@as(u32, 7), files[0].split[3].new);
}

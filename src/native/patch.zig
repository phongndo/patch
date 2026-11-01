//! Unified patch parsing: files, hunks, aligned split rows, blob ids, change
//! hashes, and mapping lines across a diff.

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
    /// The hunk a row belongs to: a header's own index, and for the rows
    /// under it, the index of the header above them.
    hunk: u16 = 0,
    /// A header that stands for the lines after the last hunk, so they can
    /// be shown too; it belongs to no hunk.
    tail: bool = false,
    /// Shown from the file itself, to give a hunk more context.
    expanded: bool = false,
    /// Part of a block of lines the diff moved elsewhere rather than
    /// changed, on each side: an index into the review's moves, plus one
    /// (0 for none).
    moved_old: u32 = 0,
    moved_new: u32 = 0,
};
/// A hunk of a file's diff, as review sees it: its change (as `File.change`,
/// for this hunk's lines alone) and whether it was reviewed or folded away.
pub const Hunk = struct {
    change: [16]u8 = @splat(0),
    reviewed: bool = false,
    collapsed: bool = false,
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
    /// Its hunks, in order, as `Row.hunk` counts them.
    hunks: []Hunk = &.{},
    /// The full diff's rows before any context was shown, to go back to.
    compact: []Row = &.{},
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
    /// Git found no lines to compare (it named the file binary).
    binary: bool = false,
    /// Not part of the change: a file opened to read code the change uses.
    reference: bool = false,
    /// One of the project's files, listed to read rather than review (Files
    /// mode); it is a reference file too. `unread` until it is first opened,
    /// when its lines are read from the working tree.
    listed: bool = false,
    unread: bool = false,
    /// A listed file the working tree would not give up (a submodule, or
    /// one removed since it was listed).
    unreadable: bool = false,
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
                var row = Row{ .hunk = unified[start].hunk };
                if (offset < removed.len) {
                    const from = removed[offset];
                    row.old = from.old;
                    row.old_offset = from.old_offset;
                    row.old_carry = from.old_carry;
                    row.left = from.left;
                    row.removed = true;
                    row.base = from.base;
                    row.moved_old = from.moved_old;
                }
                if (offset < added.len) {
                    const from = added[offset];
                    row.new = from.new;
                    row.new_offset = from.new_offset;
                    row.new_carry = from.new_carry;
                    row.right = from.right;
                    row.added = true;
                    row.base = row.base or from.base;
                    row.moved_new = from.moved_new;
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

/// Each row's place in its side's text, as native selection counts bytes:
/// the lines of a side one after another, each with its newline.
pub fn offsets(rows: []Row) void {
    var old_offset: usize = 0;
    var new_offset: usize = 0;
    for (rows) |*row| {
        row.old_offset = old_offset;
        row.new_offset = new_offset;
        if (row.old > 0) old_offset += row.left.len + 1;
        if (row.new > 0) new_offset += row.right.len + 1;
    }
}
/// Numbers each row by the hunk it is in, and gives each hunk its change.
fn numberHunks(gpa: std.mem.Allocator, path_name: []const u8, rows: []Row) ![]Hunk {
    var count: usize = 0;
    for (rows) |row| count += @intFromBool(row.meta and !row.tail);
    const hunks = try gpa.alloc(Hunk, count);
    var index: usize = 0;
    var start: usize = 0;
    for (rows, 0..) |*row, at| {
        if (!row.meta or row.tail) {
            row.hunk = @intCast((index -| 1) & 0xffff);
            continue;
        }
        if (index > 0) hunks[index - 1] = .{ .change = changeOf(path_name, rows[start..at]) };
        row.hunk = @intCast(index & 0xffff);
        index += 1;
        start = at + 1;
    }
    if (index > 0) hunks[index - 1] = .{ .change = changeOf(path_name, rows[start..]) };
    return hunks;
}
fn finish(gpa: std.mem.Allocator, files: *std.ArrayList(File), current: ?File, rows: *std.ArrayList(Row)) !void {
    if (current) |value| {
        var file = value;
        offsets(rows.items);
        file.hunks = try numberHunks(gpa, file.path, rows.items);
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
            if (std.mem.startsWith(u8, line, "GIT binary patch") or std.mem.startsWith(u8, line, "Binary files ")) current.?.binary = true;
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

/// A file opened for reference, unchanged: every line on the new side.
pub fn referenceFile(gpa: std.mem.Allocator, path_name: []const u8, text: []const u8) !File {
    var rows: std.ArrayList(Row) = .empty;
    const source = try textOf(gpa, text);
    for (1..source.count() + 1) |line_number| try rows.append(gpa, .{ .new = @intCast(line_number), .right = source.line(@intCast(line_number)) });
    offsets(rows.items);
    return .{ .path = try gpa.dupe(u8, path_name), .status = .added, .unified = rows.items, .split = try gpa.dupe(Row, rows.items), .reference = true };
}
/// One of the project's files, listed and folded, its lines not yet read.
pub fn listedFile(path_name: []const u8) File {
    return .{ .path = path_name, .status = .added, .unified = &.{}, .split = &.{}, .reference = true, .listed = true, .unread = true, .collapsed = true };
}
/// A listed file's lines, read: the whole file on the new side, or nothing
/// for a binary file, which says so.
pub fn readListed(gpa: std.mem.Allocator, file: *File, text: []const u8) !void {
    if (looksBinary(text)) {
        file.binary = true;
    } else {
        const read = try referenceFile(gpa, file.path, text);
        file.unified = read.unified;
        file.split = read.split;
    }
    file.unread = false;
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

pub const Range = struct { old_start: u32, old_count: u32, new_start: u32, new_count: u32 };
/// `@@ -a[,b] +c[,d] @@`: where a hunk sits on each side.
pub fn parseHunk(header: []const u8) ?Range {
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

/// One side of a file as lines, to show more of it than the diff does.
pub const Text = struct {
    bytes: []const u8,
    /// Where each line starts; line n (from 1) starts at `starts[n - 1]`.
    starts: []const u32,
    pub fn count(self: Text) u32 {
        return @intCast(self.starts.len);
    }
    /// Line `number` (from 1) without its line ending; "" past the end.
    pub fn line(self: Text, number: u32) []const u8 {
        if (number == 0 or number > self.starts.len) return "";
        const start = self.starts[number - 1];
        const end = if (number < self.starts.len) self.starts[number] else self.bytes.len;
        return std.mem.trimEnd(u8, self.bytes[start..end], "\r\n");
    }
};
/// Both sides of a file, read whole: null for a side that does not exist
/// or could not be read. `binary` sides keep their bytes but no lines.
pub const Sides = struct {
    old: ?Text = null,
    new: ?Text = null,
    old_binary: bool = false,
    new_binary: bool = false,
    pub fn side(self: Sides, old: bool) ?Text {
        return if (old) self.old else self.new;
    }
};
/// Whether bytes look like a binary file, as Git decides: a NUL early on.
pub fn looksBinary(bytes: []const u8) bool {
    return std.mem.indexOfScalar(u8, bytes[0..@min(bytes.len, 8000)], 0) != null;
}
/// Splits bytes into lines: a final line ending ends the last line rather
/// than starting another, as Git counts them.
pub fn textOf(gpa: std.mem.Allocator, bytes: []const u8) !Text {
    var starts: std.ArrayList(u32) = .empty;
    var at: usize = 0;
    while (at < bytes.len) {
        try starts.append(gpa, @intCast(at));
        at = if (std.mem.indexOfScalarPos(u8, bytes, at, '\n')) |end| end + 1 else bytes.len;
    }
    return .{ .bytes = bytes, .starts = starts.items };
}
/// Lines of a file the diff leaves out, on the new side, `first` to `last`
/// (empty when `last < first`); the old side numbers them `delta` higher.
pub const Gap = struct {
    first: u32,
    last: u32,
    delta: i64,
    pub fn size(self: Gap) u32 {
        return if (self.last >= self.first) self.last - self.first + 1 else 0;
    }
};
/// Where a hunk's lines begin on each side (a side with none names the line
/// before them) and the first line after it.
fn bounds(header: []const u8) ?struct { old: u32, new: u32, old_end: u32, new_end: u32 } {
    const hunk = parseHunk(header) orelse return null;
    const old = if (hunk.old_count == 0) hunk.old_start + 1 else hunk.old_start;
    const new = if (hunk.new_count == 0) hunk.new_start + 1 else hunk.new_start;
    return .{ .old = old, .new = new, .old_end = old + hunk.old_count, .new_end = new + hunk.new_count };
}
/// The lines hidden above header `at` (between the rows before it and its
/// hunk), or, for a tail, after every row; `total` is the new side's length.
pub fn gapAt(rows: []const Row, at: usize, total: u32) ?Gap {
    if (at >= rows.len or !rows[at].meta) return null;
    var before: u32 = 0;
    var index = at;
    while (index > 0) {
        index -= 1;
        if (rows[index].new > 0) {
            before = rows[index].new;
            break;
        }
    }
    if (rows[at].tail) {
        // The tail follows the last hunk, whose end gives the offset.
        var header: ?usize = null;
        var back = at;
        while (back > 0) {
            back -= 1;
            if (rows[back].meta and !rows[back].tail) {
                header = back;
                break;
            }
        }
        const last = bounds(rows[header orelse return null].left) orelse return null;
        return .{ .first = before + 1, .last = total, .delta = @as(i64, last.old_end) - last.new_end };
    }
    const hunk = bounds(rows[at].left) orelse return null;
    var after: u32 = hunk.new;
    for (rows[at + 1 ..]) |row| {
        if (row.meta) break;
        if (row.new > 0) {
            after = row.new;
            break;
        }
    }
    return .{ .first = before + 1, .last = after -| 1, .delta = @as(i64, hunk.old) - hunk.new };
}
/// Rows with `count` more of the lines hidden above header `at` shown: from
/// the top of the gap (under the rows before it) or its bottom (over the
/// hunk). A tail with nothing left to show goes; a hunk's header stays, as
/// it names the hunk and carries its review. Returns null when nothing is
/// hidden there.
pub fn expand(gpa: std.mem.Allocator, rows: []const Row, at: usize, text: Text, count: u32, from_top: bool) !?[]Row {
    const gap = gapAt(rows, at, text.count()) orelse return null;
    const shown = @min(count, gap.size());
    if (shown == 0) return null;
    const first = if (from_top) gap.first else gap.last - shown + 1;
    var out: std.ArrayList(Row) = try .initCapacity(gpa, rows.len + shown);
    const position = if (from_top) at else at + 1;
    out.appendSliceAssumeCapacity(rows[0..position]);
    const hunk = if (from_top) (if (at > 0) rows[at - 1].hunk else rows[at].hunk) else rows[at].hunk;
    for (0..shown) |offset| {
        const new: u32 = first + @as(u32, @intCast(offset));
        const old: u32 = @intCast(std.math.clamp(@as(i64, new) + gap.delta, 1, std.math.maxInt(u32)));
        const content = text.line(new);
        out.appendAssumeCapacity(.{ .old = old, .new = new, .left = content, .right = content, .hunk = hunk, .expanded = true });
    }
    out.appendSliceAssumeCapacity(rows[position..]);
    // A tail whose lines are all shown has nothing left to stand for.
    if (rows[at].tail and shown == gap.size()) _ = out.orderedRemove(if (from_top) at + shown else at);
    offsets(out.items);
    return out.items;
}
/// A header after the last hunk standing for the rest of the file, when
/// the diff stops before the file does.
pub fn withTail(gpa: std.mem.Allocator, rows: []const Row, total: u32) ![]Row {
    var last_new: u32 = 0;
    var any = false;
    for (rows) |row| {
        if (row.new > 0) last_new = row.new;
        any = any or (row.meta and !row.tail);
        if (row.tail) return @constCast(rows);
    }
    if (!any or last_new >= total) return @constCast(rows);
    var out: std.ArrayList(Row) = try .initCapacity(gpa, rows.len + 1);
    out.appendSliceAssumeCapacity(rows);
    const hunk = if (rows.len > 0) rows[rows.len - 1].hunk else 0;
    out.appendAssumeCapacity(.{ .meta = true, .tail = true, .hunk = hunk, .left = "", .right = "" });
    offsets(out.items);
    return out.items;
}

/// A block of lines a diff removed in one place and added, unchanged but
/// for indentation, in another (of the same file or another file).
pub const Move = struct { from_file: u32, from_line: u32, to_file: u32, to_line: u32, lines: u32 };
const Line = struct { file: u32, row: u32, block: u32, hash: u64, weight: u32 };
fn lineHash(text: []const u8) struct { hash: u64, weight: u32 } {
    const trimmed = std.mem.trim(u8, text, " \t\r");
    var weight: u32 = 0;
    for (trimmed) |char| weight += @intFromBool(char != ' ' and char != '\t');
    return .{ .hash = std.hash.Wyhash.hash(0, trimmed), .weight = weight };
}
/// Finds blocks of at least three lines (and some substance) that the diff
/// removed in one place and added in another, as Git's `--color-moved`
/// does, ignoring indentation. A replacement in place is an edit, not a
/// move. Marks the rows on both sides and returns the moves; split rows are
/// paired again so they carry the marks too.
pub fn findMoves(gpa: std.mem.Allocator, files: []File) ![]Move {
    var removed: std.ArrayList(Line) = .empty;
    var added: std.ArrayList(Line) = .empty;
    defer removed.deinit(gpa);
    defer added.deinit(gpa);
    for (files, 0..) |file, file_index| {
        if (file.message) continue;
        // Each run of changed lines between context lines is one block.
        var block: u32 = 0;
        var in_change = false;
        for (file.unified, 0..) |row, index| {
            const changed = !row.meta and (row.removed or row.added);
            if (changed and !in_change) block += 1;
            in_change = changed;
            if (!changed) continue;
            const line = lineHash(if (row.removed) row.left else row.right);
            const entry = Line{ .file = @intCast(file_index), .row = @intCast(index), .block = block, .hash = line.hash, .weight = line.weight };
            try (if (row.removed) &removed else &added).append(gpa, entry);
        }
    }
    if (removed.items.len == 0 or added.items.len == 0) return &.{};
    var by_hash: std.AutoHashMapUnmanaged(u64, std.ArrayList(u32)) = .empty;
    defer {
        var values = by_hash.valueIterator();
        while (values.next()) |list| list.deinit(gpa);
        by_hash.deinit(gpa);
    }
    for (added.items, 0..) |line, index| {
        if (line.weight == 0) continue;
        const slot = try by_hash.getOrPut(gpa, line.hash);
        if (!slot.found_existing) slot.value_ptr.* = .empty;
        if (slot.value_ptr.items.len < 64) try slot.value_ptr.append(gpa, @intCast(index));
    }
    const taken_removed = try gpa.alloc(bool, removed.items.len);
    defer gpa.free(taken_removed);
    @memset(taken_removed, false);
    const taken_added = try gpa.alloc(bool, added.items.len);
    defer gpa.free(taken_added);
    @memset(taken_added, false);
    var moves: std.ArrayList(Move) = .empty;
    var i: usize = 0;
    while (i < removed.items.len) : (i += 1) {
        if (taken_removed[i] or removed.items[i].weight == 0) continue;
        const candidates = by_hash.get(removed.items[i].hash) orelse continue;
        var best_length: usize = 0;
        var best_start: usize = 0;
        for (candidates.items) |candidate| {
            const j: usize = candidate;
            if (taken_added[j]) continue;
            const from = removed.items[i];
            const to = added.items[j];
            if (from.file == to.file and from.block == to.block) continue;
            var length: usize = 0;
            while (i + length < removed.items.len and j + length < added.items.len) : (length += 1) {
                const a = removed.items[i + length];
                const b = added.items[j + length];
                if (a.file != from.file or a.row != from.row + length or b.file != to.file or b.row != to.row + length) break;
                if (a.hash != b.hash or taken_removed[i + length] or taken_added[j + length]) break;
            }
            if (length > best_length) {
                best_length = length;
                best_start = j;
            }
        }
        var weight: u32 = 0;
        for (removed.items[i .. i + best_length]) |line| weight += line.weight;
        if (best_length < 3 or weight < 24) continue;
        const id: u32 = @intCast(moves.items.len + 1);
        const from = removed.items[i];
        const to = added.items[best_start];
        try moves.append(gpa, .{ .from_file = from.file, .from_line = files[from.file].unified[from.row].old, .to_file = to.file, .to_line = files[to.file].unified[to.row].new, .lines = @intCast(best_length) });
        for (0..best_length) |offset| {
            taken_removed[i + offset] = true;
            taken_added[best_start + offset] = true;
            files[from.file].unified[from.row + offset].moved_old = id;
            files[to.file].unified[to.row + offset].moved_new = id;
        }
        i += best_length - 1;
    }
    if (moves.items.len > 0) for (files) |*file| {
        var marked = false;
        for (file.unified) |row| marked = marked or row.moved_old != 0 or row.moved_new != 0;
        if (marked) file.split = try pair(gpa, file.unified);
    };
    return moves.items;
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

test "a hunk's hidden lines show from either end of the gap" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var source: std.ArrayList(u8) = .empty;
    for (1..31) |n| try source.print(alloc, "line {d}\n", .{n});
    const text = try textOf(alloc, source.items);
    try std.testing.expectEqual(@as(u32, 30), text.count());
    try std.testing.expectEqualStrings("line 30", text.line(30));
    // Line 10 rewritten and line 20 removed; two context lines each side.
    const files = try parse(alloc, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -8,5 +8,5 @@ fn top\n line 8\n line 9\n-old 10\n+line 10\n line 11\n line 12\n@@ -18,5 +18,4 @@\n line 18\n line 19\n-line 20\n line 21\n line 22\n");
    var rows = try withTail(alloc, files[0].unified, text.count());
    try std.testing.expect(rows[rows.len - 1].tail);
    try std.testing.expectEqual(@as(u16, 1), rows[rows.len - 1].hunk);
    const first = gapAt(rows, 0, text.count()).?;
    try std.testing.expectEqual(@as(u32, 1), first.first);
    try std.testing.expectEqual(@as(u32, 7), first.last);
    const second_header = 7;
    try std.testing.expect(rows[second_header].meta);
    const middle = gapAt(rows, second_header, text.count()).?;
    try std.testing.expectEqual(@as(u32, 13), middle.first);
    try std.testing.expectEqual(@as(u32, 17), middle.last);
    // Two lines from the top of the middle gap, then the rest from below.
    rows = (try expand(alloc, rows, second_header, text, 2, true)).?;
    try std.testing.expectEqual(@as(u32, 13), rows[second_header].new);
    try std.testing.expect(rows[second_header].expanded);
    try std.testing.expectEqual(@as(u16, 0), rows[second_header].hunk);
    try std.testing.expect(rows[second_header + 2].meta);
    rows = (try expand(alloc, rows, second_header + 2, text, 50, false)).?;
    try std.testing.expectEqual(@as(u32, 0), gapAt(rows, second_header + 2, text.count()).?.size());
    try std.testing.expectEqual(@as(u32, 15), rows[second_header + 3].new);
    try std.testing.expectEqual(@as(u32, 15), rows[second_header + 3].old);
    // The tail: lines 22-30, the old side one line further on.
    const tail = rows.len - 1;
    const rest = gapAt(rows, tail, text.count()).?;
    try std.testing.expectEqual(@as(u32, 22), rest.first);
    try std.testing.expectEqual(@as(i64, 1), rest.delta);
    rows = (try expand(alloc, rows, tail, text, 100, true)).?;
    try std.testing.expect(!rows[rows.len - 1].meta);
    try std.testing.expectEqual(@as(u32, 30), rows[rows.len - 1].new);
    try std.testing.expectEqual(@as(u32, 31), rows[rows.len - 1].old);
    try std.testing.expect(try expand(alloc, rows, second_header + 2, text, 5, true) == null);
}

test "hunks are numbered and each has its own change" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const files = try parse(arena.allocator(), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9,2 +9,2 @@\n y\n-b\n+c\n");
    try std.testing.expectEqual(@as(usize, 2), files[0].hunks.len);
    // The same lines changed the same way are the same change, wherever.
    try std.testing.expectEqualSlices(u8, &files[0].hunks[0].change, &files[0].hunks[1].change);
    try std.testing.expectEqual(@as(u16, 1), files[0].unified[4].hunk);
    try std.testing.expectEqual(@as(u16, 1), files[0].split[files[0].split.len - 1].hunk);
}

test "blocks moved between places are found, and edits in place are not" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const files = try parse(alloc, "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,6 +1,2 @@\n x = 1\n-def helper(a, b):\n-    total = a + b\n-    return total * 2\n y = 2\n-z = 3\n+z = 4\n" ++
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1,2 +1,5 @@\n q = 1\n+class K:\n+    def helper(a, b):\n+        total = a + b\n+        return total * 2\n r = 2\n");
    const moves = try findMoves(alloc, files);
    try std.testing.expectEqual(@as(usize, 1), moves.len);
    try std.testing.expectEqual(Move{ .from_file = 0, .from_line = 2, .to_file = 1, .to_line = 3, .lines = 3 }, moves[0]);
    try std.testing.expectEqual(@as(u32, 1), files[0].unified[2].moved_old);
    try std.testing.expectEqual(@as(u32, 0), files[1].unified[2].moved_new);
    try std.testing.expectEqual(@as(u32, 1), files[1].unified[3].moved_new);
    // Split rows carry the marks on their side.
    var found = false;
    for (files[1].split) |row| found = found or row.moved_new == 1;
    try std.testing.expect(found);
}

test "a listed file reads whole, or as binary" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var file = listedFile("src/a.zig");
    try std.testing.expect(file.unread and file.collapsed and file.reference);
    try readListed(arena.allocator(), &file, "one\ntwo\n");
    try std.testing.expect(!file.unread and !file.binary);
    try std.testing.expectEqual(@as(usize, 2), file.unified.len);
    try std.testing.expectEqual(@as(u32, 2), file.unified[1].new);
    try std.testing.expectEqualStrings("two", file.unified[1].right);
    var picture = listedFile("logo.png");
    try readListed(arena.allocator(), &picture, "\x89PNG\x00\x00");
    try std.testing.expect(picture.binary and picture.unified.len == 0);
}

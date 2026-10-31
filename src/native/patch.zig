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
};
pub const File = struct {
    path: []const u8,
    previous: []const u8 = "",
    status: enum { modified, added, deleted, renamed } = .modified,
    additions: u32 = 0,
    deletions: u32 = 0,
    unified: []const Row,
    split: []const Row,
    reviewed: bool = false,
    /// Only the header shows; reviewed files fold away so large reviews stay navigable.
    collapsed: bool = false,
};

fn path(raw: []const u8) []const u8 {
    var value = std.mem.trim(u8, raw, "\r\n\t\"");
    if (std.mem.startsWith(u8, value, "a/") or std.mem.startsWith(u8, value, "b/")) value = value[2..];
    return value;
}

fn pair(gpa: std.mem.Allocator, unified: []const Row) ![]const Row {
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

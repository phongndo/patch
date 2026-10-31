const std = @import("std");
const patch = @import("patch.zig");

pub const Bytes = struct { start: usize, end: usize };
pub const Range = struct {
    file: usize,
    old: bool,
    anchor: usize,
    focus: usize,
    anchor_line: u32 = 0,
    first_line: u32,
    last_line: u32,
    bytes: ?Bytes = null,
    pub fn contains(self: Range, file: usize, old: bool, row: usize) bool {
        return self.file == file and self.old == old and row >= @min(self.anchor, self.focus) and row <= @max(self.anchor, self.focus);
    }
};
pub const Hit = struct { file: usize, row: usize, old: bool, line: u32 };
pub const Phase = enum { down, move, up, cancel };
pub const Pointer = struct { phase: Phase, hit: ?Hit, x: f32, y: f32, shift: bool = false, clicks: u8 = 1, native_bytes: ?Bytes = null };
pub const State = struct {
    range: ?Range = null,
    dragging: bool = false,
    active: bool = false,
    down_x: f32 = 0,
    down_y: f32 = 0,
    pub fn apply(self: *State, event: Pointer) void {
        switch (event.phase) {
            .down => {
                const hit = event.hit orelse return;
                const extend = event.shift and self.range != null and self.range.?.file == hit.file and self.range.?.old == hit.old;
                if (extend) {
                    self.range.?.focus = hit.row;
                    self.range.?.first_line = @min(self.range.?.anchor_line, hit.line);
                    self.range.?.last_line = @max(self.range.?.anchor_line, hit.line);
                    self.range.?.bytes = null;
                } else self.range = .{ .file = hit.file, .old = hit.old, .anchor = hit.row, .focus = hit.row, .anchor_line = hit.line, .first_line = hit.line, .last_line = hit.line };
                self.active = extend or event.clicks > 1;
                self.dragging = true;
                self.down_x = event.x;
                self.down_y = event.y;
            },
            .move, .up => {
                if (!self.dragging) return;
                if (event.hit) |hit| {
                    if (self.range) |*range| if (range.file == hit.file and range.old == hit.old) {
                        range.focus = hit.row;
                        range.first_line = @min(range.anchor_line, hit.line);
                        range.last_line = @max(range.anchor_line, hit.line);
                        if (@abs(event.x - self.down_x) > 3 or @abs(event.y - self.down_y) > 3 or range.anchor != range.focus) self.active = true;
                    };
                }
                if (event.phase == .up) {
                    self.dragging = false;
                    if (self.range) |*range| range.bytes = event.native_bytes;
                }
            },
            .cancel => self.dragging = false,
        }
    }
    pub fn clear(self: *State) void {
        self.* = .{};
    }
};
pub fn groupId(file: usize, old: bool, epoch: usize, generation: usize) u64 {
    const values = [_]u64{ file, @intFromBool(old), epoch, generation };
    return std.hash.Wyhash.hash(0x70617463682d7465, std.mem.asBytes(&values)) | 1;
}
pub fn copy(allocator: std.mem.Allocator, file: patch.File, range: Range) ![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    errdefer output.deinit();
    for (file.unified) |row| {
        const line = if (range.old) row.old else row.new;
        if (row.meta or line == 0 or line < range.first_line or line > range.last_line) continue;
        const source = if (range.old) row.left else row.right;
        if (range.bytes) |bytes| {
            const offset = if (range.old) row.old_offset else row.new_offset;
            if (offset >= bytes.end or offset + source.len + 1 <= bytes.start) continue;
            const first = bytes.start -| offset;
            const end = @min(source.len, bytes.end -| offset);
            if (first < end) try output.writer.writeAll(source[first..end]);
            if (bytes.end > offset + source.len and bytes.start <= offset + source.len) try output.writer.writeByte('\n');
        } else {
            try output.writer.writeAll(source);
            try output.writer.writeByte('\n');
        }
    }
    return output.toOwnedSlice();
}

test "drag ranges stay within their file and side, and shift extends" {
    var state = State{};
    state.apply(.{ .phase = .down, .hit = .{ .file = 0, .row = 2, .old = false, .line = 10 }, .x = 20, .y = 20 });
    state.apply(.{ .phase = .move, .hit = .{ .file = 0, .row = 5, .old = false, .line = 13 }, .x = 80, .y = 100 });
    state.apply(.{ .phase = .up, .hit = .{ .file = 1, .row = 9, .old = false, .line = 1 }, .x = 80, .y = 150 });
    try std.testing.expect(state.active and !state.dragging);
    try std.testing.expectEqual(@as(u32, 13), state.range.?.last_line);
    state.apply(.{ .phase = .down, .hit = .{ .file = 0, .row = 7, .old = false, .line = 15 }, .x = 20, .y = 150, .shift = true });
    try std.testing.expectEqual(@as(usize, 2), state.range.?.anchor);
    try std.testing.expect(state.range.?.contains(0, false, 6));
    try std.testing.expect(!state.range.?.contains(0, true, 6));
}
test "copy preserves side, line spans, Unicode, and exact native byte selection" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const files = try patch.parse(arena.allocator(), "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+λ new\n context\n");
    var range = Range{ .file = 0, .old = false, .anchor = 1, .focus = 2, .first_line = 1, .last_line = 2 };
    const text = try copy(arena.allocator(), files[0], range);
    try std.testing.expectEqualStrings("λ new\ncontext\n", text);
    range.bytes = .{ .start = 3, .end = 6 };
    try std.testing.expectEqualStrings("new", try copy(arena.allocator(), files[0], range));
    range.old = true;
    range.bytes = null;
    try std.testing.expectEqualStrings("old\ncontext\n", try copy(arena.allocator(), files[0], range));
}

test "ranges shrink and reverse around their original anchor" {
    var state = State{};
    state.apply(.{ .phase = .down, .hit = .{ .file = 0, .row = 5, .old = false, .line = 15 }, .x = 20, .y = 100 });
    state.apply(.{ .phase = .move, .hit = .{ .file = 0, .row = 2, .old = false, .line = 12 }, .x = 20, .y = 28 });
    try std.testing.expectEqual(@as(u32, 12), state.range.?.first_line);
    state.apply(.{ .phase = .move, .hit = .{ .file = 0, .row = 4, .old = false, .line = 14 }, .x = 20, .y = 76 });
    try std.testing.expectEqual(@as(u32, 14), state.range.?.first_line);
    state.apply(.{ .phase = .up, .hit = .{ .file = 0, .row = 7, .old = false, .line = 17 }, .x = 20, .y = 148 });
    try std.testing.expectEqual(@as(u32, 15), state.range.?.first_line);
    try std.testing.expectEqual(@as(u32, 17), state.range.?.last_line);
    state.apply(.{ .phase = .down, .hit = .{ .file = 0, .row = 3, .old = false, .line = 13 }, .x = 20, .y = 52, .shift = true });
    try std.testing.expectEqual(@as(u32, 13), state.range.?.first_line);
    try std.testing.expectEqual(@as(u32, 15), state.range.?.last_line);
}

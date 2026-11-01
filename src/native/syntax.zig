const std = @import("std");
const canvas = @import("native_sdk").canvas;
const patch = @import("patch.zig");

pub const Language = canvas.code.Language;
pub const State = canvas.code.HighlightState;

/// Extensions the SDK's lexers suit but its names leave out. C++, Objective-C,
/// CUDA, shaders and TableGen read well as C; the rest are variants.
const extensions = .{
    .{ ".hpp", .c_like },     .{ ".hh", .c_like },      .{ ".hxx", .c_like },  .{ ".h++", .c_like },
    .{ ".cxx", .c_like },     .{ ".inl", .c_like },     .{ ".ipp", .c_like },  .{ ".tpp", .c_like },
    .{ ".cu", .c_like },      .{ ".cuh", .c_like },     .{ ".m", .c_like },    .{ ".mm", .c_like },
    .{ ".metal", .c_like },   .{ ".glsl", .c_like },    .{ ".hlsl", .c_like }, .{ ".td", .c_like },
    .{ ".kt", .c_like },      .{ ".kts", .c_like },     .{ ".zon", .zig },     .{ ".cjs", .javascript },
    .{ ".mts", .typescript }, .{ ".cts", .typescript }, .{ ".pyi", .python },  .{ ".htm", .html },
};
pub fn languageFor(path: []const u8) Language {
    const ext = std.fs.path.extension(path);
    if (ext.len < 2) return .plain;
    inline for (extensions) |entry| if (std.mem.eql(u8, ext, entry[0])) return entry[1];
    return canvas.code.languageFromName(ext[1..]);
}

/// Languages whose `/* … */` comments can open before a hunk does.
fn blockComments(language: Language) bool {
    return switch (language) {
        .c_like, .javascript, .typescript, .jsx, .tsx, .rust, .go, .css, .sql => true,
        else => false,
    };
}

/// Interned lexer states: rows keep a u16 index, and nearly every line starts
/// in one of a few states. Past `max_states`, further lines start fresh.
const max_states = 1024;
const Table = struct {
    states: std.ArrayList(State) = .empty,
    last: u16 = 0,
    fn intern(self: *Table, alloc: std.mem.Allocator, state: State) u16 {
        if (std.meta.eql(self.states.items[self.last], state)) return self.last;
        for (self.states.items, 0..) |known, index| if (std.meta.eql(known, state)) {
            self.last = @intCast(index);
            return self.last;
        };
        if (self.states.items.len >= max_states) return 0;
        self.states.append(alloc, state) catch return 0;
        self.last = @intCast(self.states.items.len - 1);
        return self.last;
    }
};

/// Gives each row the lexer state its lines start in, so a comment or string
/// spanning lines keeps its color; the view draws each line on its own. Each
/// side of a hunk is lexed from the hunk's top, as no earlier source is at
/// hand; a side whose first comment delimiter closes one starts inside it.
/// Rows store indices into the returned table, where 0 is the fresh state.
pub fn carryStates(alloc: std.mem.Allocator, files: []patch.File) ![]const State {
    var table: Table = .{};
    try table.states.append(alloc, .{});
    var storage: [canvas.max_text_spans_per_paragraph]canvas.TextSpan = undefined;
    for (files) |file| {
        const language = languageFor(file.path);
        if (language == .plain) continue;
        for ([_]bool{ true, false }) |old| {
            lexSide(alloc, &table, file.unified, language, old, &storage);
            copySide(file.unified, file.split, old);
        }
    }
    return table.states.items;
}
fn lexSide(alloc: std.mem.Allocator, table: *Table, rows: []patch.Row, language: Language, old: bool, storage: *[canvas.max_text_spans_per_paragraph]canvas.TextSpan) void {
    var state: State = .{};
    for (rows, 0..) |*row, index| {
        if (row.meta) {
            state = .{};
            state.block_comment = blockComments(language) and patch.startsInBlockComment(rows[index + 1 ..], old);
            continue;
        }
        if ((if (old) row.old else row.new) == 0) continue;
        const carry = table.intern(alloc, state);
        if (old) row.old_carry = carry else row.new_carry = carry;
        // The view lexes each line with its newline, which ends line comments.
        _ = canvas.code.highlightWithState(if (old) row.left else row.right, language, storage, &state);
        _ = canvas.code.highlightWithState("\n", language, storage, &state);
    }
}
/// Split rows hold each side's lines in the same order as unified rows
/// (pairing only lines removed runs up beside added ones), so the states
/// copy across in step.
fn copySide(unified: []const patch.Row, split: []patch.Row, old: bool) void {
    var source: usize = 0;
    for (split) |*row| {
        if (row.meta or (if (old) row.old else row.new) == 0) continue;
        while (source < unified.len and (unified[source].meta or (if (old) unified[source].old else unified[source].new) == 0)) source += 1;
        if (source == unified.len) return;
        if (old) row.old_carry = unified[source].old_carry else row.new_carry = unified[source].new_carry;
        source += 1;
    }
}

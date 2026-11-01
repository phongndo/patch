//! What changed inside a line that was edited: the two versions split into
//! tokens (words, numbers, single punctuation marks, runs of space) and
//! compared token by token, so `foo(a, b)` → `foo(a, c, b)` marks only the
//! `c, ` that was added rather than everything between the first and last
//! difference.
const std = @import("std");

/// A changed run: bytes [start, end) of one side's text.
pub const Range = struct { start: usize = 0, end: usize = 0 };
pub const max_ranges = 8;
/// The changed runs on one side, at most `max_ranges` (more read as a rewrite).
pub const Runs = struct {
    ranges: [max_ranges]Range = undefined,
    len: usize = 0,
    pub fn slice(self: *const Runs) []const Range {
        return self.ranges[0..self.len];
    }
};
pub const Pair = struct { old: Runs = .{}, new: Runs = .{} };

const max_tokens = 256;
const Token = struct { start: u32, end: u32 };
fn kind(char: u8) u2 {
    if (char == ' ' or char == '\t') return 0;
    if (std.ascii.isAlphanumeric(char) or char == '_' or char >= 0x80) return 1;
    return 2;
}
/// Splits a line into tokens; null when it has too many to compare.
fn tokenize(text: []const u8, out: *[max_tokens]Token) ?[]Token {
    var count: usize = 0;
    var at: usize = 0;
    while (at < text.len) {
        if (count == max_tokens) return null;
        const start = at;
        const class = kind(text[at]);
        at += 1;
        // Words and spaces run on; punctuation stands alone.
        if (class != 2) while (at < text.len and kind(text[at]) == class) : (at += 1) {};
        out[count] = .{ .start = @intCast(start), .end = @intCast(at) };
        count += 1;
    }
    return out[0..count];
}
fn same(a_text: []const u8, a: Token, b_text: []const u8, b: Token) bool {
    return std.mem.eql(u8, a_text[a.start..a.end], b_text[b.start..b.end]);
}
/// Marks tokens outside the longest common subsequence as changed, merges
/// neighbouring changes (and the spaces between them), and gives up (no
/// runs) on a side that mostly changed, which reads better as a whole-line
/// wash.
pub fn diff(old: []const u8, new: []const u8) Pair {
    var old_storage: [max_tokens]Token = undefined;
    var new_storage: [max_tokens]Token = undefined;
    const a = tokenize(old, &old_storage) orelse return .{};
    const b = tokenize(new, &new_storage) orelse return .{};
    if (a.len == 0 or b.len == 0) return .{};
    // Common prefix and suffix first; the table covers only the middle.
    var prefix: usize = 0;
    while (prefix < a.len and prefix < b.len and same(old, a[prefix], new, b[prefix])) prefix += 1;
    var suffix: usize = 0;
    while (suffix < a.len - prefix and suffix < b.len - prefix and same(old, a[a.len - 1 - suffix], new, b[b.len - 1 - suffix])) suffix += 1;
    const am = a[prefix .. a.len - suffix];
    const bm = b[prefix .. b.len - suffix];
    var keep_a: [max_tokens]bool = @splat(false);
    var keep_b: [max_tokens]bool = @splat(false);
    if (am.len > 0 and bm.len > 0) {
        // lengths[i][j]: LCS of am[i..] and bm[j..].
        var lengths: [(max_tokens + 1) * (max_tokens + 1)]u16 = undefined;
        const width = bm.len + 1;
        var i = am.len + 1;
        while (i > 0) {
            i -= 1;
            var j = bm.len + 1;
            while (j > 0) {
                j -= 1;
                lengths[i * width + j] = if (i == am.len or j == bm.len) 0 else if (same(old, am[i], new, bm[j])) lengths[(i + 1) * width + j + 1] + 1 else @max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
            }
        }
        var x: usize = 0;
        var y: usize = 0;
        while (x < am.len and y < bm.len) {
            if (same(old, am[x], new, bm[y])) {
                keep_a[x] = true;
                keep_b[y] = true;
                x += 1;
                y += 1;
            } else if (lengths[(x + 1) * width + y] >= lengths[x * width + y + 1]) x += 1 else y += 1;
        }
    }
    return .{ .old = runs(old, am, keep_a[0..am.len]), .new = runs(new, bm, keep_b[0..bm.len]) };
}
fn runs(text: []const u8, tokens: []const Token, keep: []const bool) Runs {
    var result: Runs = .{};
    var changed: usize = 0;
    var index: usize = 0;
    while (index < tokens.len) {
        if (keep[index]) {
            index += 1;
            continue;
        }
        var end = index;
        // A run takes in kept spaces between changed tokens.
        while (end < tokens.len and (!keep[end] or (kind(text[tokens[end].start]) == 0 and end + 1 < tokens.len and !keep[end + 1]))) end += 1;
        const range = Range{ .start = tokens[index].start, .end = tokens[end - 1].end };
        changed += range.end - range.start;
        if (result.len == max_ranges) return .{};
        result.ranges[result.len] = range;
        result.len += 1;
        index = end;
    }
    // A line mostly rewritten keeps only its wash.
    const visible = std.mem.trim(u8, text, " \t").len;
    if (visible < 4 or changed * 10 > visible * 7) return .{};
    return result;
}

test "an argument added in the middle marks only itself" {
    const pair = diff("call(a, b);", "call(a, c, b);");
    try std.testing.expectEqual(@as(usize, 0), pair.old.len);
    try std.testing.expectEqual(@as(usize, 1), pair.new.len);
    const range = pair.new.ranges[0];
    try std.testing.expectEqualStrings("c, ", "call(a, c, b);"[range.start..range.end]);
}
test "two separate edits mark two runs, and a rewrite marks none" {
    const pair = diff("const width = left + 10;", "const height = left + 12;");
    try std.testing.expectEqual(@as(usize, 2), pair.new.len);
    try std.testing.expectEqualStrings("height", "const height = left + 12;"[pair.new.ranges[0].start..pair.new.ranges[0].end]);
    try std.testing.expectEqualStrings("12", "const height = left + 12;"[pair.new.ranges[1].start..pair.new.ranges[1].end]);
    const rewrite = diff("return a;", "throw new Error(\"no\");");
    try std.testing.expectEqual(@as(usize, 0), rewrite.old.len);
    try std.testing.expectEqual(@as(usize, 0), rewrite.new.len);
}

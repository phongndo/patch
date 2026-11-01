//! Placeholder for the tree-sitter highlighter: same API, no languages.
const std = @import("std");
pub const Kind = enum(u8) { plain = 0, comment, keyword, string, function, property, constant, type };
pub const Token = struct { start: u32, end: u32, kind: Kind };
pub const Highlights = struct {
    tokens: []const Token,
    lines: []const u32,
    pub fn line(self: Highlights, index: usize) []const Token {
        if (index + 1 >= self.lines.len) return &.{};
        return self.tokens[self.lines[index]..self.lines[index + 1]];
    }
};
pub const Language = enum { none };
pub fn languageFor(path: []const u8) ?Language {
    _ = path;
    return null;
}
pub fn highlight(alloc: std.mem.Allocator, language: Language, source: []const u8) !Highlights {
    _ = alloc;
    _ = language;
    _ = source;
    return error.Unsupported;
}

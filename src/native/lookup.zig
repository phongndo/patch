//! Questions a reviewer asks of the code around a change: who last touched
//! a line and why (`git blame`), and where a name is defined and used
//! (`git grep`). This module reads Git's answers; main.zig asks them off the
//! main thread.
const std = @import("std");

/// The commit that last changed one line, as `git blame --porcelain` says.
pub const Blame = struct {
    commit: []const u8 = "",
    author: []const u8 = "",
    time: i64 = 0,
    summary: []const u8 = "",
    /// The line has not been committed (Git's all-zero id).
    uncommitted: bool = false,
};
/// Reads the first entry of `git blame --porcelain` output. Slices point
/// into `output`.
pub fn parseBlame(output: []const u8) ?Blame {
    var lines = std.mem.splitScalar(u8, output, '\n');
    const first = lines.next() orelse return null;
    const space = std.mem.indexOfScalar(u8, first, ' ') orelse return null;
    const commit = first[0..space];
    if (commit.len < 7) return null;
    var blame = Blame{ .commit = commit, .uncommitted = std.mem.trim(u8, commit, "0").len == 0 };
    while (lines.next()) |line| {
        if (line.len > 0 and line[0] == '\t') break;
        if (std.mem.startsWith(u8, line, "author ")) blame.author = line[7..];
        if (std.mem.startsWith(u8, line, "author-time ")) blame.time = std.fmt.parseInt(i64, line[12..], 10) catch 0;
        if (std.mem.startsWith(u8, line, "summary ")) blame.summary = line[8..];
    }
    return blame;
}
/// How long ago a moment was, as a person says it: "just now", "5 minutes
/// ago", "3 months ago".
pub fn ago(buffer: []u8, then: i64, now: i64) []const u8 {
    const seconds = @max(0, now - then);
    const units = [_]struct { size: i64, name: []const u8 }{
        .{ .size = 365 * 86400, .name = "year" },
        .{ .size = 30 * 86400, .name = "month" },
        .{ .size = 7 * 86400, .name = "week" },
        .{ .size = 86400, .name = "day" },
        .{ .size = 3600, .name = "hour" },
        .{ .size = 60, .name = "minute" },
    };
    for (units) |unit| if (seconds >= unit.size) {
        const count = @divTrunc(seconds, unit.size);
        return std.fmt.bufPrint(buffer, "{d} {s}{s} ago", .{ count, unit.name, if (count == 1) "" else "s" }) catch "";
    };
    return "just now";
}

/// One line `git grep` found: where, and what it says.
pub const Hit = struct {
    path: []const u8,
    line: u32,
    text: []const u8,
    /// The line seems to define the name rather than use it.
    definition: bool = false,
};
/// Reads `git grep -n` output (`path:line:text`, or `rev:path:line:text`
/// when a revision was searched, whose prefix is `strip`), marking the lines
/// that look like definitions of `name`. Slices point into `output`.
pub fn parseGrep(gpa: std.mem.Allocator, output: []const u8, strip: []const u8, name: []const u8, limit: usize) ![]Hit {
    var hits: std.ArrayList(Hit) = .empty;
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |raw| {
        if (hits.items.len >= limit) break;
        var line = raw;
        if (strip.len > 0 and std.mem.startsWith(u8, line, strip) and line.len > strip.len and line[strip.len] == ':') line = line[strip.len + 1 ..];
        // path:line:text — paths may hold colons, so find ":<digits>:".
        var at: usize = 0;
        const found = while (std.mem.indexOfScalarPos(u8, line, at, ':')) |colon| {
            var end = colon + 1;
            while (end < line.len and std.ascii.isDigit(line[end])) end += 1;
            if (end > colon + 1 and end < line.len and line[end] == ':') break .{ colon, end };
            at = colon + 1;
        } else null;
        const split = found orelse continue;
        const number = std.fmt.parseInt(u32, line[split[0] + 1 .. split[1]], 10) catch continue;
        const text = line[split[1] + 1 ..];
        try hits.append(gpa, .{ .path = line[0..split[0]], .line = number, .text = text, .definition = defines(text, name) });
    }
    // Definitions first, each group in Git's order (by path, then line).
    std.mem.sort(Hit, hits.items, {}, struct {
        fn less(_: void, a: Hit, b: Hit) bool {
            return a.definition and !b.definition;
        }
    }.less);
    return hits.items;
}
const introducers = [_][]const u8{ "fn", "def", "function", "func", "class", "struct", "enum", "union", "interface", "type", "trait", "impl", "module", "mod", "const", "let", "var", "val", "macro", "#define", "protocol", "extension", "record", "object", "typedef", "using", "namespace", "package", "alias" };
/// Whether a line seems to define `name`: a keyword that introduces a
/// definition right before it (`fn name`, `class name`, `const name`), a
/// Go method (`func (r T) name`), or `name :=` / `name =` / `name:` at the
/// start of the line.
pub fn defines(text: []const u8, name: []const u8) bool {
    if (name.len == 0) return false;
    var search: usize = 0;
    while (std.mem.indexOfPos(u8, text, search, name)) |at| {
        search = at + 1;
        const end = at + name.len;
        if ((at > 0 and isWord(text[at - 1])) or (end < text.len and isWord(text[end]))) continue;
        const before = std.mem.trimEnd(u8, text[0..at], " \t*&");
        // The word before the name.
        var word_start = before.len;
        while (word_start > 0 and (isWord(before[word_start - 1]) or before[word_start - 1] == '#')) word_start -= 1;
        const word = before[word_start..];
        for (introducers) |keyword| if (std.mem.eql(u8, word, keyword)) return true;
        // Go: func (r *T) name(
        if (std.mem.endsWith(u8, before, ")") and std.mem.startsWith(u8, std.mem.trimStart(u8, before, " \t"), "func (")) return true;
        // name := …, or name = … / name: … opening the line.
        const after = std.mem.trimStart(u8, text[end..], " \t");
        if (std.mem.startsWith(u8, after, ":=")) return true;
        if (std.mem.trim(u8, before, " \t").len == 0 and (std.mem.startsWith(u8, after, "= ") or (std.mem.startsWith(u8, after, ":") and !std.mem.startsWith(u8, after, "::")))) return true;
    }
    return false;
}
pub fn isWord(char: u8) bool {
    return std.ascii.isAlphanumeric(char) or char == '_' or char == '$';
}
const keywords = [_][]const u8{ "fn", "def", "function", "func", "class", "struct", "enum", "union", "interface", "type", "trait", "impl", "module", "const", "let", "var", "val", "pub", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch", "true", "false", "null", "undefined", "self", "this", "new", "import", "export", "from", "async", "await", "static", "public", "private", "protected", "void", "int", "u8", "u32", "usize", "bool", "string", "str", "and", "or", "not", "in", "is", "as", "with", "match", "defer", "errdefer", "inline", "comptime", "extern", "export", "package", "use", "mut", "ref", "go", "range", "nil", "None", "True", "False", "elif", "lambda", "yield", "throw", "throws", "default", "do", "end", "then", "local", "unsigned", "signed", "char", "float", "double", "long", "short", "auto", "typename", "template", "namespace", "using", "std" };
/// The name on a line a reviewer most likely wants to look up: one that
/// line defines, else the first called name, else the first long name.
pub fn interestingName(text: []const u8) []const u8 {
    var first_long: []const u8 = "";
    var first_call: []const u8 = "";
    var at: usize = 0;
    while (at < text.len) {
        if (!isWord(text[at]) or std.ascii.isDigit(text[at])) {
            // Skip strings and line comments, whose words are not code.
            if (text[at] == '"' or text[at] == '\'' or text[at] == '`') {
                const quote = text[at];
                at += 1;
                while (at < text.len and text[at] != quote) : (at += 1) if (text[at] == '\\') {
                    at += 1;
                };
                at += 1;
                continue;
            }
            if (std.mem.startsWith(u8, text[at..], "//") or text[at] == '#') break;
            at += 1;
            continue;
        }
        const start = at;
        while (at < text.len and isWord(text[at])) at += 1;
        const word = text[start..at];
        const keyword = for (keywords) |known| {
            if (std.mem.eql(u8, word, known)) break true;
        } else false;
        if (keyword or word.len < 2) continue;
        if (defines(text, word)) return word;
        if (first_call.len == 0 and at < text.len and text[at] == '(') first_call = word;
        if (first_long.len == 0 and word.len >= 3) first_long = word;
    }
    return if (first_call.len > 0) first_call else first_long;
}

test "blame porcelain gives the commit, its author, time and subject" {
    const output = "3a77da75cb7e132c2c487fe750b153fbc114803d 12 12 1\nauthor Ada Lovelace\nauthor-mail <ada@example.com>\nauthor-time 1700000000\nauthor-tz +0000\nsummary Teach the engine to loop\nfilename src/engine.zig\n\tfor (cards) |card| {\n";
    const blame = parseBlame(output).?;
    try std.testing.expectEqualStrings("Ada Lovelace", blame.author);
    try std.testing.expectEqual(@as(i64, 1700000000), blame.time);
    try std.testing.expectEqualStrings("Teach the engine to loop", blame.summary);
    try std.testing.expect(!blame.uncommitted);
    try std.testing.expect(parseBlame("0000000000000000000000000000000000000000 1 1 1\nauthor Not Committed Yet\n").?.uncommitted);
    var buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings("3 days ago", ago(&buffer, 0, 3 * 86400 + 5));
    try std.testing.expectEqualStrings("1 year ago", ago(&buffer, 0, 400 * 86400));
    try std.testing.expectEqualStrings("just now", ago(&buffer, 10, 20));
}
test "grep hits put definitions first and keep paths with colons" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const output = "main:src/a.zig:10:    const x = render(view);\nmain:src/b.zig:3:pub fn render(view: View) void {\nmain:odd:name.ts:7:function render() {}\n";
    const hits = try parseGrep(arena.allocator(), output, "main", "render", 10);
    try std.testing.expectEqual(@as(usize, 3), hits.len);
    try std.testing.expect(hits[0].definition and hits[1].definition and !hits[2].definition);
    try std.testing.expectEqualStrings("src/b.zig", hits[0].path);
    try std.testing.expectEqualStrings("odd:name.ts", hits[1].path);
    try std.testing.expectEqual(@as(u32, 10), hits[2].line);
}
test "definitions are told from uses" {
    try std.testing.expect(defines("pub fn render(view: View) void {", "render"));
    try std.testing.expect(defines("def render(self):", "render"));
    try std.testing.expect(defines("class Renderer extends Base {", "Renderer"));
    try std.testing.expect(defines("func (r *Repo) Load() error {", "Load"));
    try std.testing.expect(defines("count := 0", "count"));
    try std.testing.expect(defines("#define MAX 4", "MAX"));
    try std.testing.expect(!defines("const x = render(view);", "render"));
    try std.testing.expect(!defines("return renderer;", "render"));
}
test "the interesting name on a line" {
    try std.testing.expectEqualStrings("render", interestingName("pub fn render(view: View) void {"));
    try std.testing.expectEqualStrings("compute", interestingName("    state.value = compute(a, b); // \"skip\" these"));
    try std.testing.expectEqualStrings("total", interestingName("    return total + other;"));
    try std.testing.expectEqualStrings("", interestingName("    }"));
}

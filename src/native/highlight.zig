//! Syntax highlighting with TextMate grammars, the ones Shiki and VS Code
//! use. grammars.zig lists the bundled grammars and the files each claims;
//! syntaxmate.zig tokenizes a file line by line; this module picks the
//! language, runs the tokenizer and turns each token's scopes into one of a
//! few colors.
//!
//! `highlight` is safe to call from any thread. A language's grammars load
//! the first time it is used and are kept; two threads highlighting the same
//! language take turns.

const std = @import("std");
const syntaxmate = @import("syntaxmate.zig");
const grammars = @import("grammars.zig");
const sources = @import("tm_grammar_sources");

pub const Kind = enum(u8) { plain = 0, comment, keyword, string, function, property, constant, type };

/// A styled run within one line: byte offsets into the line's text (no newline).
pub const Token = struct { start: u32, end: u32, kind: Kind };

pub const Highlights = struct {
    /// Only non-plain runs, in order.
    tokens: []const Token,
    /// Line i's tokens are tokens[lines[i]..lines[i+1]]; len = line_count + 1.
    lines: []const u32,
    /// Lines before this one were highlighted; the time budget ran out at it.
    covered: usize,

    /// Line `index` (0-based); out of range gives no tokens.
    pub fn line(self: Highlights, index: usize) []const Token {
        if (index + 1 >= self.lines.len) return &.{};
        return self.tokens[self.lines[index]..self.lines[index + 1]];
    }

    /// Whether line `index` was highlighted (its tokens, even none, are its
    /// colors), rather than left when time ran out.
    pub fn covers(self: Highlights, index: usize) bool {
        return index < self.covered;
    }

    pub fn deinit(self: Highlights, alloc: std.mem.Allocator) void {
        alloc.free(self.tokens);
        alloc.free(self.lines);
    }
};

pub const Language = grammars.Language;

/// Files past this size are left plain.
pub const max_source_bytes = 2 * 1024 * 1024;
/// Highlighting one file stops after this long; lines past where it got to
/// are left to the line lexers.
pub const time_budget_ns = 300 * std.time.ns_per_ms;

// ---------------------------------------------------------------------------
// Languages by file name

fn table(comptime rows: anytype) std.StaticStringMap(Language) {
    @setEvalBranchQuota(100_000);
    return .initComptime(rows);
}
const basenames = table(grammars.basenames);
const extensions = table(grammars.extensions);
const interpreters = table(grammars.interpreters);

/// The language a file is highlighted as, by its name and then extension.
pub fn languageFor(path: []const u8) ?Language {
    const base = std.fs.path.basename(path);
    if (basenames.get(base)) |language| return language;
    if (std.mem.startsWith(u8, base, "Dockerfile.") or std.mem.startsWith(u8, base, "Containerfile.")) return .docker;
    if (std.mem.startsWith(u8, base, "Makefile.")) return .make;
    const ext = std.fs.path.extension(base);
    if (ext.len < 2) return null;
    var buffer: [32]u8 = undefined;
    if (ext.len - 1 > buffer.len) return null;
    return extensions.get(std.ascii.lowerString(&buffer, ext[1..]));
}

/// `languageFor`, or for a file its name doesn't place, the program its
/// `#!` line runs.
pub fn languageForSource(path: []const u8, source: []const u8) ?Language {
    if (languageFor(path)) |language| return language;
    if (!std.mem.startsWith(u8, source, "#!")) return null;
    const first = source[2 .. std.mem.indexOfScalar(u8, source, '\n') orelse source.len];
    var words = std.mem.tokenizeAny(u8, first, " \t\r");
    var program = std.fs.path.basename(words.next() orelse return null);
    // `#!/usr/bin/env [-S] python3`
    if (std.mem.eql(u8, program, "env")) {
        while (words.next()) |word| {
            if (word.len > 0 and word[0] == '-') continue;
            program = word;
            break;
        } else return null;
    }
    if (interpreters.get(program)) |language| return language;
    // python3.12, ruby3, node22
    const trimmed = std.mem.trimEnd(u8, program, "0123456789.");
    return interpreters.get(trimmed);
}

/// The language's grammar's root scope, as `source.zig`.
pub fn scopeName(language: Language) []const u8 {
    return grammars.grammars[@intFromEnum(language)].scope;
}

// ---------------------------------------------------------------------------
// Scopes to colors

/// What a scope makes its tokens. `operator` is keyword for a word (`and`,
/// `new`, `typeof`) and plain for a symbol.
/// `caps` is constant for an ALL_CAPS name and plain otherwise (grammars
/// give `const` declarations the constant scope too).
const Value = enum(u8) { plain = 0, comment, keyword, string, function, property, constant, type, operator, caps };

/// What each scope colors, matched on whole dot-separated prefixes: the
/// longest listed prefix wins and an unlisted scope keeps its parent's color,
/// the way a theme's rules apply. The categories follow VS Code's Dark+ and
/// GitHub's themes; `plain` entries reset what they sit inside (code
/// embedded in a string or another language).
const scope_values = [_]struct { []const u8, Value }{
    .{ "comment", .comment },
    .{ "punctuation.definition.comment", .comment },
    .{ "string.comment", .comment },
    .{ "markup.quote", .comment },

    .{ "keyword", .keyword },
    .{ "keyword.operator", .operator },
    .{ "keyword.other.unit", .constant },
    .{ "storage", .keyword },
    .{ "storage.type.primitive", .type },
    .{ "storage.type.built-in", .type },
    .{ "storage.type.numeric", .type },
    .{ "storage.type.java", .type },
    .{ "storage.type.generic", .type },
    .{ "storage.type.object", .type },
    .{ "storage.type.cs", .type },
    .{ "storage.type.string", .string },
    .{ "keyword.type.integer", .type },
    .{ "keyword.type.zig", .type },
    .{ "keyword.type.c.zig", .type },
    .{ "variable.language", .keyword },
    .{ "markup.heading", .keyword },
    .{ "entity.name.section", .keyword },
    .{ "punctuation.definition.list", .keyword },
    .{ "punctuation.definition.heading", .keyword },

    .{ "string", .string },
    .{ "markup.raw", .string },
    .{ "markup.inline.raw", .string },
    .{ "markup.fenced_code", .string },
    .{ "markup.underline.link", .string },
    .{ "string.other.link", .function },
    .{ "constant.other.reference.link", .function },
    .{ "markup.inserted", .string },
    .{ "markup.deleted", .keyword },
    .{ "markup.changed", .constant },

    .{ "entity.name.function", .function },
    .{ "support.function", .function },
    .{ "variable.function", .function },
    .{ "meta.function-call.generic", .function },

    .{ "variable.other.property", .property },
    .{ "variable.other.object.property", .property },
    .{ "variable.other.member", .property },
    .{ "variable.other.field", .property },
    .{ "variable.object.property", .property },
    .{ "support.variable.property", .property },
    .{ "meta.object-literal.key", .property },
    .{ "entity.other.attribute-name", .property },
    .{ "support.type.property-name", .property },
    .{ "entity.name.tag.yaml", .property },
    .{ "entity.name.label", .property },
    .{ "entity.name.goto-label", .property },

    .{ "constant", .constant },
    .{ "support.constant", .constant },
    .{ "variable.other.constant", .caps },
    .{ "variable.other.enummember", .constant },
    .{ "entity.name.constant", .constant },

    .{ "entity.name.type", .type },
    .{ "entity.name.class", .type },
    .{ "entity.name.struct", .type },
    .{ "entity.name.enum", .type },
    .{ "entity.name.union", .type },
    .{ "entity.name.trait", .type },
    .{ "entity.name.interface", .type },
    .{ "entity.name.namespace", .type },
    .{ "entity.name.scope-resolution", .type },
    .{ "entity.name.module", .type },
    .{ "entity.name.package", .type },
    .{ "entity.name.tag", .type },
    .{ "entity.other.inherited-class", .type },
    .{ "support.type", .type },
    .{ "support.class", .type },

    .{ "meta.embedded", .plain },
    .{ "meta.template.expression", .plain },
    .{ "meta.interpolation", .plain },
    .{ "punctuation.section.embedded", .plain },
    .{ "source.css.embedded", .plain },
};

fn valueOf(name: []const u8) ?Value {
    var best: ?Value = null;
    var best_len: usize = 0;
    for (scope_values) |entry| {
        const prefix = entry[0];
        if (prefix.len <= best_len) continue;
        if (!syntaxmate.scopeMatches(name, prefix)) continue;
        best = entry[1];
        best_len = prefix.len;
    }
    return best;
}

fn classify(parent: ?u8, name: []const u8) u8 {
    const inherited = parent orelse @intFromEnum(Value.plain);
    // A comment stays one color: tags inside doc comments, and grammars that
    // borrow other scopes to steer themes (OCaml's), don't break it up.
    if (inherited == @intFromEnum(Value.comment)) return inherited;
    if (valueOf(name)) |value| return @intFromEnum(value);
    return inherited;
}

// ---------------------------------------------------------------------------
// Grammars

const language_count = @typeInfo(Language).@"enum".fields.len;
comptime {
    std.debug.assert(sources.files.len == language_count);
}

/// Each root's injected grammars, by index.
const injection_indices = blk: {
    var out: [language_count][]const u16 = undefined;
    for (&out, grammars.grammars) |*slot, grammar| {
        var list: [grammar.injections.len]u16 = undefined;
        for (&list, grammar.injections) |*index, language| index.* = @intFromEnum(language);
        const final = list;
        slot.* = &final;
    }
    break :blk out;
};

fn injectionsFor(root: u16) []const u16 {
    return injection_indices[root];
}

const catalog: syntaxmate.Catalog = .{ .files = &sources.files, .dependencies = &sources.dependencies, .injections = injectionsFor };
var compiled: [language_count]syntaxmate.Grammar = blk: {
    var out: [language_count]syntaxmate.Grammar = undefined;
    for (&out, 0..) |*slot, i| slot.* = .init(i);
    break :blk out;
};

// ---------------------------------------------------------------------------
// Highlighting

const Collector = struct {
    alloc: std.mem.Allocator,
    source: []const u8,
    tokens: std.ArrayList(Token) = .empty,
    lines: []u32,
    /// Where the current line starts in `source`, and how long it is.
    line_start: usize = 0,
    line_len: usize = 0,
    /// The line being tokenized, and how many lines have begun.
    current: usize = 0,
    begun: usize = 0,
    failed: bool = false,

    fn beginLine(context: *anyopaque, index: usize) void {
        const self: *Collector = @ptrCast(@alignCast(context));
        if (index > 0) {
            const newline = std.mem.indexOfScalarPos(u8, self.source, self.line_start, '\n') orelse self.source.len;
            self.line_start = @min(newline + 1, self.source.len);
        }
        var end = std.mem.indexOfScalarPos(u8, self.source, self.line_start, '\n') orelse self.source.len;
        if (end > self.line_start and self.source[end - 1] == '\r') end -= 1;
        self.line_len = end - self.line_start;
        self.lines[index] = @intCast(self.tokens.items.len);
        self.current = index;
        self.begun = index + 1;
    }

    fn produce(context: *anyopaque, start_in: u32, end_in: u32, scope: syntaxmate.Stack, _: *const syntaxmate.Stacks) void {
        const self: *Collector = @ptrCast(@alignCast(context));
        const start = @min(start_in, self.line_len);
        const end = @min(end_in, self.line_len);
        if (end <= start) return;
        const text = self.source[self.line_start + start .. self.line_start + end];
        const kind: Kind = switch (@as(Value, @enumFromInt(scope.value))) {
            .operator => if (isWord(text)) .keyword else .plain,
            .caps => if (isCaps(text)) .constant else .plain,
            else => |value| @enumFromInt(@intFromEnum(value)),
        };
        if (kind == .plain) return;
        const first = self.lines[self.current];
        if (self.tokens.items.len > first) {
            const last = &self.tokens.items[self.tokens.items.len - 1];
            if (last.kind == kind and last.end == start) {
                last.end = @intCast(end);
                return;
            }
        }
        self.tokens.append(self.alloc, .{ .start = @intCast(start), .end = @intCast(end), .kind = kind }) catch {
            self.failed = true;
        };
    }
};

fn isCaps(text: []const u8) bool {
    for (text) |ch| if (std.ascii.isLower(ch)) return false;
    return true;
}

fn isWord(text: []const u8) bool {
    for (text) |ch| if (!std.ascii.isAlphabetic(ch) and ch != '_') return false;
    return text.len > 0;
}

/// Highlights `source` as `language`. Files that are too large or look
/// binary come back with no lines covered; so does a file whose first line
/// doesn't finish within the time budget. Free the result with `deinit`.
pub fn highlight(alloc: std.mem.Allocator, language: Language, source: []const u8) !Highlights {
    return highlightUntil(alloc, language, source, null);
}
/// `highlight`, giving up (as if out of time) once `stop` is set.
pub fn highlightUntil(alloc: std.mem.Allocator, language: Language, source: []const u8, stop: ?*const std.atomic.Value(bool)) !Highlights {
    return highlightWithin(alloc, language, source, stop, time_budget_ns);
}

/// `highlightUntil` with its own time budget; the benchmark times with none.
pub fn highlightWithin(alloc: std.mem.Allocator, language: Language, source: []const u8, stop: ?*const std.atomic.Value(bool), budget_ns: u64) !Highlights {
    const line_count = std.mem.count(u8, source, "\n") + 1;
    const lines = try alloc.alloc(u32, line_count + 1);
    errdefer alloc.free(lines);
    @memset(lines, 0);
    if (source.len > max_source_bytes or looksBinary(source)) return .{ .tokens = &.{}, .lines = lines, .covered = 0 };

    var collector: Collector = .{ .alloc = alloc, .source = source, .lines = lines };
    errdefer collector.tokens.deinit(alloc);
    const sink: syntaxmate.Sink = .{
        .context = &collector,
        .begin_line = Collector.beginLine,
        .produce = Collector.produce,
        .classify = classify,
    };
    const limits: syntaxmate.Limits = .{ .deadline = syntaxmate.monotonicNs() +| budget_ns, .stop = stop };
    const covered = compiled[@intFromEnum(language)].tokenize(std.heap.page_allocator, catalog, source, sink, limits) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => 0,
    };
    if (collector.failed) return error.OutOfMemory;
    // A line cut short keeps none of its tokens.
    if (collector.begun > covered) collector.tokens.shrinkRetainingCapacity(lines[covered]);
    for (lines[covered..]) |*slot| slot.* = @intCast(collector.tokens.items.len);
    return .{ .tokens = try collector.tokens.toOwnedSlice(alloc), .lines = lines, .covered = covered };
}

/// Writes each token's byte range and scopes, line by line, for comparing
/// the tokenizer with vscode-textmate (scripts/compare-textmate.mjs).
pub fn writeScopes(gpa: std.mem.Allocator, language: Language, source: []const u8, out: *std.Io.Writer) !void {
    const Dump = struct {
        out: *std.Io.Writer,
        source: []const u8,
        line_start: usize = 0,
        line_len: usize = 0,
        index: usize = 0,
        fn begin(context: *anyopaque, index: usize) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (index > 0) self.line_start = @min((std.mem.indexOfScalarPos(u8, self.source, self.line_start, '\n') orelse self.source.len) + 1, self.source.len);
            var end = std.mem.indexOfScalarPos(u8, self.source, self.line_start, '\n') orelse self.source.len;
            if (end > self.line_start and self.source[end - 1] == '\r') end -= 1;
            self.line_len = end - self.line_start;
            self.out.print("L{d}\n", .{index}) catch {};
        }
        fn produce(context: *anyopaque, start_in: u32, end_in: u32, scope: syntaxmate.Stack, stacks: *const syntaxmate.Stacks) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            const start = @min(start_in, self.line_len);
            const end = @min(end_in, self.line_len);
            if (end <= start) return;
            self.out.print("{d} {d}", .{ start, end }) catch {};
            for (stacks.namesOf(scope)) |name| self.out.print(" {s}", .{name}) catch {};
            self.out.writeAll("\n") catch {};
        }
    };
    var dump: Dump = .{ .out = out, .source = source };
    const sink: syntaxmate.Sink = .{ .context = &dump, .begin_line = Dump.begin, .produce = Dump.produce, .classify = classify };
    _ = try compiled[@intFromEnum(language)].tokenize(gpa, catalog, source, sink, .{ .deadline = std.math.maxInt(u64) });
}

/// Git's test: a NUL in the first 8000 bytes.
fn looksBinary(source: []const u8) bool {
    return std.mem.indexOfScalar(u8, source[0..@min(source.len, 8000)], 0) != null;
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

test {
    _ = syntaxmate;
}

/// The kind of each run on `line`, written as `text:kind` pairs.
fn expectLine(highlights: Highlights, source: []const u8, line_index: usize, expected: []const struct { []const u8, Kind }) !void {
    var start: usize = 0;
    for (0..line_index) |_| start = std.mem.indexOfScalarPos(u8, source, start, '\n').? + 1;
    const end = std.mem.indexOfScalarPos(u8, source, start, '\n') orelse source.len;
    const text = source[start..end];
    for (expected) |pair| {
        const at = std.mem.indexOf(u8, text, pair[0]) orelse {
            std.debug.print("`{s}` is not on line {d}: {s}\n", .{ pair[0], line_index, text });
            return error.TestExpectedText;
        };
        for (at..at + pair[0].len) |byte| {
            const kind = kindAt(highlights.line(line_index), @intCast(byte));
            if (kind != pair[1]) {
                std.debug.print("line {d} `{s}` at {d}: expected {t}, found {t}\n  {s}\n", .{ line_index, pair[0], byte - at, pair[1], kind, text });
                return error.TestUnexpectedKind;
            }
        }
    }
}

fn kindAt(tokens: []const Token, byte: u32) Kind {
    for (tokens) |token| if (byte >= token.start and byte < token.end) return token.kind;
    return .plain;
}

fn expectHighlights(language: Language, source: []const u8, lines: []const struct { usize, []const struct { []const u8, Kind } }) !void {
    const result = try highlight(testing.allocator, language, source);
    defer result.deinit(testing.allocator);
    try testing.expectEqual(std.mem.count(u8, source, "\n") + 1, result.covered);
    for (lines) |line| try expectLine(result, source, line[0], line[1]);
}

test "languageFor maps extensions and file names" {
    const cases = [_]struct { []const u8, ?Language }{
        .{ "src/native/highlight.zig", .zig },  .{ "build.zig.zon", .zig },
        .{ "a/b/lib.rs", .rust },               .{ "x.ts", .typescript },
        .{ "x.tsx", .tsx },                     .{ "x.jsx", .jsx },
        .{ "include/foo.h", .cpp },             .{ "foo.c", .c },
        .{ "FOO.CPP", .cpp },                   .{ "AppDelegate.m", .@"objective-c" },
        .{ "Makefile", .make },                 .{ "sub/GNUmakefile", .make },
        .{ "docker/Dockerfile", .docker },      .{ "Dockerfile.dev", .docker },
        .{ "CMakeLists.txt", .cmake },          .{ "/home/u/.bashrc", .shellscript },
        .{ ".zshrc", .shellscript },            .{ "flake.lock", .json },
        .{ "Cargo.lock", .toml },               .{ "Gemfile", .ruby },
        .{ "main.tf", .terraform },             .{ "README.md", .markdown },
        .{ ".github/workflows/ci.yml", .yaml }, .{ "lib/parser.ml", .ocaml },
        .{ "init.el", .@"emacs-lisp" },         .{ "core.clj", .clojure },
        .{ "boot.S", .@"asm" },                 .{ "kernel.asm", .@"asm" },
        .{ "app.lisp", .@"common-lisp" },       .{ "a.scm", .scheme },
        .{ "Main.hs", .haskell },               .{ "x.ex", .elixir },
        .{ "x.erl", .erlang },                  .{ "build.gradle", .groovy },
        .{ "notes.txt", null },                 .{ "LICENSE", null },
        .{ "archive.tar.gz", null },
    };
    for (cases) |case| {
        const found = languageFor(case[0]);
        if (found != case[1]) {
            std.debug.print("{s}: expected {?t}, found {?t}\n", .{ case[0], case[1], found });
            return error.TestUnexpectedLanguage;
        }
    }
}

test "a #! line names the language of a file its name doesn't" {
    try testing.expectEqual(Language.python, languageForSource("bin/tool", "#!/usr/bin/env python3\nprint(1)\n").?);
    try testing.expectEqual(Language.shellscript, languageForSource("bin/run", "#!/bin/bash -e\n").?);
    try testing.expectEqual(Language.javascript, languageForSource("cli", "#!/usr/bin/env -S node --experimental\n").?);
    try testing.expectEqual(Language.ruby, languageForSource("x.rb", "#!/bin/sh\n").?);
    try testing.expectEqual(@as(?Language, null), languageForSource("notes", "plain text\n"));
}

test "every grammar the build embeds loads" {
    for (grammars.grammars, &compiled) |grammar, *grammar_state| {
        if (!grammar_state.loads(catalog)) {
            std.debug.print("{s} did not load\n", .{grammar.scope});
            return error.TestGrammarDidNotLoad;
        }
    }
}

test "the time budget stops a pathological line partway through" {
    // Nested brackets take syntaxmate seconds on one 20,000-byte line.
    const source = "[" ** 19_990 ++ "\n";
    const start = syntaxmate.monotonicNs();
    const result = try highlightWithin(testing.allocator, .json, source, null, 50 * std.time.ns_per_ms);
    defer result.deinit(testing.allocator);
    try testing.expect(syntaxmate.monotonicNs() - start < std.time.ns_per_s);
    try testing.expectEqual(@as(usize, 0), result.covered);
    try testing.expectEqual(@as(usize, 0), result.line(0).len);
}

test "an empty file has one empty line" {
    const result = try highlight(testing.allocator, .zig, "");
    defer result.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 2), result.lines.len);
    try testing.expectEqual(@as(usize, 1), result.covered);
    try testing.expectEqual(@as(usize, 0), result.line(0).len);
    try testing.expectEqual(@as(usize, 0), result.line(99).len);
}

test "zig" {
    try expectHighlights(.zig,
        \\const std = @import("std");
        \\/// Adds.
        \\pub fn add(a: u32, b: u32) u32 {
        \\    return a + b + 0x10; // sum
        \\}
        \\const text =
        \\    \\first
        \\;
    , &.{
        .{ 0, &.{ .{ "const", .keyword }, .{ "@import", .function }, .{ "\"std\"", .string } } },
        .{ 1, &.{.{ "/// Adds.", .comment }} },
        .{ 2, &.{ .{ "pub", .keyword }, .{ "fn", .keyword }, .{ "add", .function }, .{ "u32", .type } } },
        .{ 3, &.{ .{ "return", .keyword }, .{ "0x10", .constant }, .{ "// sum", .comment }, .{ "+", .plain } } },
        .{ 6, &.{.{ "\\\\first", .string }} },
    });
}

test "rust" {
    try expectHighlights(.rust,
        \\/* a block
        \\   comment */
        \\fn main() {
        \\    let s = "tab\there";
        \\    println!("{}", MAX_SIZE);
        \\    let v: Vec<u8> = Vec::new();
        \\    if v.is_empty() { return; }
        \\}
    , &.{
        .{ 0, &.{.{ "/* a block", .comment }} },
        .{ 1, &.{.{ "   comment */", .comment }} },
        .{ 2, &.{ .{ "fn", .keyword }, .{ "main", .function } } },
        // The escape inside the string is its own color; the string resumes after it.
        .{ 3, &.{ .{ "let", .keyword }, .{ "\"tab", .string }, .{ "\\t", .constant }, .{ "here\"", .string } } },
        .{ 4, &.{ .{ "println!", .function }, .{ "MAX_SIZE", .constant } } },
        .{ 5, &.{ .{ "Vec", .type }, .{ "u8", .type }, .{ "new", .function } } },
        .{ 6, &.{ .{ "if", .keyword }, .{ "is_empty", .function }, .{ "return", .keyword } } },
    });
}

test "typescript" {
    try expectHighlights(.typescript,
        \\import { readFile } from "node:fs";
        \\// load it
        \\export async function load(path: string): Promise<number> {
        \\  const value = `count ${path.length}`, LIMIT = 3;
        \\  return this.cache.get(path) ?? typeof path;
        \\}
        \\interface Point { x: number }
    , &.{
        .{ 0, &.{ .{ "import", .keyword }, .{ "from", .keyword }, .{ "\"node:fs\"", .string } } },
        .{ 1, &.{.{ "// load it", .comment }} },
        .{ 2, &.{ .{ "export", .keyword }, .{ "async", .keyword }, .{ "function", .keyword }, .{ "load", .function }, .{ "string", .type }, .{ "Promise", .type } } },
        // Template interpolation: the string around it, the code inside it
        // plain; a `const` name is a constant only in capitals.
        .{ 3, &.{ .{ "value", .plain }, .{ "`count ", .string }, .{ "path", .plain }, .{ "length", .property }, .{ "LIMIT", .constant } } },
        // A word operator is a keyword; a symbol one is plain.
        .{ 4, &.{ .{ "return", .keyword }, .{ "this", .keyword }, .{ "get", .function }, .{ "??", .plain }, .{ "typeof", .keyword } } },
        .{ 6, &.{ .{ "interface", .keyword }, .{ "Point", .type }, .{ "x", .property } } },
    });
}

test "python" {
    try expectHighlights(.python,
        \\import os
        \\
        \\class Greeter(Base):
        \\    """Docs
        \\    span lines."""
        \\    def greet(self, name: str) -> None:
        \\        print(f"hi {name}", 3.5)  # say it
        \\        return not None
    , &.{
        .{ 0, &.{.{ "import", .keyword }} },
        .{ 2, &.{ .{ "class", .keyword }, .{ "Greeter", .type } } },
        .{ 3, &.{.{ "\"\"\"Docs", .string }} },
        .{ 4, &.{.{ "    span lines.\"\"\"", .string }} },
        .{ 5, &.{ .{ "def", .keyword }, .{ "greet", .function }, .{ "str", .type }, .{ "None", .constant } } },
        .{ 6, &.{ .{ "print", .function }, .{ "f\"hi ", .string }, .{ "name", .plain }, .{ "3.5", .constant }, .{ "# say it", .comment } } },
        .{ 7, &.{ .{ "return", .keyword }, .{ "not", .keyword } } },
    });
}

test "c" {
    try expectHighlights(.c,
        \\#include <stdio.h>
        \\#define MAX 10
        \\/* multi
        \\ * line */
        \\static int count(const char *s) {
        \\    printf("%d\n", MAX);
        \\    return p.x;
        \\}
    , &.{
        .{ 0, &.{ .{ "#include", .keyword }, .{ "<stdio.h>", .string } } },
        .{ 1, &.{ .{ "#define", .keyword }, .{ "10", .constant } } },
        .{ 2, &.{.{ "/* multi", .comment }} },
        .{ 3, &.{.{ " * line */", .comment }} },
        .{ 4, &.{ .{ "static", .keyword }, .{ "int", .type }, .{ "count", .function }, .{ "const", .keyword }, .{ "char", .type } } },
        .{ 5, &.{ .{ "printf", .function }, .{ "%d", .constant } } },
        .{ 6, &.{ .{ "return", .keyword }, .{ "x", .property } } },
    });
}

test "json" {
    try expectHighlights(.json,
        \\{
        \\  "name": "patch\n",
        \\  "count": 3,
        \\  "ok": true,
        \\  "none": null
        \\}
    , &.{
        .{ 1, &.{ .{ "\"name\"", .property }, .{ "\"patch", .string }, .{ "\\n", .constant } } },
        .{ 2, &.{.{ "3", .constant }} },
        .{ 3, &.{.{ "true", .constant }} },
        .{ 4, &.{.{ "null", .constant }} },
    });
}

test "markdown fences take their language's colors" {
    try expectHighlights(.markdown,
        \\# Title
        \\
        \\Some `code` here.
        \\
        \\```zig
        \\const x = 1;
        \\```
        \\
        \\~~~ python
        \\def greet(): pass
        \\~~~
    , &.{
        .{ 0, &.{.{ "Title", .keyword }} },
        .{ 2, &.{ .{ "Some", .plain }, .{ "code", .string } } },
        .{ 5, &.{ .{ "const", .keyword }, .{ "1", .constant } } },
        .{ 9, &.{ .{ "def", .keyword }, .{ "greet", .function } } },
    });
}

test "html script and style" {
    try expectHighlights(.html,
        \\<div class="a">
        \\<script>let n = 1;</script>
        \\<style>p { color: red; }</style>
        \\</div>
    , &.{
        .{ 0, &.{ .{ "div", .type }, .{ "class", .property }, .{ "\"a\"", .string } } },
        .{ 1, &.{ .{ "script", .type }, .{ "let", .keyword }, .{ "1", .constant } } },
        .{ 2, &.{ .{ "style", .type }, .{ "color", .property } } },
    });
}

test "lisps, ML and assembly" {
    try expectHighlights(.ocaml, "let rec f x = if x then \"s\" else f x (* note *)\n", &.{
        .{ 0, &.{ .{ "let", .keyword }, .{ "\"s\"", .string }, .{ "(* note *)", .comment } } },
    });
    try expectHighlights(.@"common-lisp", "(defun add (a b) \"Adds.\" (+ a b)) ; sum\n", &.{
        .{ 0, &.{ .{ "defun", .keyword }, .{ "\"Adds.\"", .string }, .{ "; sum", .comment } } },
    });
    try expectHighlights(.clojure, "(defn greet [name] (str \"hi \" name)) ; c\n", &.{
        .{ 0, &.{ .{ "\"hi \"", .string }, .{ "; c", .comment } } },
    });
    try expectHighlights(.@"emacs-lisp", "(defun f () \"Doc.\" (message \"x\")) ; c\n", &.{
        .{ 0, &.{ .{ "defun", .keyword }, .{ "; c", .comment } } },
    });
    try expectHighlights(.@"asm", "_start:\n    mov eax, 1 ; exit\n    syscall\n", &.{
        .{ 1, &.{ .{ "mov", .keyword }, .{ "; exit", .comment } } },
    });
}

test "carriage returns stay out of tokens" {
    const source = "// one\r\nint x;\r\n";
    const result = try highlight(testing.allocator, .c, source);
    defer result.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 4), result.lines.len);
    const first = result.line(0);
    try testing.expectEqual(@as(usize, 1), first.len);
    try testing.expectEqual(Token{ .start = 0, .end = 6, .kind = .comment }, first[0]);
}

test "binary, invalid UTF-8 and oversized input" {
    const binary = "\x00\x01\x02int x;\n";
    const a = try highlight(testing.allocator, .c, binary);
    defer a.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), a.tokens.len);
    try testing.expectEqual(@as(usize, 0), a.covered);
    try testing.expectEqual(@as(usize, 3), a.lines.len);

    const invalid = "int \xff\xfe x = 1; // \xc3\n\"\xe2\x82\";\n";
    const b = try highlight(testing.allocator, .c, invalid);
    defer b.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 4), b.lines.len);
    try testing.expectEqual(@as(usize, 3), b.covered);

    const big = try testing.allocator.alloc(u8, max_source_bytes + 1);
    defer testing.allocator.free(big);
    @memset(big, 'a');
    const c = try highlight(testing.allocator, .c, big);
    defer c.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), c.tokens.len);
    try testing.expectEqual(@as(usize, 0), c.covered);
}

test "lines past the time budget are left uncovered" {
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(testing.allocator);
    for (0..20_000) |i| try source.print(testing.allocator, "const value_{d} = \"text\"; // {d}\n", .{ i, i });
    const result = try highlightWithin(testing.allocator, .typescript, source.items, null, 2 * std.time.ns_per_ms);
    defer result.deinit(testing.allocator);
    try testing.expect(result.covered < 20_000);
    try testing.expect(!result.covers(20_000));
    // Lines it reached keep their colors; the rest have none.
    if (result.covered > 0) try testing.expect(result.line(0).len > 0);
    try testing.expectEqual(@as(usize, 0), result.line(19_999).len);
}

test "a long line stays plain and leaves the state as it was" {
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(testing.allocator);
    try source.appendSlice(testing.allocator, "/* open\n");
    try source.appendNTimes(testing.allocator, 'x', 30_000);
    try source.appendSlice(testing.allocator, "\nstill */ int x;\n");
    const result = try highlight(testing.allocator, .c, source.items);
    defer result.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), result.line(1).len);
    try testing.expectEqual(Kind.comment, kindAt(result.line(2), 0));
    try testing.expectEqual(Kind.type, kindAt(result.line(2), 9));
}

test "every language highlights a little source" {
    const samples = [_]struct { Language, []const u8 }{
        .{ .cpp, "namespace a { template <typename T> class B { public: int x = 0; }; }" },
        .{ .@"objective-c", "@interface Foo : NSObject\n- (void)bar;\n@end\n" },
        .{ .go, "package main\nfunc main() { fmt.Println(\"hi\") }\n" },
        .{ .javascript, "const a = 1; // x\n" },
        .{ .jsx, "const a = <div className=\"x\">{b}</div>;\n" },
        .{ .tsx, "const a: number = <A b={1} />;\n" },
        .{ .java, "public class A { void b() { return; } }\n" },
        .{ .kotlin, "fun main() { val x = \"s\" }\n" },
        .{ .swift, "func f() -> Int { return 1 }\n" },
        .{ .csharp, "class A { void B() { var s = \"x\"; } }\n" },
        .{ .ruby, "def a\n  puts \"x\"\nend\n" },
        .{ .php, "<?php\nfunction a() { return \"x\"; }\n?>\n<p>hi</p>\n" },
        .{ .lua, "local function f() return \"x\" end\n" },
        .{ .shellscript, "if [ -f x ]; then echo \"hi\"; fi\n" },
        .{ .nix, "{ pkgs, ... }: { a = \"x\"; }\n" },
        .{ .yaml, "a: 1\nb: \"x\"\n" },
        .{ .toml, "[a]\nb = \"x\"\n" },
        .{ .css, "@import \"x.css\";\na { color: red; }\n" },
        .{ .scss, "$x: 1px;\n@mixin m { a { margin: $x; } }\n" },
        .{ .sql, "SELECT a FROM b WHERE c = 'x';\n" },
        .{ .make, "ifdef DEBUG\nall: x\n\techo \"hi\"\nendif\n" },
        .{ .docker, "FROM alpine\nRUN echo hi\n" },
        .{ .cmake, "project(a)\nset(X \"y\")\n" },
        .{ .haskell, "main :: IO ()\nmain = putStrLn \"hi\"\n" },
        .{ .elixir, "defmodule A do\n  def b, do: :ok\nend\n" },
        .{ .erlang, "-module(a).\nf() -> \"x\".\n" },
        .{ .scala, "object A { def b: Int = 1 }\n" },
        .{ .dart, "void main() { print('hi'); }\n" },
        .{ .proto, "syntax = \"proto3\";\nmessage A { string b = 1; }\n" },
        .{ .graphql, "query A { b(c: 1) { d } }\n" },
        .{ .hcl, "resource \"a\" \"b\" { c = \"d\" }\n" },
        .{ .terraform, "resource \"a\" \"b\" { c = \"d\" }\n" },
        .{ .vue, "<template><p>{{ a }}</p></template>\n<script>export default { a: 1 }</script>\n" },
        .{ .svelte, "<script>let a = 1;</script>\n<p>{a}</p>\n" },
        .{ .scheme, "(define (f x) \"s\")\n" },
        .{ .fsharp, "let f x = \"s\"\n" },
        .{ .julia, "function f(x)\n  \"s\"\nend\n" },
        .{ .r, "f <- function(x) \"s\"\n" },
        .{ .perl, "my $x = \"s\";\n" },
        .{ .powershell, "function F { Write-Host \"s\" }\n" },
        .{ .latex, "\\section{A} % c\n" },
        .{ .xml, "<a b=\"c\">d</a>\n" },
        .{ .verilog, "module a; wire b; endmodule\n" },
        .{ .riscv, "addi a0, a0, 1 # c\n" },
        .{ .llvm, "define i32 @f() { ret i32 0 }\n" },
    };
    for (samples) |sample| {
        const result = try highlight(testing.allocator, sample[0], sample[1]);
        defer result.deinit(testing.allocator);
        var colored = false;
        for (result.tokens) |token| colored = colored or token.kind == .string or token.kind == .keyword or token.kind == .comment;
        if (!colored) {
            std.debug.print("{t} found no string, keyword or comment\n", .{sample[0]});
            return error.TestNoTokens;
        }
    }
}

test "two threads highlight the same language" {
    const source = "fn main() { let s = \"x\"; }\n" ** 200;
    var results: [2]?Highlights = .{ null, null };
    const Worker = struct {
        fn run(slot: *?Highlights) void {
            slot.* = highlight(std.heap.page_allocator, .rust, source) catch null;
        }
    };
    var threads: [2]std.Thread = undefined;
    for (&threads, &results) |*thread, *slot| thread.* = try std.Thread.spawn(.{}, Worker.run, .{slot});
    for (threads) |thread| thread.join();
    defer for (results) |result| if (result) |r| r.deinit(std.heap.page_allocator);
    for (results) |result| {
        const r = result orelse return error.TestHighlightFailed;
        try testing.expectEqual(@as(usize, 201), r.covered);
        try testing.expectEqualSlices(Token, results[0].?.tokens, r.tokens);
    }
}

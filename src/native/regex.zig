//! A small regular expression matcher for the highlighter's `#match?`
//! predicates where the C library has no POSIX <regex.h> (Windows).
//!
//! It takes the POSIX extended subset that `translateRegex` and
//! `translateLua` in highlight.zig produce: literals, `.`, bracket
//! expressions (ranges, negation, a leading `]`, and the classes
//! `[:space:]`, `[:alpha:]`, `[:alnum:]`, `[:xdigit:]`, `[:punct:]` and
//! `[:cntrl:]`), groups, alternation, `* + ? {m} {m,} {m,n}` (each may be
//! followed by one `?`, which only changes which match is found), anchors
//! `^ $`, `\b \B` and backslash-escaped punctuation. Anything else is
//! `error.Unsupported`, which disables the predicate the way a failed
//! `regcomp` does.
//!
//! Only whether the expression matches somewhere matters (`REG_NOSUB`), so
//! `search` runs the pattern as a Thompson NFA over the text, one byte at a
//! time: time is linear in the text for a given pattern and nothing can
//! backtrack exponentially. Text is bytes, may hold NULs, and case folding
//! is ASCII, as in the C locale.
//!
//! Where POSIX leaves room, this follows macOS's libc (TRE with
//! REG_ENHANCED), which highlight.zig uses everywhere but Windows:
//!   - `\b` holds at the start and end of the text whatever is next to it,
//!     and `\B` never does;
//!   - a NUL byte ends the text for `$`, `\b` and `\B`, though `.` and
//!     brackets still match it;
//!   - an empty alternative (`a|`, `(|a)`) and an empty pattern are errors,
//!     while `()` is not; a quantifier with nothing to repeat, after an
//!     anchor, or after another quantifier is an error;
//!   - `{` not followed by a digit, and `}` and `)` with nothing to close,
//!     are literal.

const std = @import("std");

pub const Error = error{ Unsupported, OutOfMemory };

/// Compiled programs larger than this are Unsupported; `search` keeps its
/// state on the stack, sized by it.
pub const max_program = 4096;
/// POSIX's RE_DUP_MAX: the largest count `{m,n}` takes.
const max_count = 255;

const Set = std.StaticBitSet(256);

const Assertion = enum { bol, eol, word_boundary, not_word_boundary };

const Inst = union(enum) {
    /// Consume this byte.
    byte: u8,
    /// Consume a byte in `sets[index]`.
    set: u16,
    split: [2]u16,
    jump: u16,
    assert: Assertion,
    match,
};

pub const Regex = struct {
    alloc: std.mem.Allocator,
    program: []const Inst,
    sets: []const Set,
    /// Every match starts at the start of the text, so `search` need not
    /// try later starts.
    anchored: bool,

    pub fn compile(alloc: std.mem.Allocator, pattern: []const u8, ignore_case: bool) Error!*Regex {
        var parser: Parser = .{ .alloc = alloc, .pattern = pattern, .ignore_case = ignore_case };
        defer parser.nodes.deinit(alloc);
        errdefer parser.sets.deinit(alloc);
        const root = try parser.parse();

        var program: std.ArrayList(Inst) = .empty;
        defer program.deinit(alloc);
        try emit(alloc, &program, parser.nodes.items, root);
        if (program.items.len >= max_program) return error.Unsupported;
        try program.append(alloc, .match);

        const self = try alloc.create(Regex);
        errdefer alloc.destroy(self);
        const code = try program.toOwnedSlice(alloc);
        errdefer alloc.free(code);
        self.* = .{
            .alloc = alloc,
            .program = code,
            .sets = try parser.sets.toOwnedSlice(alloc),
            .anchored = startsAnchored(parser.nodes.items, root),
        };
        return self;
    }

    pub fn deinit(self: *Regex) void {
        const alloc = self.alloc;
        alloc.free(self.program);
        alloc.free(self.sets);
        alloc.destroy(self);
    }

    /// Whether the expression matches anywhere in `text`. Safe to call from
    /// several threads at once.
    pub fn search(self: *const Regex, text: []const u8) bool {
        const words = (self.program.len + 63) / 64;
        var storage: [3][max_program / 64]u64 = undefined;
        var current: []u64 = storage[0][0..words];
        var next: []u64 = storage[1][0..words];
        const visited: []u64 = storage[2][0..words];
        var stack: [max_program]u16 = undefined;
        var run: Run = .{ .regex = self, .text = text, .visited = visited, .stack = &stack };

        @memset(current, 0);
        @memset(visited, 0);
        var pos: usize = 0;
        while (true) : (pos += 1) {
            // `current` holds the threads waiting to consume text[pos], and
            // `visited` every instruction already reached at pos.
            if (pos == 0 or !self.anchored) {
                if (run.follow(current, 0, pos)) return true;
            } else if (std.mem.allEqual(u64, current, 0)) return false;
            if (pos == text.len) return false;
            const c = text[pos];
            @memset(next, 0);
            @memset(visited, 0);
            for (current, 0..) |word, index| {
                var bits = word;
                while (bits != 0) : (bits &= bits - 1) {
                    const pc = index * 64 + @ctz(bits);
                    const consumed = switch (self.program[pc]) {
                        .byte => |b| b == c,
                        .set => |s| self.sets[s].isSet(c),
                        else => unreachable,
                    };
                    if (consumed and run.follow(next, @intCast(pc + 1), pos + 1)) return true;
                }
            }
            std.mem.swap([]u64, &current, &next);
        }
    }

    /// Appends to `out` a string made by one random walk through the
    /// program, ignoring assertions: text the expression likely matches, for
    /// tests to try. Walks prefer to leave loops once `out` holds `limit`
    /// bytes.
    pub fn sample(self: *const Regex, alloc: std.mem.Allocator, random: std.Random, out: *std.ArrayList(u8), limit: usize) !void {
        const start = out.items.len;
        var pc: usize = 0;
        var steps: usize = 0;
        while (steps < 4 * max_program) : (steps += 1) switch (self.program[pc]) {
            .byte => |c| {
                try out.append(alloc, c);
                pc += 1;
            },
            .set => |s| {
                const set = self.sets[s];
                var pick = random.uintLessThan(usize, @max(set.count(), 1));
                var members = set.iterator(.{});
                const c = while (members.next()) |c| {
                    if (pick == 0) break c;
                    pick -= 1;
                } else 'x';
                try out.append(alloc, @intCast(c));
                pc += 1;
            },
            .split => |to| pc = if (out.items.len - start < limit and random.boolean()) to[0] else to[1],
            .jump => |to| pc = to,
            .assert => pc += 1,
            .match => return,
        };
    }
};

/// One search's scratch state.
const Run = struct {
    regex: *const Regex,
    text: []const u8,
    visited: []u64,
    stack: *[max_program]u16,

    /// Adds to `threads` every consuming instruction reachable from `start`
    /// at `pos` without consuming; true if that reaches the match.
    fn follow(self: *Run, threads: []u64, start: u16, pos: usize) bool {
        var len: usize = 0;
        if (self.visit(start)) {
            self.stack[0] = start;
            len = 1;
        }
        while (len > 0) {
            len -= 1;
            const pc = self.stack[len];
            switch (self.regex.program[pc]) {
                .byte, .set => threads[pc / 64] |= @as(u64, 1) << @intCast(pc % 64),
                .match => return true,
                .jump => |to| len = self.push(len, to),
                .split => |to| len = self.push(self.push(len, to[1]), to[0]),
                .assert => |assertion| if (holds(assertion, self.text, pos)) {
                    len = self.push(len, pc + 1);
                },
            }
        }
        return false;
    }

    fn push(self: *Run, len: usize, pc: u16) usize {
        if (!self.visit(pc)) return len;
        self.stack[len] = pc;
        return len + 1;
    }

    /// Marks `pc` reached; false if it already was.
    fn visit(self: *Run, pc: u16) bool {
        const bit = @as(u64, 1) << @intCast(pc % 64);
        if (self.visited[pc / 64] & bit != 0) return false;
        self.visited[pc / 64] |= bit;
        return true;
    }
};

fn holds(assertion: Assertion, text: []const u8, pos: usize) bool {
    // As in TRE, a NUL ends the text for `$` and the word assertions.
    const at_end = pos == text.len or text[pos] == 0;
    return switch (assertion) {
        .bol => pos == 0,
        .eol => at_end,
        .word_boundary => pos == 0 or at_end or isWord(text[pos - 1]) != isWord(text[pos]),
        .not_word_boundary => !(pos == 0 or at_end or isWord(text[pos - 1]) != isWord(text[pos])),
    };
}

fn isWord(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

// ---------------------------------------------------------------------------
// Parsing

const Node = union(enum) {
    byte: u8,
    set: u16,
    assert: Assertion,
    empty,
    concat: [2]u32,
    alt: [2]u32,
    repeat: struct { child: u32, min: u8, max: ?u8 },
};

const Parser = struct {
    alloc: std.mem.Allocator,
    pattern: []const u8,
    ignore_case: bool,
    pos: usize = 0,
    depth: usize = 0,
    nodes: std.ArrayList(Node) = .empty,
    sets: std.ArrayList(Set) = .empty,

    fn parse(self: *Parser) Error!u32 {
        if (self.pattern.len == 0) return error.Unsupported;
        const root = try self.alternation();
        // Only an unmatched `)` stops the top level, and that is literal.
        std.debug.assert(self.pos == self.pattern.len);
        return root;
    }

    fn peek(self: *const Parser) ?u8 {
        return if (self.pos < self.pattern.len) self.pattern[self.pos] else null;
    }

    fn add(self: *Parser, node: Node) Error!u32 {
        if (self.nodes.items.len >= max_program) return error.Unsupported;
        try self.nodes.append(self.alloc, node);
        return @intCast(self.nodes.items.len - 1);
    }

    fn alternation(self: *Parser) Error!u32 {
        var left = try self.sequence();
        while (self.peek() == '|') {
            self.pos += 1;
            const right = try self.sequence();
            if (left == null or right == null) return error.Unsupported;
            left = try self.add(.{ .alt = .{ left.?, right.? } });
        }
        return left orelse try self.add(.empty);
    }

    /// Null when empty.
    fn sequence(self: *Parser) Error!?u32 {
        var result: ?u32 = null;
        while (self.peek()) |c| {
            if (c == '|' or (c == ')' and self.depth > 0)) break;
            const piece = try self.repetition();
            result = if (result) |left| try self.add(.{ .concat = .{ left, piece } }) else piece;
        }
        return result;
    }

    fn repetition(self: *Parser) Error!u32 {
        var node, const repeatable = try self.atom();
        if (self.quantifier()) |count| {
            if (!repeatable) return error.Unsupported;
            const min, const max = try count;
            node = try self.add(.{ .repeat = .{ .child = node, .min = min, .max = max } });
            // A trailing `?` asks for the shortest match, which doesn't
            // change whether there is one; anything more is an error.
            if (self.peek() == '?') self.pos += 1;
            if (self.quantifier() != null) return error.Unsupported;
        }
        return node;
    }

    /// The quantifier at pos, consumed, as (min, max); null if none.
    fn quantifier(self: *Parser) ?Error!struct { u8, ?u8 } {
        const c = self.peek() orelse return null;
        switch (c) {
            '*', '+', '?' => {
                self.pos += 1;
                return switch (c) {
                    '*' => .{ 0, null },
                    '+' => .{ 1, null },
                    else => .{ 0, 1 },
                };
            },
            '{' => {
                if (!self.digitAt(self.pos + 1)) return null;
                self.pos += 1;
                return self.interval();
            },
            else => return null,
        }
    }

    fn interval(self: *Parser) Error!struct { u8, ?u8 } {
        const min = try self.number();
        var max: ?u8 = min;
        if (self.peek() == ',') {
            self.pos += 1;
            max = if (self.digitAt(self.pos)) try self.number() else null;
        }
        if (self.peek() != '}') return error.Unsupported;
        self.pos += 1;
        if (max != null and max.? < min) return error.Unsupported;
        return .{ min, max };
    }

    fn number(self: *Parser) Error!u8 {
        var value: u32 = 0;
        while (self.digitAt(self.pos)) : (self.pos += 1) {
            value = value * 10 + (self.pattern[self.pos] - '0');
            if (value > max_count) return error.Unsupported;
        }
        return @intCast(value);
    }

    fn digitAt(self: *const Parser, index: usize) bool {
        return index < self.pattern.len and std.ascii.isDigit(self.pattern[index]);
    }

    /// The node and whether a quantifier may follow it.
    fn atom(self: *Parser) Error!struct { u32, bool } {
        const c = self.pattern[self.pos];
        self.pos += 1;
        switch (c) {
            '(' => {
                self.depth += 1;
                const inner = try self.alternation();
                if (self.peek() != ')') return error.Unsupported;
                self.pos += 1;
                self.depth -= 1;
                return .{ inner, true };
            },
            '[' => return .{ try self.bracket(), true },
            '.' => return .{ try self.addSet(Set.initFull()), true },
            '^' => return .{ try self.add(.{ .assert = .bol }), false },
            '$' => return .{ try self.add(.{ .assert = .eol }), false },
            '*', '+', '?' => return error.Unsupported,
            '{' => {
                if (self.digitAt(self.pos)) return error.Unsupported;
                return .{ try self.literal(c), true };
            },
            '\\' => {
                const e = self.peek() orelse return error.Unsupported;
                self.pos += 1;
                switch (e) {
                    'b' => return .{ try self.add(.{ .assert = .word_boundary }), false },
                    'B' => return .{ try self.add(.{ .assert = .not_word_boundary }), false },
                    // TRE's enhanced escapes for word starts and ends and
                    // the text's ends.
                    '<', '>', '`', '\'' => return error.Unsupported,
                    else => {
                        if (std.ascii.isAlphanumeric(e) or e == 0) return error.Unsupported;
                        return .{ try self.literal(e), true };
                    },
                }
            },
            0 => return error.Unsupported,
            else => return .{ try self.literal(c), true },
        }
    }

    fn literal(self: *Parser, c: u8) Error!u32 {
        if (self.ignore_case and std.ascii.isAlphabetic(c)) {
            var set: Set = .initEmpty();
            set.set(c);
            return self.addSet(self.fold(set));
        }
        return self.add(.{ .byte = c });
    }

    /// With case ignored, `set` and every byte's other case.
    fn fold(self: *const Parser, set: Set) Set {
        if (!self.ignore_case) return set;
        var folded = set;
        for (0..256) |c| if (set.isSet(c)) {
            folded.set(std.ascii.toLower(@intCast(c)));
            folded.set(std.ascii.toUpper(@intCast(c)));
        };
        return folded;
    }

    fn addSet(self: *Parser, set: Set) Error!u32 {
        if (self.sets.items.len >= max_program) return error.Unsupported;
        try self.sets.append(self.alloc, set);
        return self.add(.{ .set = @intCast(self.sets.items.len - 1) });
    }

    /// The bracket expression after a `[`, through its `]`. POSIX brackets
    /// take no escapes: a backslash is itself.
    fn bracket(self: *Parser) Error!u32 {
        var set: Set = .initEmpty();
        var negate = false;
        if (self.peek() == '^') {
            negate = true;
            self.pos += 1;
        }
        var first = true;
        while (true) : (first = false) {
            const c = self.peek() orelse return error.Unsupported;
            if (c == ']' and !first) break;
            if (c == '[' and self.pos + 1 < self.pattern.len) switch (self.pattern[self.pos + 1]) {
                ':' => {
                    try self.class(&set);
                    if (self.peek() == '-' and self.pos + 1 < self.pattern.len and self.pattern[self.pos + 1] != ']') return error.Unsupported;
                    continue;
                },
                // Collating symbols and equivalence classes.
                '.', '=' => return error.Unsupported,
                else => {},
            };
            // A `-` is literal first or last; elsewhere only ranges use it.
            if (c == '-' and !first and !(self.pos + 1 < self.pattern.len and self.pattern[self.pos + 1] == ']')) return error.Unsupported;
            self.pos += 1;
            var high = c;
            if (self.peek() == '-' and self.pos + 1 < self.pattern.len and self.pattern[self.pos + 1] != ']') {
                high = self.pattern[self.pos + 1];
                if (high == '[' and self.pos + 2 < self.pattern.len and std.mem.indexOfScalar(u8, ":.=", self.pattern[self.pos + 2]) != null) return error.Unsupported;
                if (high < c) return error.Unsupported;
                self.pos += 2;
            }
            if (c == 0 or high == 0) return error.Unsupported;
            set.setRangeValue(.{ .start = c, .end = @as(usize, high) + 1 }, true);
        }
        self.pos += 1;
        // Fold before negating, so that ignoring case `[^a]` rejects `A`.
        set = self.fold(set);
        if (negate) set.toggleAll();
        return self.addSet(set);
    }

    /// A `[:name:]` class at pos, consumed, into `set`.
    fn class(self: *Parser, set: *Set) Error!void {
        const end = std.mem.indexOfPos(u8, self.pattern, self.pos + 2, ":]") orelse return error.Unsupported;
        const name = self.pattern[self.pos + 2 .. end];
        self.pos = end + 2;
        const Class = enum { space, alpha, alnum, xdigit, punct, cntrl };
        const which = std.meta.stringToEnum(Class, name) orelse return error.Unsupported;
        for (0..256) |c| {
            const b: u8 = @intCast(c);
            if (switch (which) {
                .space => std.ascii.isWhitespace(b),
                .alpha => std.ascii.isAlphabetic(b),
                .alnum => std.ascii.isAlphanumeric(b),
                .xdigit => std.ascii.isHex(b),
                .punct => std.ascii.isPunctuation(b),
                .cntrl => std.ascii.isControl(b),
            }) set.set(c);
        }
    }
};

// ---------------------------------------------------------------------------
// Code generation

fn emit(alloc: std.mem.Allocator, program: *std.ArrayList(Inst), nodes: []const Node, index: u32) Error!void {
    // Repetition copies its operand, so bound the output as it grows.
    if (program.items.len >= max_program) return error.Unsupported;
    switch (nodes[index]) {
        .byte => |c| try program.append(alloc, .{ .byte = c }),
        .set => |s| try program.append(alloc, .{ .set = s }),
        .assert => |a| try program.append(alloc, .{ .assert = a }),
        .empty => {},
        .concat => |pair| {
            try emit(alloc, program, nodes, pair[0]);
            try emit(alloc, program, nodes, pair[1]);
        },
        .alt => |pair| {
            const split = try placeholder(alloc, program);
            try emit(alloc, program, nodes, pair[0]);
            const jump = try placeholder(alloc, program);
            const second = try here(program);
            try emit(alloc, program, nodes, pair[1]);
            program.items[split] = .{ .split = .{ split + 1, second } };
            program.items[jump] = .{ .jump = try here(program) };
        },
        .repeat => |r| {
            for (0..r.min) |_| try emit(alloc, program, nodes, r.child);
            if (r.max) |max| {
                // x{0,n}: each optional copy may stop the run.
                var splits: std.ArrayList(u16) = .empty;
                defer splits.deinit(alloc);
                for (r.min..max) |_| {
                    try splits.append(alloc, try placeholder(alloc, program));
                    try emit(alloc, program, nodes, r.child);
                }
                const end = try here(program);
                for (splits.items) |split| program.items[split] = .{ .split = .{ split + 1, end } };
            } else {
                // x*: loop back to a split before the copy.
                const split = try placeholder(alloc, program);
                try emit(alloc, program, nodes, r.child);
                try program.append(alloc, .{ .jump = split });
                program.items[split] = .{ .split = .{ split + 1, try here(program) } };
            }
        },
    }
}

fn placeholder(alloc: std.mem.Allocator, program: *std.ArrayList(Inst)) Error!u16 {
    const at = try here(program);
    try program.append(alloc, .match);
    return at;
}

fn here(program: *const std.ArrayList(Inst)) Error!u16 {
    if (program.items.len >= max_program) return error.Unsupported;
    return @intCast(program.items.len);
}

/// Whether every match must begin with `^`.
fn startsAnchored(nodes: []const Node, index: u32) bool {
    return switch (nodes[index]) {
        .assert => |a| a == .bol,
        .concat => |pair| startsAnchored(nodes, pair[0]),
        .alt => |pair| startsAnchored(nodes, pair[0]) and startsAnchored(nodes, pair[1]),
        .repeat => |r| r.min > 0 and startsAnchored(nodes, r.child),
        else => false,
    };
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

fn expectMatches(pattern: []const u8, ignore_case: bool, yes: []const []const u8, no: []const []const u8) !void {
    const regex = try Regex.compile(testing.allocator, pattern, ignore_case);
    defer regex.deinit();
    for (yes) |text| testing.expect(regex.search(text)) catch |err| {
        std.debug.print("/{s}/ should match \"{f}\"\n", .{ pattern, std.zig.fmtString(text) });
        return err;
    };
    for (no) |text| testing.expect(!regex.search(text)) catch |err| {
        std.debug.print("/{s}/ should not match \"{f}\"\n", .{ pattern, std.zig.fmtString(text) });
        return err;
    };
}

fn expectUnsupported(pattern: []const u8) !void {
    testing.expectError(error.Unsupported, Regex.compile(testing.allocator, pattern, false)) catch |err| {
        std.debug.print("/{s}/ should not compile\n", .{pattern});
        return err;
    };
}

test "literals, dot and anchors" {
    try expectMatches("abc", false, &.{ "abc", "xxabcxx" }, &.{ "", "ab", "acb", "ABC" });
    try expectMatches("^abc$", false, &.{"abc"}, &.{ "abcd", "xabc", "" });
    try expectMatches("a.c", false, &.{ "abc", "a\nc", "a\x00c", "a\xffc" }, &.{ "ac", "abbc" });
    try expectMatches("^$", false, &.{""}, &.{"a"});
    try expectMatches("x^", false, &.{}, &.{ "x^", "x" });
    try expectMatches("x$y", false, &.{}, &.{"x$y"});
    try expectMatches("\\.\\*\\+\\?\\(\\)\\[\\{\\}\\|\\^\\$\\\\", false, &.{".*+?()[{}|^$\\"}, &.{"."});
    try expectMatches("\\-\\/", false, &.{"-/"}, &.{});
    try expectMatches("a}b)c", false, &.{"a}b)c"}, &.{"abc"});
    try expectMatches("a{x}", false, &.{"a{x}"}, &.{"a"});
    try expectMatches("a{,3}", false, &.{"a{,3}"}, &.{"a"});
}

test "case folding" {
    try expectMatches("^null$", true, &.{ "null", "NULL", "NuLl" }, &.{"nul"});
    try expectMatches("[a-c]x", true, &.{ "Bx", "bX" }, &.{"dx"});
    try expectMatches("[^a]", true, &.{"b"}, &.{ "a", "A" });
    try expectMatches("[^A-Z]", true, &.{ "1", "_" }, &.{ "b", "B" });
    try expectMatches("_1", true, &.{"_1"}, &.{});
    try expectMatches("^[A-Z]", false, &.{"Foo"}, &.{"foo"});
}

test "brackets" {
    try expectMatches("^[A-Z][A-Z0-9_]*$", false, &.{ "MAX_SIZE", "X", "ABC123" }, &.{ "Max", "_X", "", "A-B" });
    try expectMatches("[]a-]", false, &.{ "]", "a", "-" }, &.{"b"});
    try expectMatches("[^]a]", false, &.{"b"}, &.{ "]", "a", "" });
    try expectMatches("[--/]", false, &.{ "-", ".", "/" }, &.{"0"});
    try expectMatches("[%--]", false, &.{ ",", "%" }, &.{"."});
    try expectMatches("[]-a]", false, &.{ "^", "]", "a" }, &.{"b"});
    try expectMatches("[\\]", false, &.{"\\"}, &.{"]"});
    try expectMatches("[\\d]", false, &.{ "\\", "d" }, &.{"1"});
    try expectMatches("[a^]", false, &.{"^"}, &.{"b"});
    try expectMatches("[[]", false, &.{"["}, &.{"]"});
    try expectMatches("[[:space:]]", false, &.{ " ", "\t", "\n", "\x0b", "\x0c", "\r" }, &.{ "a", "\x00" });
    try expectMatches("^[[:alpha:]]+$", false, &.{ "abcXYZ", "Q" }, &.{ "a1", "\xc3\xa9" });
    try expectMatches("^[[:alnum:]_]+$", false, &.{ "x1", "_private" }, &.{"x-1"});
    try expectMatches("^[[:xdigit:]]+$", false, &.{ "09afAF", "dead" }, &.{"g"});
    try expectMatches("^[[:punct:]]+$", false, &.{ "!-/:@[`{~", "." }, &.{ "a", " ", "\x80" });
    try expectMatches("[[:cntrl:]]", false, &.{ "\x00", "\x1f", "\x7f" }, &.{ " ", "~" });
    try expectMatches("[^a]", false, &.{ "\x00", "\x80", "\n" }, &.{ "a", "" });
}

test "groups, alternation and repetition" {
    try expectMatches("^(self|super)\\.?$", false, &.{ "self", "super.", "super" }, &.{ "selfsuper", "sel", "super.." });
    try expectMatches("a|b|c", false, &.{ "c", "xbx" }, &.{"d"});
    try expectMatches("()", false, &.{ "", "x" }, &.{});
    try expectMatches("()*x", false, &.{"x"}, &.{""});
    try expectMatches("((a))", false, &.{"a"}, &.{"b"});
    try expectMatches("^a*$", false, &.{ "", "aaaa" }, &.{"ab"});
    try expectMatches("^a+$", false, &.{ "a", "aaaa" }, &.{ "", "ab" });
    try expectMatches("^ab?c$", false, &.{ "ac", "abc" }, &.{"abbc"});
    try expectMatches("^a{2}$", false, &.{"aa"}, &.{ "a", "aaa" });
    try expectMatches("^a{2,}$", false, &.{ "aa", "aaaaaa" }, &.{"a"});
    try expectMatches("^a{1,3}$", false, &.{ "a", "aa", "aaa" }, &.{ "", "aaaa" });
    try expectMatches("^a{0}b$", false, &.{"b"}, &.{"ab"});
    try expectMatches("^a{0,0}$", false, &.{""}, &.{"a"});
    try expectMatches("^a{01}$", false, &.{"a"}, &.{"aa"});
    try expectMatches("^(a{2}){2}$", false, &.{"aaaa"}, &.{"aaa"});
    try expectMatches("^(ab|cd)+$", false, &.{ "ab", "cdabcd" }, &.{ "abc", "" });
    try expectMatches("^x*?$", false, &.{ "", "xx" }, &.{"y"});
    try expectMatches("^x{2}?$", false, &.{"xx"}, &.{"x"});
    try expectMatches("^(a*)*b$", false, &.{ "b", "aab" }, &.{"aac"});
    try expectMatches("^(^|x)a", false, &.{ "a", "xa" }, &.{"ya"});
}

test "word boundaries follow TRE" {
    try expectMatches("\\bfoo\\b", false, &.{ "foo", "a foo", "foo.bar" }, &.{ "afoo", "foobar" });
    try expectMatches("\\Bfoo", false, &.{"afoo"}, &.{ "foo", " foo" });
    // At either end of the text \b holds and \B doesn't, whatever is there.
    try expectMatches("\\b", false, &.{ "", ".", "a" }, &.{});
    try expectMatches("\\B", false, &.{ "aa", ".." }, &.{ "", "a", "." });
    try expectMatches("\\b\\.", false, &.{".x"}, &.{" ."});
    try expectMatches("\\B$", false, &.{}, &.{ "a.", "aa" });
    try expectMatches("x\\B", false, &.{"xy"}, &.{ "x.", "x" });
    // So does a NUL, which also ends the text for `$`.
    try expectMatches("x\\b", false, &.{"x\x00y"}, &.{});
    try expectMatches("^a$", false, &.{ "a", "a\x00", "a\x00b" }, &.{"ab"});
    try expectMatches("a", false, &.{"\x00a"}, &.{});
}

test "outside the subset" {
    for ([_][]const u8{
        "",        "a|",      "|a",     "(|a)",    "(a|)",          "*a",            "(*a)",       "(+)",
        "a|*b",    "a**",     "a+*",    "a?{2}",   "a{1}{2}",       "a{1,2}{2}",     "x*??",       "^*",
        "$+",      "\\b*",    "{1}",    "a{1",     "a{1,2",         "a{2,1}",        "a{256}",     "(a",
        "[]",      "[a",      "[z-a]",  "[a-c-e]", "[[:alpha:]-z]", "[a-[:alpha:]]", "[[:alpha]]", "[[:upper:]]",
        "[[.a.]]", "[[=a=]]", "a\\",    "\\d",     "\\w",           "\\n",           "\\1",        "\\<a",
        "a\\>",    "\\`a",    "a\x00b", "[\x00]",
    }) |pattern| try expectUnsupported(pattern);
    try expectMatches("a{255}", false, &.{"a" ** 255}, &.{"a" ** 254});
}

test "pathological patterns stay linear" {
    const text = "a" ** 4000 ++ "c";
    try expectMatches("(a*)*b", false, &.{}, &.{text});
    try expectMatches("^(a|a)*b$", false, &.{}, &.{text});
    try expectMatches("(a|aa)+$", false, &.{text[0..4000]}, &.{});
    try expectMatches("(x+x+)+y", false, &.{}, &.{"x" ** 5000});
}

test "programs too large are Unsupported" {
    try expectUnsupported("(a{255}){255}");
    try expectUnsupported("((((a{1,255}){1,255}){1,255}){1,255})");
}

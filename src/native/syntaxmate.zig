//! TextMate tokenizing with syntaxmate, the Rust tokenizer in
//! src/native/syntaxmate, which build.zig links as a static library.
//!
//! A `Grammar` is one root language: on first use it hands syntaxmate the
//! JSON of every bundled grammar the root reaches (its includes and the
//! grammars injected into it, transitively) and keeps the prepared language
//! for the process. Tokenizing takes the grammar's lock, so two threads on
//! one language take turns; different languages run in parallel.

const std = @import("std");
const builtin = @import("builtin");

const c = struct {
    const Str = extern struct { ptr: [*]const u8, len: usize };
    const Prepared = opaque {};
    const Tokenizer = opaque {};
    const StackFn = *const fn (context: *anyopaque, stack: u32, names: [*]const Str, count: usize) callconv(.c) void;
    const TokenFn = *const fn (context: *anyopaque, start: u32, end: u32, stack: u32) callconv(.c) void;
    const StopFn = *const fn (context: *anyopaque) callconv(.c) bool;
    extern fn patch_sm_language_new(grammars: [*]const Str, count: usize, max_line_bytes: usize) ?*Prepared;
    extern fn patch_sm_run_new(language: *Prepared) ?*Tokenizer;
    extern fn patch_sm_run_free(run: ?*Tokenizer) void;
    extern fn patch_sm_monotonic_ns() u64;
    extern fn patch_sm_run_line(run: *Tokenizer, line: [*]const u8, length: usize, context: *anyopaque, on_stack: StackFn, on_token: TokenFn, on_stop: StopFn) i32;
};

/// Nanoseconds on a monotonic clock, for time budgets.
pub const monotonicNs = c.patch_sm_monotonic_ns;

/// A process-wide lock without an `Io`: pthreads, or an SRW lock on Windows,
/// which has no pthreads in its libc.
const Lock = if (builtin.os.tag == .windows) struct {
    const windows = std.os.windows;
    inner: windows.SRWLOCK = windows.SRWLOCK_INIT,
    fn lock(self: *Lock) void {
        windows.ntdll.RtlAcquireSRWLockExclusive(&self.inner);
    }
    fn unlock(self: *Lock) void {
        windows.ntdll.RtlReleaseSRWLockExclusive(&self.inner);
    }
} else struct {
    inner: std.c.pthread_mutex_t = std.c.PTHREAD_MUTEX_INITIALIZER,
    fn lock(self: *Lock) void {
        _ = std.c.pthread_mutex_lock(&self.inner);
    }
    fn unlock(self: *Lock) void {
        _ = std.c.pthread_mutex_unlock(&self.inner);
    }
};

/// The bundled grammars, by index: each one's JSON and the grammars it
/// includes, and the grammars injected into a root.
pub const Catalog = struct {
    files: []const []const u8,
    dependencies: []const []const u16,
    injections: *const fn (root: u16) []const u16,
};

/// Longer lines stay plain and leave the state as it was, as in VS Code.
pub const max_line_bytes = 20_000;

pub const Limits = struct {
    deadline: u64,
    stop: ?*const std.atomic.Value(bool) = null,

    fn expired(self: Limits) bool {
        if (monotonicNs() >= self.deadline) return true;
        if (self.stop) |stop| if (stop.load(.monotonic)) return true;
        return false;
    }
};

/// A scope stack: its number in the run's `Stacks`, with what the sink's
/// `classify` made of it in the top byte, so a token's sink reads the value
/// alone.
pub const Stack = packed struct(u32) { index: u24, value: u8 };

/// The scope stacks of one run, by number: each one's scope names,
/// outermost first.
pub const Stacks = struct {
    names: std.ArrayList([]const []const u8) = .empty,

    pub fn namesOf(self: *const Stacks, stack: Stack) []const []const u8 {
        return self.names.items[stack.index];
    }
};

pub const Sink = struct {
    context: *anyopaque,
    /// A new line starts: tokens until the next call belong to it.
    begin_line: *const fn (context: *anyopaque, index: usize) void,
    /// Bytes [start, end) of the line carry `stack`.
    produce: *const fn (context: *anyopaque, start: u32, end: u32, stack: Stack, stacks: *const Stacks) void,
    /// The value a scope gets from its name and the value of the stack it is
    /// pushed on.
    classify: *const fn (parent: ?u8, name: []const u8) u8,
};

pub const Grammar = struct {
    root: u16,
    lock: Lock = .{},
    state: enum { unloaded, ready, failed } = .unloaded,
    language: ?*c.Prepared = null,

    pub fn init(root: u16) Grammar {
        return .{ .root = root };
    }

    /// Prepares the language on first use.
    fn prepare(self: *Grammar, catalog: Catalog) !*c.Prepared {
        switch (self.state) {
            .ready => return self.language.?,
            .failed => return error.NoGrammar,
            .unloaded => {},
        }
        self.state = .failed;
        var arena: std.heap.ArenaAllocator = .init(std.heap.c_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        // The root, then everything it reaches, each once.
        var reached: std.AutoArrayHashMapUnmanaged(u16, void) = .empty;
        try reached.put(a, self.root, {});
        for (catalog.injections(self.root)) |injected| try reached.put(a, injected, {});
        var next: usize = 0;
        while (next < reached.count()) : (next += 1) {
            for (catalog.dependencies[reached.keys()[next]]) |dependency| try reached.put(a, dependency, {});
        }
        const texts = try a.alloc(c.Str, reached.count());
        for (texts, reached.keys()) |*text, index| {
            const file = catalog.files[index];
            text.* = .{ .ptr = file.ptr, .len = file.len };
        }
        self.language = c.patch_sm_language_new(texts.ptr, texts.len, max_line_bytes + 1) orelse return error.NoGrammar;
        self.state = .ready;
        return self.language.?;
    }

    /// Whether syntaxmate takes the grammars the language reaches.
    pub fn loads(self: *Grammar, catalog: Catalog) bool {
        self.lock.lock();
        defer self.lock.unlock();
        _ = self.prepare(catalog) catch return false;
        return true;
    }

    /// Tokenizes `source` line by line, calling `sink` with each token's
    /// scope stack. Returns how many lines it finished before `deadline` (or
    /// `stop`) cut it short; all of them when it didn't.
    pub fn tokenize(self: *Grammar, gpa: std.mem.Allocator, catalog: Catalog, source: []const u8, sink: Sink, limits: Limits) !usize {
        self.lock.lock();
        defer self.lock.unlock();
        const language = try self.prepare(catalog);
        const handle = c.patch_sm_run_new(language) orelse return error.OutOfMemory;
        defer c.patch_sm_run_free(handle);
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        var run: Run = .{ .alloc = arena.allocator(), .sink = sink, .limits = limits };
        var start: usize = 0;
        var index: usize = 0;
        while (true) : (index += 1) {
            if (limits.expired()) return index;
            const newline = std.mem.indexOfScalarPos(u8, source, start, '\n') orelse source.len;
            var end = newline;
            if (end > start and source[end - 1] == '\r') end -= 1;
            const content = source[start..end];
            sink.begin_line(sink.context, index);
            if (content.len <= max_line_bytes) {
                const status = c.patch_sm_run_line(handle, content.ptr, content.len, &run, Run.onStack, Run.onToken, Run.onStop);
                if (status < 0) return error.TokenizeFailed;
                // Out of time or cancelled partway through the line.
                if (status == 2) return index;
                if (run.failed) return error.OutOfMemory;
            }
            if (newline == source.len) return index + 1;
            start = newline + 1;
        }
    }
};

const Run = struct {
    alloc: std.mem.Allocator,
    sink: Sink,
    limits: Limits,
    stacks: Stacks = .{},
    values: std.ArrayList(u8) = .empty,
    failed: bool = false,

    fn onStack(context: *anyopaque, number: u32, names: [*]const c.Str, count: usize) callconv(.c) void {
        const self: *Run = @ptrCast(@alignCast(context));
        self.addStack(number, names[0..count]) catch {
            self.failed = true;
        };
    }

    fn addStack(self: *Run, number: u32, names: []const c.Str) !void {
        // Stacks arrive numbered in order.
        if (number != self.stacks.names.items.len or number > std.math.maxInt(u24)) return error.OutOfMemory;
        const owned = try self.alloc.alloc([]const u8, names.len);
        var value: ?u8 = null;
        for (owned, names) |*name, raw| {
            name.* = try self.alloc.dupe(u8, raw.ptr[0..raw.len]);
            value = self.sink.classify(value, name.*);
        }
        try self.stacks.names.append(self.alloc, owned);
        try self.values.append(self.alloc, value orelse self.sink.classify(null, ""));
    }

    fn onStop(context: *anyopaque) callconv(.c) bool {
        const self: *Run = @ptrCast(@alignCast(context));
        return self.limits.expired();
    }

    fn onToken(context: *anyopaque, start: u32, end: u32, number: u32) callconv(.c) void {
        const self: *Run = @ptrCast(@alignCast(context));
        if (self.failed or number >= self.values.items.len) return;
        const stack: Stack = .{ .index = @intCast(number), .value = self.values.items[number] };
        self.sink.produce(self.sink.context, start, end, stack, &self.stacks);
    }
};

/// `scopesAreMatching`: `name` is `prefix` or starts with it and a dot.
pub fn scopeMatches(name: []const u8, prefix: []const u8) bool {
    if (std.mem.eql(u8, name, prefix)) return true;
    return name.len > prefix.len and std.mem.startsWith(u8, name, prefix) and name[prefix.len] == '.';
}

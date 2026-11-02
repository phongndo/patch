//! `zig build bench-highlight -- FILE...` times `highlight.highlight` on each
//! file (ReleaseFast): the first call, which compiles the language's query,
//! then the best and median of several more. With `--dump` first, prints
//! each line's tokens instead; with `--scopes`, each token's TextMate scopes.

const std = @import("std");
const highlight = @import("highlight.zig");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &buffer);
    const out = &writer.interface;
    if (args.len > 1 and std.mem.eql(u8, args[1], "--scopes")) {
        for (args[2..]) |path| {
            const source = try std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(64 * 1024 * 1024));
            defer gpa.free(source);
            const language = highlight.languageForSource(path, source) orelse continue;
            try out.print("F {s} {s}\n", .{ path, highlight.scopeName(language) });
            try highlight.writeScopes(gpa, language, source, out);
        }
        return out.flush();
    }
    if (args.len > 1 and std.mem.eql(u8, args[1], "--dump")) {
        for (args[2..]) |path| try dump(gpa, io, out, path);
        return out.flush();
    }
    try out.print("{s:<48} {s:>8} {s:>8} {s:>10} {s:>10} {s:>10} {s:>8}\n", .{ "file", "lines", "KiB", "first ms", "best ms", "median ms", "tokens" });
    for (args[1..]) |path| {
        const language = highlight.languageFor(path) orelse {
            try out.print("{s:<48} no language\n", .{path});
            continue;
        };
        const source = try std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(64 * 1024 * 1024));
        defer gpa.free(source);
        var samples: [15]u64 = undefined;
        var first: u64 = 0;
        var tokens: usize = 0;
        var lines: usize = 0;
        for (0..samples.len + 1) |round| {
            const start = std.Io.Clock.awake.now(io).nanoseconds;
            const result = try highlight.highlight(gpa, language, source);
            const elapsed: u64 = @intCast(std.Io.Clock.awake.now(io).nanoseconds - start);
            tokens = result.tokens.len;
            lines = result.lines.len - 1;
            result.deinit(gpa);
            if (round == 0) first = elapsed else samples[round - 1] = elapsed;
        }
        std.mem.sort(u64, &samples, {}, std.sort.asc(u64));
        const ms = struct {
            fn f(ns: u64) f64 {
                return @as(f64, @floatFromInt(ns)) / std.time.ns_per_ms;
            }
        }.f;
        try out.print("{s:<48} {d:>8} {d:>8} {d:>10.2} {d:>10.2} {d:>10.2} {d:>8}\n", .{ path, lines, source.len / 1024, ms(first), ms(samples[0]), ms(samples[samples.len / 2]), tokens });
        try out.flush();
    }
    try out.flush();
}

fn dump(gpa: std.mem.Allocator, io: std.Io, out: *std.Io.Writer, path: []const u8) !void {
    const language = highlight.languageFor(path) orelse return out.print("{s}: no language\n", .{path});
    const source = try std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(64 * 1024 * 1024));
    defer gpa.free(source);
    const result = try highlight.highlight(gpa, language, source);
    defer result.deinit(gpa);
    var lines = std.mem.splitScalar(u8, source, '\n');
    var index: usize = 0;
    while (lines.next()) |text| : (index += 1) {
        try out.print("{d:>4} {s}\n", .{ index + 1, text });
        for (result.line(index)) |token| try out.print("       {t} \"{s}\"\n", .{ token.kind, text[token.start..token.end] });
    }
}

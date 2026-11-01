const std = @import("std");
const sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dependency = b.dependency("native_sdk", .{});
    const app = sdk.addAppArtifacts(b, dependency, .{ .name = "patch" });
    const host_tests = b.step("test-native-host", "Check native text pixels and transform roundoff bounds");
    if (app.exe.root_module.resolved_target.?.result.os.tag == .macos) {
        const flags: []const []const u8 = if (b.sysroot) |sdk_path| &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } else &.{ "-fobjc-arc", "-fno-sanitize=builtin" };
        app.exe.root_module.addCSourceFile(.{ .file = b.path("src/native/glass.m"), .flags = flags });
        const canonical = b.option(bool, "canonical-transforms", "Remove subpixel icon-transform roundoff in the pinned macOS host") orelse true;
        const opaque_blur = b.option(bool, "opaque-blur", "Copy fully opaque native blur results without blending") orelse true;
        const coretext = b.option(bool, "coretext-lines", "Draw complete printable ASCII packet lines through CoreText") orelse true;
        const retain_identical = b.option(bool, "retain-identical-commands", "Preserve native rasters when a decoded command is unchanged") orelse true;
        if (canonical or opaque_blur or coretext or retain_identical) patchMacHost(b, dependency, app.exe.root_module, canonical, opaque_blur, coretext, retain_identical);
        const text_test = b.addExecutable(.{ .name = "packet-text-test", .root_module = b.createModule(.{ .target = b.graph.host, .optimize = .ReleaseSafe, .link_libc = true }) });
        text_test.root_module.addCSourceFile(.{ .file = b.path("src/native/packet_text_test.m"), .flags = flags });
        if (b.sysroot) |sysroot| text_test.root_module.addSystemFrameworkPath(.{ .cwd_relative = b.fmt("{s}/System/Library/Frameworks", .{sysroot}) });
        text_test.root_module.linkFramework("AppKit", .{});
        text_test.root_module.linkFramework("CoreText", .{});
        host_tests.dependOn(&b.addRunArtifact(text_test).step);
    }
    const blur_damage = b.option(bool, "blur-damage-footprint", "Repaint only the read footprint of a reached backdrop blur, not the whole surface") orelse true;
    if (blur_damage) overlayCanvasFrame(b, dependency, app.exe.root_module);
    const highlighter = addHighlighter(b, app.exe.root_module.resolved_target.?);
    highlighter.link(app.exe.root_module);
    const highlight_tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/native/highlight.zig"),
        .target = app.exe.root_module.resolved_target.?,
        .optimize = app.exe.root_module.optimize.?,
        .link_libc = true,
    }) });
    highlighter.link(highlight_tests.root_module);
    b.step("test-highlight", "Check tree-sitter syntax highlighting").dependOn(&b.addRunArtifact(highlight_tests).step);
    const highlight_bench = b.addExecutable(.{ .name = "highlight-bench", .root_module = b.createModule(.{
        .root_source_file = b.path("src/native/highlight_bench.zig"),
        .target = app.exe.root_module.resolved_target.?,
        .optimize = .ReleaseFast,
        .link_libc = true,
    }) });
    highlighter.link(highlight_bench.root_module);
    const bench_run = b.addRunArtifact(highlight_bench);
    if (b.args) |args| bench_run.addArgs(args);
    b.step("bench-highlight", "Time highlighting of the files given after --").dependOn(&bench_run.step);
    if (b.args) |args| app.run.addArgs(args);
    const host_test = b.addExecutable(.{ .name = "packet-transform-test", .root_module = b.createModule(.{ .target = b.graph.host, .optimize = .ReleaseSafe, .link_libc = true }) });
    host_test.root_module.addCSourceFile(.{ .file = b.path("src/native/packet_transform_test.c") });
    host_tests.dependOn(&b.addRunArtifact(host_test).step);
}

// Generate a build-local overlay; never mutate the fetched SDK. Fail closed
// on an upstream source change so the workaround is reviewed with each pin.
fn patchMacHost(b: *std.Build, dependency: *std.Build.Dependency, module: *std.Build.Module, canonical: bool, opaque_blur: bool, coretext: bool, retain_identical: bool) void {
    const path = dependency.path("src/platform/macos/appkit_host.m");
    const source = std.Io.Dir.cwd().readFileAlloc(b.graph.io, path.getPath(b), b.allocator, .limited(2 * 1024 * 1024)) catch @panic("cannot read pinned macOS host");
    const replacement =
        \\        if (!patch_transform_is_roundoff(
        \\            [transform[0] doubleValue], [transform[1] doubleValue],
        \\            [transform[2] doubleValue], [transform[3] doubleValue],
        \\            [transform[4] doubleValue], [transform[5] doubleValue],
        \\            [bounds[0] doubleValue], [bounds[1] doubleValue],
        \\            [bounds[2] doubleValue], [bounds[3] doubleValue]))
        \\            command[@"transform"] = transform;
    ;
    var patched: []const u8 = source;
    if (canonical) patched = replaceOnce(b, patched, "        command[@\"transform\"] = transform;", replacement);
    if (opaque_blur) patched = replaceOnce(b, patched, "    for (NSUInteger y = minY; y < maxY; y++) {", opaque_blur_copy ++ "\n    for (NSUInteger y = minY; y < maxY; y++) {");
    // Float noise that vanishes in decoding would otherwise rebuild hundreds
    // of unchanged text rasters; every field takes part in the comparison.
    if (retain_identical) patched = replaceOnce(b, patched, "            self.canvasRetainedCommands[key] = command;", "            if ([self.canvasRetainedCommands[key] isEqualToDictionary:command]) continue;\n            self.canvasRetainedCommands[key] = command;");
    patched = b.fmt("#include \"packet_transform.h\"\n{s}", .{patched});
    if (coretext) {
        patched = replaceOnce(b, patched, "    NSTextStorage *storage = [[NSTextStorage alloc] initWithString:value attributes:attributes];", "    if (patch_try_draw_packet_line(value, attributes, x, baseline, width, height)) return YES;\n    NSTextStorage *storage = [[NSTextStorage alloc] initWithString:value attributes:attributes];");
        patched = b.fmt("#include \"packet_text.h\"\n{s}", .{patched});
    }
    const generated = b.addWriteFiles().add("patch_appkit_host.m", patched);
    module.addIncludePath(dependency.path("src/platform/macos"));
    module.addIncludePath(b.path("src/native"));
    for (module.link_objects.items) |object| switch (object) {
        .c_source_file => |file| if (std.mem.eql(u8, file.file.getPath(b), path.getPath(b))) {
            file.file = generated;
            return;
        },
        else => {},
    };
    @panic("pinned macOS host source was not linked");
}

const opaque_blur_copy =
    \\    if (mix == 1.0) {
    \\        for (NSUInteger y = minY; y < maxY; y++) {
    \\            memcpy(destination + y * bytesPerRow + minX * 4,
    \\                   firstPass + (y - expandedMinY) * regionBytesPerRow + (minX - expandedMinX) * 4,
    \\                   (maxX - minX) * 4);
    \\        }
    \\        return YES;
    \\    }
;

fn replaceOnce(b: *std.Build, source: []const u8, anchor: []const u8, replacement: []const u8) []const u8 {
    const at = std.mem.indexOf(u8, source, anchor) orelse @panic("SDK overlay needs review for this SDK pin");
    if (std.mem.indexOf(u8, source[at + anchor.len ..], anchor) != null) @panic("ambiguous SDK overlay");
    return b.fmt("{s}{s}{s}", .{ source[0..at], replacement, source[at + anchor.len ..] });
}

// The pinned frame planner repaints the whole surface whenever damage reaches
// a backdrop blur's read footprint, so every keystroke in the frosted command
// palette redrew the full window. Point the SDK module at a build-local copy
// of its sources whose planner widens the scissor to the reached footprints.
fn overlayCanvasFrame(b: *std.Build, dependency: *std.Build.Dependency, root: *std.Build.Module) void {
    const planner = "runtime/canvas_frame.zig";
    const path = dependency.path("src/" ++ planner);
    const source = std.Io.Dir.cwd().readFileAlloc(b.graph.io, path.getPath(b), b.allocator, .limited(4 * 1024 * 1024)) catch @panic("cannot read pinned canvas frame planner");
    const files = b.addWriteFiles();
    _ = files.addCopyDirectory(dependency.path("src"), "src", .{ .exclude_extensions = &.{planner} });
    _ = files.add("src/" ++ planner, replaceOnce(b, source, blur_damage_anchor, blur_damage_replacement));
    const module = root.import_table.get("native_sdk") orelse @panic("native_sdk module was not imported");
    module.root_source_file = files.getDirectory().path(b, "src/root.zig");
}

const blur_damage_anchor =
    \\                // footprint; damage elsewhere remains incremental.
    \\                full_repaint = true;
    \\                changes = storage.changes[0..0];
    \\                dirty_bounds = canvasFullRepaintBoundsWithPolicy(frame_options.surface_size, render_plan.bounds, frame_options.render_cache_policy);
    \\                dirty_rect_count = 0;
    \\
;

// Inside the widened scissor the list replays in draw order onto cleared
// pixels, so each blur samples the backdrop a full repaint would give it, and
// nothing outside the scissor changed. Past half the surface a scissored
// replay saves little, so that case keeps the full repaint. The limit also
// avoids a known mismatch: an oversized fill drawn directly under the scissor
// (not blitted from the raster cache) differs from a full redraw by one alpha
// level where a scissor edge crosses a rounded corner. The same risk applies
// to the SDK's own incremental updates.
const blur_damage_replacement =
    \\                // footprint; damage elsewhere remains incremental.
    \\                const patch_widened: ?geometry.RectF = widen: {
    \\                    var area = (dirty_bounds orelse break :widen null).normalized();
    \\                    const requested = frame_options.backdrop_blur_sample_extent_multiplier;
    \\                    const multiplier: f32 = if (std.math.isFinite(requested)) @max(1, requested) else 1;
    \\                    var grew = true;
    \\                    var passes: usize = 0;
    \\                    while (grew and passes <= render_plan.commands.len) : (passes += 1) {
    \\                        grew = false;
    \\                        for (render_plan.commands) |command| {
    \\                            const blur = switch (command.command) {
    \\                                .blur => |value| value,
    \\                                else => continue,
    \\                            };
    \\                            if (!(blur.radius > 0) or !(command.opacity > 0)) continue;
    \\                            var output = command.transform.transformRect(blur.rect.normalized());
    \\                            if (command.clip) |clip| output = geometry.RectF.intersection(output, clip.normalized());
    \\                            if (output.isEmpty()) continue;
    \\                            const footprint = if (multiplier == 1)
    \\                                command.transform.transformRect(blur.rect.normalized().inflate(geometry.InsetsF.all(@max(0, blur.radius)))).normalized()
    \\                            else extended: {
    \\                                const t = command.transform;
    \\                                const axis_scale = @max(0.0001, @max(@sqrt(t.a * t.a + t.b * t.b), @sqrt(t.c * t.c + t.d * t.d)));
    \\                                break :extended output.normalized().inflate(geometry.InsetsF.all(@max(0, blur.radius) * axis_scale * multiplier));
    \\                            };
    \\                            if (!footprint.intersects(area) or area.containsRect(footprint)) continue;
    \\                            area = geometry.RectF.unionWith(area, footprint);
    \\                            grew = true;
    \\                        }
    \\                    }
    \\                    break :widen bleedAlignedCanvasDirtyBounds(area, frame_options.scale, 1, frame_options.surface_size);
    \\                };
    \\                const patch_surface_area = frame_options.surface_size.width * frame_options.surface_size.height;
    \\                if (patch_widened != null and patch_widened.?.width * patch_widened.?.height <= patch_surface_area * 0.5) {
    \\                    dirty_bounds = patch_widened;
    \\                    dirty_rect_count = 0;
    \\                } else {
    \\                    full_repaint = true;
    \\                    changes = storage.changes[0..0];
    \\                    dirty_bounds = canvasFullRepaintBoundsWithPolicy(frame_options.surface_size, render_plan.bounds, frame_options.render_cache_policy);
    \\                    dirty_rect_count = 0;
    \\                }
    \\
;

// Tree-sitter syntax highlighting: the runtime, every grammar below and the
// highlight and injection queries each grammar ships, pinned in
// build.zig.zon. The parsers are huge generated tables, so they always build
// optimized whatever the app's mode. Queries listed together are joined in
// the order the grammar's tree-sitter.json (or, for nvim-style queries, their
// `; inherits:` line) gives; highlight.zig explains which pattern wins.
// src/native/queries holds the few local fixes, each appended last.
const Query = union(enum) {
    /// A file in the grammar's own package.
    own: []const u8,
    /// A file in another grammar's package.
    dep: struct { []const u8, []const u8 },
    /// A file vendored in this repository.
    local: []const u8,
};
const Grammar = struct {
    /// The `highlight.Language` tag; the parser exports `tree_sitter_<name>`.
    name: []const u8,
    dep: []const u8,
    /// The directory holding `parser.c` and any `scanner.c`.
    src: []const u8 = "src",
    highlights: []const Query,
    injections: []const Query = &.{},
    /// The query is written for Atom's rule, where the first pattern to
    /// capture a node wins, rather than tree-sitter-highlight's last.
    first_wins: bool = false,
};
const html_injections: []const Query = &.{.{ .dep = .{ "ts_html", "queries/injections.scm" } }};
const js_injections: []const Query = &.{.{ .dep = .{ "ts_javascript", "queries/injections.scm" } }};
const js_highlights: Query = .{ .dep = .{ "ts_javascript", "queries/highlights.scm" } };
const jsx_highlights: Query = .{ .dep = .{ "ts_javascript", "queries/highlights-jsx.scm" } };
const html_quotes: Query = .{ .local = "src/native/queries/html/highlights.scm" };
const c_highlights: Query = .{ .dep = .{ "ts_c", "queries/highlights.scm" } };
const grammars = [_]Grammar{
    .{ .name = "c", .dep = "ts_c", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "cpp", .dep = "ts_cpp", .highlights = &.{ c_highlights, .{ .own = "queries/highlights.scm" } } },
    .{ .name = "objc", .dep = "ts_objc", .highlights = &.{ c_highlights, .{ .own = "queries/highlights.scm" } } },
    .{ .name = "rust", .dep = "ts_rust", .highlights = &.{ .{ .own = "queries/highlights.scm" }, .{ .local = "src/native/queries/rust/highlights.scm" } } },
    .{ .name = "go", .dep = "ts_go", .highlights = &.{.{ .own = "queries/highlights.scm" }}, .first_wins = true },
    .{ .name = "python", .dep = "ts_python", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "javascript", .dep = "ts_javascript", .highlights = &.{ js_highlights, jsx_highlights, .{ .own = "queries/highlights-params.scm" } }, .injections = js_injections },
    .{ .name = "typescript", .dep = "ts_typescript", .src = "typescript/src", .highlights = &.{ .{ .own = "queries/highlights.scm" }, js_highlights }, .injections = js_injections },
    .{ .name = "tsx", .dep = "ts_typescript", .src = "tsx/src", .highlights = &.{ .{ .own = "queries/highlights.scm" }, jsx_highlights, js_highlights }, .injections = js_injections },
    .{ .name = "zig", .dep = "ts_zig", .highlights = &.{ .{ .own = "queries/highlights.scm" }, .{ .local = "src/native/queries/zig/highlights.scm" } } },
    .{ .name = "java", .dep = "ts_java", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "kotlin", .dep = "ts_kotlin", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "swift", .dep = "ts_swift", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "c_sharp", .dep = "ts_c_sharp", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "ruby", .dep = "ts_ruby", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "php", .dep = "ts_php", .src = "php/src", .highlights = &.{.{ .own = "queries/highlights.scm" }}, .injections = &.{ .{ .own = "queries/injections-text.scm" }, .{ .own = "queries/injections.scm" } } },
    .{ .name = "lua", .dep = "ts_lua", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "bash", .dep = "ts_bash", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "nix", .dep = "ts_nix", .highlights = &.{.{ .own = "queries/highlights.scm" }}, .first_wins = true },
    .{ .name = "json", .dep = "ts_json", .highlights = &.{ .{ .own = "queries/highlights.scm" }, .{ .local = "src/native/queries/json/highlights.scm" } } },
    .{ .name = "yaml", .dep = "ts_yaml", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "toml", .dep = "ts_toml", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "css", .dep = "ts_css", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "scss", .dep = "ts_scss", .highlights = &.{ .{ .dep = .{ "ts_css", "queries/highlights.scm" } }, .{ .own = "queries/highlights.scm" } } },
    .{ .name = "html", .dep = "ts_html", .highlights = &.{ .{ .own = "queries/highlights.scm" }, html_quotes }, .injections = html_injections },
    .{ .name = "markdown", .dep = "ts_markdown", .src = "tree-sitter-markdown/src", .highlights = &.{.{ .own = "tree-sitter-markdown/queries/highlights.scm" }}, .injections = &.{.{ .own = "tree-sitter-markdown/queries/injections.scm" }} },
    .{ .name = "markdown_inline", .dep = "ts_markdown", .src = "tree-sitter-markdown-inline/src", .highlights = &.{.{ .own = "tree-sitter-markdown-inline/queries/highlights.scm" }}, .injections = &.{.{ .own = "tree-sitter-markdown-inline/queries/injections.scm" }} },
    .{ .name = "sql", .dep = "ts_sql", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "make", .dep = "ts_make", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "dockerfile", .dep = "ts_dockerfile", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "cmake", .dep = "ts_cmake", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "haskell", .dep = "ts_haskell", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "ocaml", .dep = "ts_ocaml", .src = "grammars/ocaml/src", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "elixir", .dep = "ts_elixir", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "scala", .dep = "ts_scala", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "dart", .dep = "ts_dart", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "proto", .dep = "ts_proto", .highlights = &.{.{ .own = "queries/highlights.scm" }} },
    .{ .name = "graphql", .dep = "ts_graphql", .highlights = &.{.{ .own = "queries/graphql/highlights.scm" }} },
    .{ .name = "hcl", .dep = "ts_hcl", .highlights = &.{.{ .local = "src/native/queries/hcl/highlights.scm" }} },
    .{ .name = "vue", .dep = "ts_vue", .highlights = &.{ .{ .own = "queries/html_tags/highlights.scm" }, .{ .own = "queries/vue/highlights.scm" } }, .injections = &.{ .{ .own = "queries/html_tags/injections.scm" }, .{ .own = "queries/vue/injections.scm" } } },
    .{ .name = "svelte", .dep = "ts_svelte", .highlights = &.{ .{ .dep = .{ "ts_html", "queries/highlights.scm" } }, html_quotes, .{ .own = "queries/highlights.scm" } }, .injections = &.{ html_injections[0], .{ .own = "queries/injections.scm" } } },
};

const Highlighter = struct {
    library: *std.Build.Step.Compile,
    grammars: *std.Build.Module,
    fn link(self: Highlighter, module: *std.Build.Module) void {
        module.linkLibrary(self.library);
        module.addImport("highlight_grammars", self.grammars);
    }
};

fn addHighlighter(b: *std.Build, target: std.Build.ResolvedTarget) Highlighter {
    // The grammars' tables are most of the binary (about 53 MB of 64), so a
    // build can keep only some, e.g. -Dhighlight-languages=c -Dhighlight-languages=zig.
    const only = b.option([]const []const u8, "highlight-languages", "Grammars to compile in (repeatable; default all); others stay plain");
    if (only) |names| for (names) |name| {
        for (grammars) |grammar| {
            if (std.mem.eql(u8, grammar.name, name)) break;
        } else std.debug.panic("-Dhighlight-languages: no grammar named '{s}'", .{name});
    };
    const runtime = b.dependency("tree_sitter", .{});
    const module = b.createModule(.{ .target = target, .optimize = .ReleaseFast, .link_libc = true });
    const library = b.addLibrary(.{ .name = "patch-highlight", .linkage = .static, .root_module = module });
    module.addIncludePath(runtime.path("lib/include"));
    module.addIncludePath(runtime.path("lib/src"));
    module.addCSourceFile(.{ .file = runtime.path("lib/src/lib.c"), .flags = &.{ "-std=c11", "-D_POSIX_C_SOURCE=200112L", "-D_DEFAULT_SOURCE", "-D_DARWIN_C_SOURCE" } });
    module.addCSourceFile(.{ .file = b.path("src/native/highlight_support.c"), .flags = &.{"-std=gnu11"} });

    const files = b.addWriteFiles();
    var zig: std.ArrayList(u8) = .empty;
    zig.appendSlice(b.allocator,
        \\// Generated by build.zig: each grammar's parser and its joined queries.
        \\pub const Grammar = struct {
        \\    /// Null when the build left the grammar out.
        \\    language: ?*const fn () callconv(.c) *const anyopaque,
        \\    highlights: []const u8,
        \\    injections: []const u8,
        \\    first_wins: bool,
        \\};
        \\
    ) catch @panic("OOM");
    for (grammars) |grammar| {
        const wanted = if (only) |names| for (names) |name| {
            if (std.mem.eql(u8, name, grammar.name)) break true;
        } else false else true;
        if (!wanted) {
            zig.print(b.allocator, "pub const {s}: Grammar = .{{ .language = null, .highlights = \"\", .injections = \"\", .first_wins = false }};\n", .{grammar.name}) catch @panic("OOM");
            continue;
        }
        const dep = b.dependency(grammar.dep, .{});
        const src = dep.path(grammar.src);
        // Scanners reach `tree_sitter/*.h` from shared directories too, so
        // each grammar's sources see its own headers first.
        const flags = b.allocator.dupe([]const u8, &.{ "-std=gnu11", b.fmt("-I{s}", .{src.getPath(b)}) }) catch @panic("OOM");
        module.addCSourceFile(.{ .file = src.path(b, "parser.c"), .flags = flags });
        const scanner = b.pathJoin(&.{ src.getPath(b), "scanner.c" });
        if (std.Io.Dir.cwd().access(b.graph.io, scanner, .{})) |_| {
            module.addCSourceFile(.{ .file = src.path(b, "scanner.c"), .flags = flags });
        } else |_| {}
        const highlights = embedQueries(b, files, dep, grammar.name, "highlights", grammar.highlights);
        const injections = embedQueries(b, files, dep, grammar.name, "injections", grammar.injections);
        zig.print(b.allocator, "extern fn tree_sitter_{s}() callconv(.c) *const anyopaque;\npub const {s}: Grammar = .{{ .language = &tree_sitter_{s}, .highlights = {s}, .injections = {s}, .first_wins = {} }};\n", .{ grammar.name, grammar.name, grammar.name, highlights, injections, grammar.first_wins }) catch @panic("OOM");
    }
    const source = files.add("grammars.zig", zig.items);
    return .{ .library = library, .grammars = b.createModule(.{ .root_source_file = source }) };
}

/// Copies each query beside the generated module and returns the Zig
/// expression that joins them.
fn embedQueries(b: *std.Build, files: *std.Build.Step.WriteFile, dep: *std.Build.Dependency, name: []const u8, kind: []const u8, queries: []const Query) []const u8 {
    if (queries.len == 0) return "\"\"";
    var expression: std.ArrayList(u8) = .empty;
    for (queries, 0..) |query, index| {
        const file = switch (query) {
            .own => |path| dep.path(path),
            .dep => |pair| b.dependency(pair[0], .{}).path(pair[1]),
            .local => |path| b.path(path),
        };
        const copy = b.fmt("{s}/{s}{d}.scm", .{ name, kind, index });
        _ = files.addCopyFile(file, copy);
        if (index > 0) expression.appendSlice(b.allocator, " ++ \"\\n\" ++ ") catch @panic("OOM");
        expression.print(b.allocator, "@embedFile(\"{s}\")", .{copy}) catch @panic("OOM");
    }
    return expression.items;
}

const std = @import("std");
const sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dependency = b.dependency("native_sdk", .{});
    const app = sdk.addAppArtifacts(b, dependency, .{ .name = "patch" });
    const host_tests = b.step("test-native-host", "Check native text pixels and transform roundoff bounds");
    const macos = app.exe.root_module.resolved_target.?.result.os.tag == .macos;
    if (!macos) opaqueStartupWindow(b, app.exe.root_module);
    if (macos) {
        const flags: []const []const u8 = if (b.sysroot) |sdk_path| &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } else &.{ "-fobjc-arc", "-fno-sanitize=builtin" };
        app.exe.root_module.addCSourceFile(.{ .file = b.path("src/native/glass.m"), .flags = flags });
        const canonical = b.option(bool, "canonical-transforms", "Remove subpixel icon-transform roundoff in the pinned macOS host") orelse true;
        const opaque_blur = b.option(bool, "opaque-blur", "Copy fully opaque native blur results without blending") orelse true;
        const coretext = b.option(bool, "coretext-lines", "Draw complete printable ASCII packet lines through CoreText") orelse true;
        const retain_identical = b.option(bool, "retain-identical-commands", "Preserve native rasters when a decoded command is unchanged") orelse true;
        if (canonical or opaque_blur or coretext or retain_identical) patchMacHost(b, dependency, app.exe.root_module, canonical, opaque_blur, coretext, retain_identical);
    }
    // The AppKit text test runs on the build machine, so it needs a Mac
    // there as well as a macOS target.
    if (macos and b.graph.host.result.os.tag == .macos) {
        const flags: []const []const u8 = if (b.sysroot) |sdk_path| &.{ "-fobjc-arc", "-fno-sanitize=builtin", "-isysroot", sdk_path, b.fmt("-I{s}/usr/include", .{sdk_path}) } else &.{ "-fobjc-arc", "-fno-sanitize=builtin" };
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
    b.step("test-highlight", "Check TextMate syntax highlighting").dependOn(&b.addRunArtifact(highlight_tests).step);
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

// Only macOS puts a native blur behind the canvas (glass.m), which is what
// app.json's transparent window is for. Elsewhere it would show the desktop
// through the window on Linux, and Windows refuses to create a layered
// window that keeps its titlebar. Off macOS the startup window is opaque;
// the canvas paints the window color itself (see view.zig).
fn opaqueStartupWindow(b: *std.Build, root: *std.Build.Module) void {
    const runner = root.import_table.get("runner") orelse @panic("runner module was not imported");
    const manifest = runner.import_table.get("app_manifest_zon") orelse @panic("app manifest module was not imported");
    const generated = switch (manifest.root_source_file orelse @panic("app manifest has no source")) {
        .generated => |value| value,
        else => @panic("app manifest is no longer generated from app.json; review this overlay"),
    };
    const files: *std.Build.Step.WriteFile = @fieldParentPtr("step", generated.file.step);
    for (files.files.items) |*file| if (std.mem.eql(u8, file.sub_path, "app_manifest.zon")) switch (file.contents) {
        .bytes => |bytes| {
            file.contents = .{ .bytes = replaceOnce(b, bytes, ".transparent = true,", ".transparent = false,") };
            return;
        },
        else => break,
    };
    @panic("generated app manifest was not found; review this overlay for the SDK pin");
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

// TextMate syntax highlighting: syntaxmate (src/native/syntaxmate, which
// cargo builds as a static library) and every grammar
// src/native/grammars.zig lists, minified from the pinned tm-grammars package
// (or src/native/grammars/) and embedded.
const grammar_table = @import("src/native/grammars.zig");

const Highlighter = struct {
    library: std.Build.LazyPath,
    sources: *std.Build.Module,
    fn link(self: Highlighter, module: *std.Build.Module) void {
        module.addObjectFile(self.library);
        // Rust's standard library calls the unwinder even when panics abort;
        // macOS has it in libSystem, elsewhere Zig builds its own.
        if (module.resolved_target.?.result.os.tag != .macos) module.linkSystemLibrary("unwind", .{});
        module.addImport("tm_grammar_sources", self.sources);
    }
};

/// The Rust target cargo builds the tokenizer for.
fn rustTarget(target: std.Target) ?[]const u8 {
    const musl = target.abi.isMusl();
    return switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "aarch64-apple-darwin",
            .x86_64 => "x86_64-apple-darwin",
            else => null,
        },
        .linux => switch (target.cpu.arch) {
            .aarch64 => if (musl) "aarch64-unknown-linux-musl" else "aarch64-unknown-linux-gnu",
            .x86_64 => if (musl) "x86_64-unknown-linux-musl" else "x86_64-unknown-linux-gnu",
            else => null,
        },
        .windows => switch (target.cpu.arch) {
            .aarch64 => "aarch64-pc-windows-msvc",
            .x86_64 => if (target.abi == .msvc) "x86_64-pc-windows-msvc" else "x86_64-pc-windows-gnu",
            else => null,
        },
        else => null,
    };
}

fn addHighlighter(b: *std.Build, target: std.Build.ResolvedTarget) Highlighter {
    const triple = rustTarget(target.result) orelse @panic("no Rust target for this Zig target");
    const cargo = b.addSystemCommand(&.{ "cargo", "build", "--release", "--quiet", "--target", triple, "--manifest-path" });
    cargo.addFileArg(b.path("src/native/syntaxmate/Cargo.toml"));
    cargo.addFileInput(b.path("src/native/syntaxmate/Cargo.lock"));
    cargo.addFileInput(b.path("src/native/syntaxmate/src/lib.rs"));
    // Like the Zig code, tune for this machine's CPU when building for it.
    if (target.query.isNativeCpu()) cargo.addArgs(&.{ "--config", "build.rustflags=[\"-C\", \"target-cpu=native\"]" });
    if (b.option([]const u8, "syntaxmate", "Build the tokenizer against this syntaxmate checkout instead of the pinned revision")) |path| {
        cargo.addArgs(&.{ "--config", b.fmt("paths=[\"{s}\"]", .{path}) });
        // Cargo tracks the checkout's sources itself.
        cargo.has_side_effects = true;
    } else {
        cargo.addArg("--locked");
    }
    const target_dir = cargo.addPrefixedOutputDirectoryArg("--target-dir=", "cargo");
    const library = target_dir.path(b, b.fmt("{s}/release/{s}", .{ triple, if (target.result.os.tag == .windows and target.result.abi == .msvc) "patch_syntaxmate.lib" else "libpatch_syntaxmate.a" }));

    const pack = b.addExecutable(.{ .name = "grammar-pack", .root_module = b.createModule(.{
        .root_source_file = b.path("src/native/grammar_pack.zig"),
        .target = b.graph.host,
        .optimize = .ReleaseSafe,
    }) });
    const run = b.addRunArtifact(pack);
    const out = run.addOutputDirectoryArg("grammars");
    const tm = b.dependency("tm_grammars", .{});
    inline for (@typeInfo(grammar_table.Language).@"enum".fields, grammar_table.grammars) |field, grammar| {
        const file = field.name ++ ".json";
        run.addFileArg(if (grammar.local) b.path("src/native/grammars/" ++ file) else tm.path("grammars/" ++ file));
    }
    return .{ .library = library, .sources = b.createModule(.{ .root_source_file = out.path(b, "sources.zig") }) };
}

const std = @import("std");
const sdk = @import("native_sdk");
const runner = @import("runner");
const git = @import("native/git.zig");
const patch = @import("native/patch.zig");
const canvas = sdk.canvas;
pub const keyboard = @import("native/keyboard.zig");
pub const selection = @import("native/selection.zig");
const gpa = std.heap.page_allocator;
pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
pub const app_icons = @import("native/icons.zig").all;

const theme = @import("native/theme.zig");
const easing = @import("native/motion.zig");

const Note = struct { path: []const u8, line: u32 = 0, line_end: u32 = 0, old: bool = false, text: []const u8 };
const Saved = struct { reviewed: []const []const u8 = &.{}, notes: []const Note = &.{} };
const Anchor = struct { line: u32 = 0, line_end: u32 = 0, old: bool = false, file: ?usize = null };
pub const DisplayRow = struct { file: usize, code: ?usize = null, spacer: bool = false };
pub const RailRow = struct { file: ?usize = null, directory: []const u8 = "" };
pub const Focus = enum { review, note, file_filter, search, palette };
pub const Palette = enum { closed, commands, files };
pub const SettingsSection = enum { review, layout, appearance, keyboard, about };
/// Preferences saved beside review progress, applied before the first load.
const Settings = struct { collapse_reviewed: bool = true, split: bool = true, sidebar: bool = true, mode: git.Mode = .working, base: []const u8 = "main", sidebar_width: f32 = 219, notes_width: f32 = 300, theme: []const u8 = "noir", glass: bool = false, colors: [5][]const u8 = .{ "", "", "", "", "" } };
/// Colors a person can set over any theme, in Settings › Appearance.
pub const color_roles = [_][]const u8{ "Background", "Text", "Accent", "Added", "Removed" };
pub const Choice = struct { index: usize, score: u32, file: bool = false };
const ReviewChange = struct { file: usize, reviewed: bool };
pub const Model = struct {
    /// One horizontal offset for every code line, so long lines scroll
    /// sideways together, and the widest line it may reach (in bytes).
    scroll_x: f32 = 0,
    max_cols: usize = 0,
    /// The palette's entrance: its opacity eases from 0 to 1 over 120 ms.
    palette_fade: f32 = 1,
    palette_fade_start: u64 = 0,
    review_bounds: struct { x: f32 = 233, y: f32 = 33, width: f32 = 1147, height: f32 = 835 } = .{},
    mouse: selection.State = .{},
    hover: ?selection.Hit = null,
    selection_epoch: usize = 0,
    canvas_width: f32 = 1380,
    keys: keyboard.State = .{},
    focus: Focus = .review,
    focus_epoch: usize = 0,
    cursor: usize = 0,
    cursor_active: bool = false,
    cursor_old: bool = false,
    scroll_offset: f32 = 0,
    viewport_height: f32 = 800,
    changes: []const usize = &.{},
    search_query: canvas.TextBuffer(256) = .{},
    search_matches: []const usize = &.{},
    palette: Palette = .closed,
    palette_query: canvas.TextBuffer(256) = .{},
    choices: [64]Choice = undefined,
    choice_count: usize = 0,
    choice_selected: usize = 0,
    palette_offset: f32 = 0,
    history: std.ArrayList(ReviewChange) = .empty,
    files: []patch.File = &.{},
    selected: usize = 0,
    visible: []usize = &.{},
    rail_rows: []const RailRow = &.{},
    display: []const DisplayRow = &.{},
    starts: []const usize = &.{},
    jump_offset: ?f32 = null,
    repository: []const u8 = "Patch",
    imported: bool = false,
    branch: []const u8 = "",
    /// The checked-out branch, shown in the rail and on the scope control.
    head: []const u8 = "",
    /// Branches to compare, newest commit first, one per line (git order).
    branch_names: []const u8 = "",
    /// The branch reviewed against the base; empty means the checked-out one.
    compare_head: canvas.TextBuffer(128) = .{},
    /// Which side of the comparison the branch picker is choosing.
    branch_slot: BranchSlot = .base,
    branch_query: canvas.TextBuffer(128) = .{},
    branch_selected: usize = 0,
    mode: git.Mode = .working,
    split: bool = true,
    sidebar: bool = true,
    collapse_reviewed: bool = true,
    default_mode: git.Mode = .working,
    settings_open: bool = false,
    base_popover: bool = false,
    band_menu: bool = false,
    /// The narrow rail's scope menu (Working, Staged, the branch) is open.
    scope_menu: bool = false,
    /// Rex steps its content back while the app is in the background.
    active: bool = false,
    /// A closed pane keeps its content only while it eases shut, then leaves the
    /// tree (and the accessibility tree) entirely.
    rail_mounted: bool = true,
    notes_mounted: bool = false,
    /// The rail and notes widths on screen, in points (0 when closed). They ease
    /// toward their targets one frame at a time and every frame is laid out
    /// honestly, so panes resize live as Rex's do instead of sliding over a
    /// layout made for where they will end up.
    rail_shown: f32 = 219,
    notes_shown: f32 = 0,
    motion: ?PaneMotion = null,
    settings_section: SettingsSection = .review,
    settings_query: canvas.TextBuffer(64) = .{},
    sidebar_width: f32 = 219,
    notes_width: f32 = 300,
    notes_open: bool = false,
    /// Appearance: a built-in scheme, solid or glass panes, and optional
    /// hex colors over the scheme (empty keeps the scheme's own).
    theme_index: usize = 0,
    glass_panes: bool = false,
    colors: [color_roles.len]canvas.TextBuffer(8) = @splat(.{}),
    editing: bool = false,
    edit_index: ?usize = null,
    draft_file: usize = 0,
    anchor: Anchor = .{},
    draft: canvas.TextBuffer(8192) = .{},
    filter: canvas.TextBuffer(256) = .{},
    base: canvas.TextBuffer(256) = .init("main"),
    busy: bool = false,
    error_text: []const u8 = "",
    notice: []const u8 = "",
    generation: usize = 0,
    notes: std.ArrayList(Note) = .empty,
};
pub const Msg = union(enum) {
    key: keyboard.Key,
    action: keyboard.Invocation,
    expire_keys: sdk.EffectTimer,
    viewport: struct { width: f32, height: f32 },
    sidebar_resized: f32,
    notes_resized: f32,
    mouse: selection.Pointer,
    drag_tick: sdk.EffectTimer,
    clear_selection,
    comment_selection,
    copy_selection,
    line_press: Anchor,
    copy_line: selection.Hit,
    copy_path: usize,
    palette_edit: canvas.TextInputEvent,
    palette_move: i32,
    palette_scrolled: canvas.ScrollState,
    palette_accept,
    palette_choose: usize,
    close_palette,
    search_edit: canvas.TextInputEvent,
    search_accept,
    filter_accept,
    open_repo,
    open_patch,
    refresh,
    toggle_sidebar,
    clear_jump: sdk.EffectTimer,
    scrolled: canvas.ScrollState,
    reviewed_file: usize,
    collapse_file: usize,
    open_settings,
    open_base,
    toggle_band_menu,
    toggle_scope_menu,
    close_scope_menu,
    branch_query_edit: canvas.TextInputEvent,
    pan: f32,
    goto_note: usize,
    set_theme: usize,
    set_glass: bool,
    color0_edit: canvas.TextInputEvent,
    color1_edit: canvas.TextInputEvent,
    color2_edit: canvas.TextInputEvent,
    color3_edit: canvas.TextInputEvent,
    color4_edit: canvas.TextInputEvent,
    reset_colors,
    branch_move: i32,
    branch_pick: usize,
    branch_slot: BranchSlot,
    branch_swap,
    app_active: bool,
    close_band_menu,
    close_base,
    base_compare,
    close_settings,
    settings_section: SettingsSection,
    settings_search_edit: canvas.TextInputEvent,
    toggle_fold_setting,
    toggle_rail_setting,
    default_split: bool,
    default_mode: git.Mode,
    reset_widths,
    copy_data_path,
    note_file: usize,
    toggle_split,
    toggle_notes,
    mode: git.Mode,
    select: usize,
    next,
    previous,
    reviewed,
    filter_edit: canvas.TextInputEvent,
    base_edit: canvas.TextInputEvent,
    draft_edit: canvas.TextInputEvent,
    add_note,
    anchor: Anchor,
    edit_note: usize,
    delete_note: usize,
    save_note,
    cancel_note,
    copy,
    export_review,
    dismiss,
    poll: sdk.EffectTimer,
    clear_notice: sdk.EffectTimer,
    pane_tick: sdk.EffectTimer,
    palette_tick: sdk.EffectTimer,
    clipboard_result: sdk.EffectClipboardResult,
};
pub const AppUi = canvas.Ui(Msg);
const Effects = sdk.Effects(Msg);
const PatchApp = sdk.UiAppWithFeatures(Model, Msg, .{ .runtime_markup = false });

const Job = struct {
    io: std.Io,
    arena: std.heap.ArenaAllocator = .init(gpa),
    repo: []const u8,
    mode: git.Mode,
    base: []const u8,
    head: []const u8 = "",
    imported: ?[]const u8 = null,
    result: ?git.Review = null,
    files: []patch.File = &.{},
    failure: ?anyerror = null,
    done: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    fn run(self: *Job) void {
        self.load() catch |err| {
            self.failure = err;
        };
        self.done.store(true, .release);
    }
    fn load(self: *Job) !void {
        const alloc = self.arena.allocator();
        self.result = if (self.imported) |path| .{
            .patch = try std.Io.Dir.cwd().readFileAlloc(self.io, path, alloc, .limited(git.max_patch_bytes)),
            .repository = std.fs.path.basename(path),
            .branch = "patch",
            .base = "",
            .title = "Imported patch",
            .kind = "patch",
        } else try git.read(alloc, self.io, self.repo, self.mode, self.base, self.head);
        self.files = try patch.parse(alloc, self.result.?.patch);
        std.mem.sort(patch.File, self.files, {}, struct {
            fn less(_: void, a: patch.File, b: patch.File) bool {
                return std.mem.lessThan(u8, a.path, b.path);
            }
        }.less);
    }
    fn destroy(self: *Job) void {
        if (self.thread) |thread| thread.join();
        self.arena.deinit();
        gpa.destroy(self);
    }
};
const Session = struct {
    io: std.Io,
    runtime: ?*sdk.Runtime = null,
    repo: []const u8 = ".",
    imported: ?[]const u8 = null,
    pending: ?*Job = null,
    document: ?*Job = null,
    data_dir: []const u8,
    progress_path: []const u8 = "",
    measure_startup: bool = false,
    review_reported: bool = false,
    pointer_point: sdk.geometry.PointF = .{},
    /// A key event from the settings window is being delivered.
    settings_keys: bool = false,
};
var session: Session = undefined;

pub fn canvasWidth() ?f32 {
    const runtime = session.runtime orelse return null;
    const frame = runtime.gpuSurfaceFrame(1, "main-canvas") catch return null;
    return if (frame.size.width > 0) frame.size.width else null;
}

fn showError(model: *Model, err: anyerror) void {
    model.error_text = switch (err) {
        error.InvalidRepository => "Choose a Git repository.",
        error.InvalidBaseBranch => "Base branch not found.",
        error.InvalidHeadBranch => "Head branch not found.",
        error.NoInitialCommit => "This repository has no commits yet.",
        error.InvalidPatch, error.InvalidHunk => "This patch could not be read.",
        error.PatchTooLarge, error.StreamTooLong => "Patch exceeds 64 MB.",
        else => @errorName(err),
    };
}
fn startLoad(model: *Model) bool {
    if (session.pending != null) return false;
    const job = gpa.create(Job) catch return false;
    job.* = .{ .io = session.io, .repo = session.repo, .mode = model.mode, .base = "main", .imported = session.imported };
    job.base = job.arena.allocator().dupe(u8, model.base.text()) catch "main";
    job.head = job.arena.allocator().dupe(u8, model.compare_head.text()) catch "";
    model.busy = true;
    model.error_text = "";
    session.pending = job;
    job.thread = std.Thread.spawn(.{}, Job.run, .{job}) catch null;
    if (job.thread == null) job.run();
    return true;
}
fn load(model: *Model, fx: *Effects) void {
    if (session.pending == null and !startLoad(model)) return;
    if (session.pending.?.done.load(.acquire)) {
        poll(model, fx);
    } else fx.startTimer(.{ .key = 1, .interval_ms = 8, .mode = .repeating, .on_fire = Effects.timerMsg(.poll) });
}
fn reindex(model: *Model) void {
    if (model.visible.len > 0) gpa.free(model.visible);
    var indices: std.ArrayList(usize) = .empty;
    for (model.files, 0..) |file, i| {
        const query = model.filter.text();
        if (query.len == 0 or std.ascii.indexOfIgnoreCase(file.path, query) != null) indices.append(gpa, i) catch {};
    }
    model.visible = indices.toOwnedSlice(gpa) catch &.{};
    if (model.rail_rows.len > 0) gpa.free(model.rail_rows);
    var rail_rows: std.ArrayList(RailRow) = .empty;
    var previous_dir: []const u8 = "";
    for (model.visible) |index| {
        const directory = std.fs.path.dirname(model.files[index].path) orelse "";
        if (directory.len > 0 and !std.mem.eql(u8, directory, previous_dir)) rail_rows.append(gpa, .{ .directory = directory }) catch return;
        rail_rows.append(gpa, .{ .file = index }) catch return;
        previous_dir = directory;
    }
    model.rail_rows = rail_rows.toOwnedSlice(gpa) catch &.{};
}
fn layoutRows(model: *Model) void {
    if (model.display.len > 0) gpa.free(model.display);
    if (model.starts.len > 0) gpa.free(model.starts);
    const alloc = gpa;
    if (model.changes.len > 0) gpa.free(model.changes);
    var changes: std.ArrayList(usize) = .empty;
    var rows: std.ArrayList(DisplayRow) = .empty;
    var starts: std.ArrayList(usize) = .empty;
    var cols: usize = 0;
    defer model.max_cols = cols;
    for (model.files, 0..) |file, index| {
        starts.append(alloc, rows.items.len) catch return;
        rows.append(alloc, .{ .file = index }) catch return;
        if (file.collapsed) continue;
        const source = if (model.split) file.split else file.unified;
        var in_change = false;
        for (source, 0..) |row, code| {
            cols = @max(cols, @max(row.left.len, row.right.len));
            const changed = row.added or row.removed;
            if (changed and !in_change) changes.append(alloc, rows.items.len) catch return;
            in_change = changed;
            rows.append(alloc, .{ .file = index, .code = code }) catch return;
        }
        rows.append(alloc, .{ .file = index, .spacer = true }) catch return;
    }
    model.changes = changes.toOwnedSlice(gpa) catch &.{};
    model.display = rows.toOwnedSlice(gpa) catch &.{};
    model.starts = starts.toOwnedSlice(gpa) catch &.{};
}
/// Code text runs at about 7.8 points a character (13-point SF Mono); the
/// offset stops where the widest line's end meets its column's edge.
pub const code_advance: f32 = 7.83;
pub fn codeColumn(model: *const Model) f32 {
    const width = canvasWidth() orelse model.canvas_width;
    const pane = width - model.rail_shown - theme.pane_inset - theme.pane_inset - (if (model.notes_shown > 0) model.notes_shown + theme.pane_inset else 0) - 16;
    return (if (model.split) (pane - 1) / 2 else pane) - 48;
}
fn maxPan(model: *const Model) f32 {
    return @max(0, @as(f32, @floatFromInt(model.max_cols)) * code_advance + 24 - codeColumn(model));
}
/// Sideways wheel and trackpad motion over the review pans every code line.
fn wheelMsg(wheel: sdk.platform.WheelEvent) ?Msg {
    if (!std.mem.eql(u8, wheel.label, "main-canvas")) return null;
    if (wheel.delta_x == 0 or @abs(wheel.delta_x) <= @abs(wheel.delta_y)) return null;
    return .{ .pan = wheel.delta_x };
}
fn focusReview(model: *Model) void {
    model.focus = .review;
    model.focus_epoch += 1;
}
fn requestScroll(model: *Model, fx: *Effects, offset: f32) void {
    const maximum = @max(0, @as(f32, @floatFromInt(model.display.len)) * 24 - model.viewport_height);
    model.jump_offset = std.math.clamp(offset, 0, maximum);
    model.scroll_offset = model.jump_offset.?;
    fx.startTimer(.{ .key = 4, .interval_ms = 64, .on_fire = Effects.timerMsg(.clear_jump) });
}
fn jump(model: *Model, fx: *Effects, index: usize) void {
    if (index >= model.starts.len) return;
    model.selected = index;
    model.cursor = seekCode(model, model.starts[index], true) orelse model.starts[index];
    // Keyboard file navigation can keep the focused pane and its native
    // scroll driver. Input from another surface still transfers focus.
    if (model.focus != .review) focusReview(model);
    requestScroll(model, fx, @as(f32, @floatFromInt(model.starts[index])) * 24);
}
fn progressPath(review: git.Review) []const u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(session.imported orelse session.repo);
    hash.update("\x00");
    hash.update(review.patch);
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return std.fmt.allocPrint(gpa, "{s}/{s}.json", .{ session.data_dir, std.fmt.bytesToHex(digest, .lower) }) catch "";
}
fn restore(model: *Model) void {
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    const bytes = std.Io.Dir.cwd().readFileAlloc(session.io, session.progress_path, alloc, .limited(4 * 1024 * 1024)) catch return;
    const value = std.json.parseFromSlice(Saved, alloc, bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch return;
    for (model.files) |*file| for (value.value.reviewed) |path| {
        if (std.mem.eql(u8, file.path, path)) {
            file.reviewed = true;
            file.collapsed = model.collapse_reviewed;
            break;
        }
    };
    model.notes.appendSlice(alloc, value.value.notes) catch {};
}
const PaneMotion = struct { start_ms: u64, rail_from: f32, notes_from: f32 };
fn railTarget(model: *const Model) f32 {
    return if (model.sidebar) model.sidebar_width else 0;
}
fn notesTarget(model: *const Model) f32 {
    return if (model.notes_open) model.notes_width else 0;
}
/// Eases the panes from where they are toward their targets. Opening mounts a
/// pane's content at once; closing keeps it until the pane has shut. A toggle
/// mid-flight turns the motion around from wherever it is.
fn movePanes(model: *Model, fx: *Effects) void {
    if (model.sidebar) model.rail_mounted = true;
    if (model.notes_open) model.notes_mounted = true;
    model.motion = .{ .start_ms = sdk.monotonicMs(), .rail_from = model.rail_shown, .notes_from = model.notes_shown };
    fx.startTimer(.{ .key = 8, .interval_ms = 8, .mode = .repeating, .on_fire = Effects.timerMsg(.pane_tick) });
}
fn stepPanes(model: *Model, fx: *Effects) void {
    const motion = model.motion orelse return;
    const elapsed: f32 = @floatFromInt(sdk.monotonicMs() -| motion.start_ms);
    const t = std.math.clamp(elapsed / @as(f32, @floatFromInt(theme.motion_ms)), 0, 1);
    const eased = easing.ease(t);
    model.rail_shown = std.math.lerp(motion.rail_from, railTarget(model), eased);
    model.notes_shown = std.math.lerp(motion.notes_from, notesTarget(model), eased);
    if (t < 1) return;
    model.motion = null;
    fx.cancelTimer(8);
    model.rail_mounted = model.sidebar;
    model.notes_mounted = model.notes_open;
}
extern fn patch_set_appearance(red: f64, green: f64, blue: f64, alpha: f64, dark: bool) void;
/// The scheme in effect: the chosen built-in with any valid override colors.
pub fn activeScheme(model: *const Model) theme.Scheme {
    var scheme = theme.schemes[model.theme_index];
    const slots = [_]*canvas.Color{ &scheme.background, &scheme.foreground, &scheme.accent, &scheme.green, &scheme.red };
    for (slots, &model.colors) |slot, *buffer| if (theme.parseHex(buffer.text())) |color| {
        slot.* = color;
    };
    // A custom background decides light or dark.
    if (theme.parseHex(model.colors[0].text())) |ground| scheme.dark = (ground.r + ground.g + ground.b) / 3 < 0.5;
    return scheme;
}
/// Recomputes every color from the appearance settings and hands the window
/// tint and light/dark material to AppKit. Untouched Noir keeps the values
/// measured from Rex rather than derived ones.
pub fn applyAppearance(model: *const Model) void {
    var custom = false;
    for (&model.colors) |*buffer| custom = custom or theme.parseHex(buffer.text()) != null;
    theme.apply(if (model.theme_index == 0 and !model.glass_panes and !custom) theme.noir else theme.derive(activeScheme(model), model.glass_panes));
    if (@import("builtin").os.tag == .macos and !@import("builtin").is_test) patch_set_appearance(theme.window.r, theme.window.g, theme.window.b, theme.window.a, theme.dark);
}
fn editColor(model: *Model, index: usize, edit: canvas.TextInputEvent) void {
    model.colors[index].apply(edit);
    const text = model.colors[index].text();
    // Apply once the text is empty (the theme's own) or a whole color.
    if (text.len == 0 or theme.parseHex(text) != null) {
        applyAppearance(model);
        saveSettings(model);
    }
}
fn settingsPath() ?[]const u8 {
    return std.fmt.allocPrint(gpa, "{s}/settings.json", .{session.data_dir}) catch null;
}
fn saveSettings(model: *const Model) void {
    const path = settingsPath() orelse return;
    defer gpa.free(path);
    var colors: [color_roles.len][]const u8 = undefined;
    for (&colors, &model.colors) |*out, *buffer| out.* = buffer.text();
    const bytes = std.json.Stringify.valueAlloc(gpa, Settings{ .collapse_reviewed = model.collapse_reviewed, .split = model.split, .sidebar = model.sidebar, .mode = model.default_mode, .base = model.base.text(), .sidebar_width = model.sidebar_width, .notes_width = model.notes_width, .theme = theme.schemes[model.theme_index].id, .glass = model.glass_panes, .colors = colors }, .{}) catch return;
    defer gpa.free(bytes);
    std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = path, .data = bytes }) catch {};
}
fn loadSettings(model: *Model) void {
    const path = settingsPath() orelse return;
    defer gpa.free(path);
    const bytes = std.Io.Dir.cwd().readFileAlloc(session.io, path, gpa, .limited(64 * 1024)) catch return;
    defer gpa.free(bytes);
    const parsed = std.json.parseFromSlice(Settings, gpa, bytes, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const value = parsed.value;
    model.collapse_reviewed = value.collapse_reviewed;
    model.split = value.split;
    model.sidebar = value.sidebar;
    model.rail_mounted = value.sidebar;
    model.default_mode = value.mode;
    model.mode = value.mode;
    model.base = .init(value.base);
    model.sidebar_width = std.math.clamp(value.sidebar_width, theme.rail_min, theme.rail_max);
    model.notes_width = std.math.clamp(value.notes_width, theme.notes_min, theme.notes_max);
    model.rail_shown = railTarget(model);
    model.theme_index = theme.schemeIndex(value.theme) orelse 0;
    model.glass_panes = value.glass;
    for (&model.colors, value.colors) |*buffer, text| buffer.* = .init(text[0..@min(text.len, 7)]);
    applyAppearance(model);
}
fn persist(model: *Model) void {
    if (session.progress_path.len == 0) return;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const alloc = arena.allocator();
    var reviewed_files: std.ArrayList([]const u8) = .empty;
    for (model.files) |file| if (file.reviewed) {
        reviewed_files.append(alloc, file.path) catch return;
    };
    const bytes = std.json.Stringify.valueAlloc(alloc, Saved{ .reviewed = reviewed_files.items, .notes = model.notes.items }, .{}) catch return;
    std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = session.progress_path, .data = bytes }) catch |err| showError(model, err);
}
fn poll(model: *Model, fx: *Effects) void {
    const job = session.pending orelse return;
    const done = job.done.load(.acquire);
    if (!done) return;
    fx.cancelTimer(1);
    session.pending = null;
    model.busy = false;
    if (job.failure) |err| {
        showError(model, err);
        job.destroy();
        return;
    }
    const old_document = session.document;
    session.document = job;
    model.files = job.files;
    model.selected = 0;
    model.cursor = 0;
    model.cursor_active = false;
    model.mouse.clear();
    model.hover = null;
    model.scroll_offset = 0;
    model.keys.reset();
    model.history.clearRetainingCapacity();
    if (model.search_matches.len > 0) gpa.free(model.search_matches);
    model.search_matches = &.{};
    model.search_query.clear();
    model.palette = .closed;
    focusReview(model);
    model.notes = .empty;
    model.repository = job.result.?.repository;
    model.branch = if (job.result.?.kind.len == 3) job.result.?.base else "patch";
    model.head = if (job.result.?.kind.len == 3) job.result.?.head else "";
    model.branch_names = if (job.result.?.kind.len == 3) job.result.?.branches else "";
    model.imported = job.result.?.kind.len != 3;
    model.editing = false;
    model.draft.clear();
    model.generation += 1;
    model.scroll_x = 0;
    if (session.progress_path.len > 0) gpa.free(session.progress_path);
    session.progress_path = progressPath(job.result.?);
    restore(model);
    reindex(model);
    layoutRows(model);
    model.jump_offset = null;
    if (old_document) |old_job| old_job.destroy();
    if (session.imported == null) {
        const last_path = std.fmt.allocPrint(gpa, "{s}/repository", .{session.data_dir}) catch return;
        defer gpa.free(last_path);
        std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = last_path, .data = session.repo }) catch {};
    }
    if (session.measure_startup and model.generation == 1) std.debug.print("patch-perf: review_ready wall_ns={d}\n", .{std.Io.Clock.real.now(session.io).nanoseconds});
}
fn notify(model: *Model, fx: *Effects, text: []const u8) void {
    model.notice = text;
    fx.startTimer(.{ .key = 2, .interval_ms = 1800, .on_fire = Effects.timerMsg(.clear_notice) });
}
fn pick(model: *Model, fx: *Effects, directory: bool) void {
    if (model.busy) return;
    const runtime = session.runtime orelse return;
    var buf: [8192]u8 = undefined;
    const result = runtime.showOpenDialog(.{ .title = if (directory) "Open repository" else "Open patch", .allow_directories = directory, .allow_multiple = false }, &buf) catch |err| {
        showError(model, err);
        return;
    };
    if (result.count == 0) return;
    const path = gpa.dupe(u8, std.mem.trimEnd(u8, result.paths, "\n\r")) catch return;
    if (directory) {
        session.repo = path;
        session.imported = null;
    } else session.imported = path;
    load(model, fx);
}
fn exportMarkdown(alloc: std.mem.Allocator, model: *const Model) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(alloc);
    try output.writer.print("# Review: {s}\n\n{s} · {s}\n\n", .{ model.repository, @tagName(model.mode), model.branch });
    for (model.files) |file| {
        try output.writer.print("- [{s}] `{s}` (+{d} −{d})\n", .{ if (file.reviewed) "x" else " ", file.path, file.additions, file.deletions });
    }
    for (model.notes.items) |note| {
        try output.writer.print("\n## `{s}`", .{note.path});
        if (note.line > 0) {
            try output.writer.print(":{d}", .{note.line});
            if (note.line_end > note.line) try output.writer.print("–{d}", .{note.line_end});
            try output.writer.print(" ({s})", .{if (note.old) "old" else "new"});
        }
        try output.writer.print("\n\n{s}\n", .{note.text});
    }
    return output.toOwnedSlice();
}
pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .key => |key| {
            if (model.palette != .closed) {
                if (key == .character and (key.character == 'j' or key.character == 'k')) update(model, .{ .palette_move = if (key.character == 'j') 1 else -1 }, fx);
                return;
            }
            if (model.keys.feed(key)) |invocation| perform(model, fx, invocation);
            if (model.keys.pending()) fx.startTimer(.{ .key = 5, .interval_ms = 1200, .on_fire = Effects.timerMsg(.expire_keys) }) else fx.cancelTimer(5);
        },
        .action => |invocation| {
            model.keys.reset();
            model.band_menu = false;
            perform(model, fx, invocation);
        },
        .expire_keys => model.keys.reset(),
        .viewport => |size| {
            model.canvas_width = size.width;
            model.viewport_height = @max(100, size.height - 64);
        },
        // Splits report fractions; widths stay in points so a window resize
        // gives its space to the review rather than stretching the side panes.
        .sidebar_resized => |fraction| if (model.sidebar and model.motion == null) {
            model.sidebar_width = std.math.clamp(fraction * (model.canvas_width - 8), theme.rail_min, theme.rail_max);
            model.rail_shown = model.sidebar_width;
            saveSettings(model);
        },
        .notes_resized => |fraction| if (model.notes_open and model.motion == null) {
            const available = model.canvas_width - model.rail_shown - 8 - 8;
            model.notes_width = std.math.clamp(available * (1 - fraction) - 8, theme.notes_min, theme.notes_max);
            model.notes_shown = model.notes_width;
            saveSettings(model);
        },
        .open_settings => {
            model.palette = .closed;
            model.settings_open = true;
        },
        .close_settings => model.settings_open = false,
        .settings_section => |section| model.settings_section = section,
        .settings_search_edit => |edit| {
            model.settings_query.apply(edit);
            // Searching jumps to the first section that matches.
            const query = model.settings_query.text();
            if (query.len > 0) for ([_]SettingsSection{ .review, .layout, .appearance, .keyboard, .about }) |section| {
                if (std.ascii.indexOfIgnoreCase(@tagName(section), query) != null) {
                    model.settings_section = section;
                    break;
                }
            };
        },
        .open_base => {
            model.scope_menu = false;
            openBranchPicker(model, .base);
        },
        .branch_query_edit => |edit| {
            model.branch_query.apply(edit);
            model.branch_selected = 0;
        },
        .branch_move => |direction| {
            var matches: [max_branch_matches][]const u8 = undefined;
            const count = branchMatches(model, &matches);
            if (count > 0) model.branch_selected = if (direction > 0) (model.branch_selected + 1) % count else if (model.branch_selected == 0) count - 1 else model.branch_selected - 1;
        },
        .branch_pick => |index| {
            model.branch_selected = index;
            pickBranch(model, fx);
        },
        .branch_slot => |slot| openBranchPicker(model, slot),
        .branch_swap => {
            const base = model.base.text();
            const head = if (model.compare_head.len > 0) model.compare_head.text() else model.head;
            var swapped_base: [128]u8 = undefined;
            const new_base = swapped_base[0..@min(head.len, swapped_base.len)];
            @memcpy(new_base, head[0..new_base.len]);
            model.compare_head.set(if (std.mem.eql(u8, base, model.head)) "" else base);
            model.base.set(new_base);
            saveSettings(model);
            load(model, fx);
        },
        .toggle_band_menu => model.band_menu = !model.band_menu,
        .toggle_scope_menu => model.scope_menu = !model.scope_menu,
        .close_scope_menu => model.scope_menu = false,
        .app_active => |active| model.active = active,
        .close_band_menu => model.band_menu = false,
        .close_base => {
            model.base_popover = false;
            focusReview(model);
        },
        .base_compare => pickBranch(model, fx),
        .pan => |delta| model.scroll_x = std.math.clamp(model.scroll_x + delta, 0, maxPan(model)),
        .goto_note => |index| if (index < model.notes.items.len) {
            const note = model.notes.items[index];
            for (model.files, 0..) |file, file_index| if (std.mem.eql(u8, file.path, note.path)) {
                if (file.collapsed) update(model, .{ .collapse_file = file_index }, fx);
                jump(model, fx, file_index);
                model.cursor_old = note.old;
                if (note.line > 0) goLine(model, fx, note.line);
                break;
            };
        },
        .set_theme => |index| if (index < theme.schemes.len) {
            model.theme_index = index;
            applyAppearance(model);
            saveSettings(model);
        },
        .set_glass => |on| {
            model.glass_panes = on;
            applyAppearance(model);
            saveSettings(model);
        },
        .color0_edit => |edit| editColor(model, 0, edit),
        .color1_edit => |edit| editColor(model, 1, edit),
        .color2_edit => |edit| editColor(model, 2, edit),
        .color3_edit => |edit| editColor(model, 3, edit),
        .color4_edit => |edit| editColor(model, 4, edit),
        .reset_colors => {
            for (&model.colors) |*buffer| buffer.clear();
            applyAppearance(model);
            saveSettings(model);
        },
        .toggle_fold_setting => {
            model.collapse_reviewed = !model.collapse_reviewed;
            saveSettings(model);
        },
        .toggle_rail_setting => {
            model.sidebar = !model.sidebar;
            movePanes(model, fx);
            saveSettings(model);
        },
        .default_split => |split| {
            if (model.split != split) update(model, .toggle_split, fx);
            saveSettings(model);
        },
        .default_mode => |mode| {
            model.default_mode = mode;
            saveSettings(model);
        },
        .reset_widths => {
            model.sidebar_width = 219;
            model.notes_width = 300;
            movePanes(model, fx);
            saveSettings(model);
        },
        .copy_data_path => fx.writeClipboard(.{ .key = 3, .text = session.data_dir, .on_result = Effects.clipboardMsg(.clipboard_result) }),
        .mouse => |pointer| {
            model.hover = pointer.hit;
            model.mouse.apply(pointer);
            if (model.mouse.range) |range| {
                if (model.mouse.dragging or model.mouse.active) {
                    model.cursor = range.focus;
                    model.cursor_old = range.old;
                    model.cursor_active = true;
                    model.selected = range.file;
                }
                if (pointer.phase == .up and pointer.native_bytes != null) normalizeNativeRange(model, pointer.native_bytes.?);
            }
            if (model.mouse.dragging and dragEdge(model) != 0) fx.startTimer(.{ .key = 7, .interval_ms = 32, .mode = .repeating, .on_fire = Effects.timerMsg(.drag_tick) }) else fx.cancelTimer(7);
        },
        .drag_tick => |timer| {
            if (timer.outcome != .fired or !model.mouse.dragging) return;
            const edge = dragEdge(model);
            if (edge == 0) {
                fx.cancelTimer(7);
                return;
            }
            requestScroll(model, fx, model.scroll_offset + edge);
            const point = session.pointer_point;
            const pointer = selection.Pointer{ .phase = .move, .hit = mouseHit(model, point.x, point.y), .x = point.x, .y = point.y };
            model.mouse.apply(pointer);
        },
        .clear_selection => {
            clearSelection(model);
            fx.cancelTimer(7);
        },
        .comment_selection => commentSelection(model),
        .copy_selection => copySelection(model, fx),
        .line_press => |anchor| {
            if (!model.mouse.active) beginNote(model, anchor.file orelse model.selected, anchor);
        },
        .copy_line => |hit| {
            if (model.mouse.active and model.mouse.range != null and model.mouse.range.?.contains(hit.file, hit.old, hit.row)) copySelection(model, fx) else {
                const row = sourceRow(model, hit.row) orelse return;
                const text = if (hit.old) row.left else row.right;
                fx.writeClipboard(.{ .key = 3, .text = text, .on_result = Effects.clipboardMsg(.clipboard_result) });
            }
        },
        .copy_path => |index| if (index < model.files.len) {
            fx.writeClipboard(.{ .key = 3, .text = model.files[index].path, .on_result = Effects.clipboardMsg(.clipboard_result) });
        },
        .palette_edit => |edit| {
            model.palette_query.apply(edit);
            matchChoices(model);
        },
        .palette_move => |direction| {
            if (model.choice_count > 0) model.choice_selected = if (direction > 0) (model.choice_selected + 1) % model.choice_count else if (model.choice_selected == 0) model.choice_count - 1 else model.choice_selected - 1;
            const row = theme.palette_row;
            const top = @as(f32, @floatFromInt(model.choice_selected)) * row;
            if (top < model.palette_offset) model.palette_offset = top else if (top + row > model.palette_offset + theme.palette_rows * row) model.palette_offset = top + row - theme.palette_rows * row;
        },
        .palette_scrolled => |scroll| model.palette_offset = scroll.offset_y,
        .palette_choose => |index| {
            model.choice_selected = index;
            acceptChoice(model, fx);
        },
        .palette_accept => acceptChoice(model, fx),
        .close_palette => {
            model.palette = .closed;
            focusReview(model);
        },
        .search_edit => |edit| {
            model.search_query.apply(edit);
            findMatches(model);
            if (model.search_matches.len > 0) {
                const index = lowerBound(model.search_matches, model.cursor);
                moveTo(model, fx, model.search_matches[@min(index, model.search_matches.len - 1)]);
                model.focus = .search;
            }
        },
        .search_accept => {
            focusReview(model);
        },
        .filter_accept => {
            if (model.visible.len > 0) jump(model, fx, model.visible[0]);
        },
        .open_repo => pick(model, fx, true),
        .open_patch => pick(model, fx, false),
        .refresh => load(model, fx),
        .mode => |mode| if (!model.busy) {
            model.scope_menu = false;
            model.mode = mode;
            if (mode == .branch) openBranchPicker(model, .base) else {
                model.base_popover = false;
            }
            session.imported = null;
            load(model, fx);
        },
        .poll => |timer| if (timer.outcome == .fired) {
            poll(model, fx);
        },
        .toggle_sidebar => {
            model.sidebar = !model.sidebar;
            // Menus anchored in the rail go with it.
            model.base_popover = false;
            model.scope_menu = false;
            movePanes(model, fx);
        },
        .pane_tick => |timer| if (timer.outcome == .fired) stepPanes(model, fx),
        .palette_tick => |timer| if (timer.outcome == .fired) {
            const elapsed: f32 = @floatFromInt(sdk.monotonicMs() -| model.palette_fade_start);
            const t = std.math.clamp(elapsed / 120, 0, 1);
            model.palette_fade = easing.ease(t);
            if (t >= 1 or model.palette == .closed) {
                model.palette_fade = 1;
                fx.cancelTimer(9);
            }
        },
        .toggle_split => {
            model.band_menu = false;
            model.split = !model.split;
            const line_number = cursorNumber(model);
            layoutRows(model);
            focusReview(model);
            jump(model, fx, model.selected);
            goLine(model, fx, line_number);
            findMatches(model);
        },
        .clear_jump => model.jump_offset = null,
        .scrolled => |scroll| {
            model.scroll_offset = scroll.offset_y;
            if (scroll.viewport_extent_y > 0) model.viewport_height = scroll.viewport_extent_y;
            if (model.display.len > 0 and model.jump_offset == null and model.focus != .note) {
                const index = @min(model.display.len - 1, @as(usize, @intFromFloat(@max(0, scroll.offset_y) / 24)));
                if (model.cursor_active and (@as(f32, @floatFromInt(model.cursor)) * 24 < scroll.offset_y or @as(f32, @floatFromInt(model.cursor)) * 24 >= scroll.offset_y + model.viewport_height)) model.cursor = seekCode(model, index, true) orelse model.cursor;
                model.selected = model.display[if (model.cursor_active) model.cursor else index].file;
            }
        },
        .reviewed_file => |index| {
            model.selected = index;
            markReviewed(model, fx, index, !model.files[index].reviewed);
            persist(model);
        },
        .collapse_file => |index| if (index < model.files.len) {
            model.files[index].collapsed = !model.files[index].collapsed;
            refold(model, fx, index);
        },
        .note_file => |index| beginNote(model, index, .{}),
        .toggle_notes => {
            model.band_menu = false;
            defer movePanes(model, fx);
            model.notes_open = !model.notes_open;
            focusReview(model);
        },
        .select => |index| {
            focusReview(model);
            jump(model, fx, index);
        },
        .next => {
            focusReview(model);
            jump(model, fx, @min(model.selected + 1, model.files.len -| 1));
        },
        .previous => {
            focusReview(model);
            jump(model, fx, model.selected -| 1);
        },
        .reviewed => if (model.selected < model.files.len) {
            markReviewed(model, fx, model.selected, !model.files[model.selected].reviewed);
            persist(model);
        },
        .filter_edit => |edit| {
            model.focus = .file_filter;
            model.filter.apply(edit);
            reindex(model);
        },
        .base_edit => |edit| {
            model.base.apply(edit);
            saveSettings(model);
        },
        .draft_edit => |edit| {
            model.focus = .note;
            model.draft.apply(edit);
        },
        .add_note, .anchor => {
            var anchor = if (msg == .anchor) msg.anchor else Anchor{};
            if (msg == .anchor and model.mouse.active) if (model.mouse.range) |range| {
                if (range.file == (anchor.file orelse model.selected) and range.old == anchor.old and anchor.line >= range.first_line and anchor.line <= range.last_line) {
                    anchor.line = range.first_line;
                    anchor.line_end = range.last_line;
                }
            };
            beginNote(model, anchor.file orelse model.selected, anchor);
        },
        .edit_note => |index| {
            if (model.editing and !model.draft.isEmpty()) {
                openNotesNow(model);
                model.focus = .note;
                return;
            }
            model.draft_file = model.selected;
            const note = model.notes.items[index];
            model.edit_index = index;
            model.draft.set(note.text);
            model.anchor = .{ .line = note.line, .line_end = note.line_end, .old = note.old };
            model.editing = true;
            model.focus = .note;
        },
        .delete_note => |index| {
            _ = model.notes.orderedRemove(index);
            persist(model);
        },
        .save_note => {
            const text = std.mem.trim(u8, model.draft.text(), " \t\r\n");
            if (text.len == 0 or model.draft_file >= model.files.len) return;
            const job = session.document orelse return;
            const bytes = job.arena.allocator().dupe(u8, text) catch return;
            const note = Note{ .path = model.files[model.draft_file].path, .line = model.anchor.line, .line_end = model.anchor.line_end, .old = model.anchor.old, .text = bytes };
            if (model.edit_index) |index| model.notes.items[index] = note else model.notes.append(job.arena.allocator(), note) catch return;
            model.editing = false;
            model.draft.clear();
            focusReview(model);
            persist(model);
        },
        .cancel_note => {
            model.editing = false;
            model.draft.clear();
            focusReview(model);
        },
        .copy, .export_review => {
            const bytes = exportMarkdown(gpa, model) catch return;
            defer gpa.free(bytes);
            if (msg == .copy) {
                fx.writeClipboard(.{ .key = 3, .text = bytes, .on_result = Effects.clipboardMsg(.clipboard_result) });
            } else {
                const runtime = session.runtime orelse return;
                var buf: [8192]u8 = undefined;
                const path = runtime.showSaveDialog(.{ .title = "Export review", .default_name = "patch-review.md" }, &buf) catch |err| {
                    showError(model, err);
                    return;
                };
                if (path) |destination| {
                    std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = destination, .data = bytes }) catch |err| {
                        showError(model, err);
                        return;
                    };
                    notify(model, fx, "Saved");
                }
            }
        },
        .clipboard_result => |result| {
            if (result.outcome == .ok) notify(model, fx, "Copied") else model.error_text = "Could not copy review.";
        },
        .clear_notice => model.notice = "",
        .dismiss => model.error_text = "",
    }
}

pub const view = @import("native/view.zig").view;
fn keys(event: canvas.WidgetKeyboardEvent) ?Msg {
    if (event.phase != .key_down or session.settings_keys) return null;
    const key = keyboard.decode(event.key, event.modifiers.shift, event.modifiers.control, event.modifiers.super, event.modifiers.alt) orelse return null;
    return .{ .key = key };
}
fn command(name: []const u8) ?Msg {
    const action = keyboard.byId(name) orelse return null;
    return .{ .action = .{ .action = action } };
}
var original_event: @FieldType(sdk.App, "event_fn") = null;
/// Preserve native text editing while routing review commands and pointer ranges.
fn routeEvent(context: *anyopaque, runtime: *sdk.Runtime, event: sdk.Event) anyerror!void {
    const state: *PatchApp = @ptrCast(@alignCast(context));
    if (event == .lifecycle and (event.lifecycle == .activate or event.lifecycle == .deactivate)) {
        if (original_event) |handler| try handler(context, runtime, event);
        try state.dispatch(runtime, 1, .{ .app_active = event.lifecycle == .activate });
        return;
    }
    if (event == .canvas_widget_keyboard and std.mem.eql(u8, event.canvas_widget_keyboard.view_label, settings_canvas)) {
        // Settings fields edit text natively; review keys never act from there.
        session.settings_keys = true;
        defer session.settings_keys = false;
        if (original_event) |handler| try handler(context, runtime, event);
        return;
    }
    if (event == .canvas_widget_keyboard) {
        const input = event.canvas_widget_keyboard;
        const key = input.keyboard;
        if (key.phase == .key_down) {
            if (key.modifiers.super) {
                if (state.model.focus == .review and state.model.mouse.active and state.model.mouse.range != null and state.model.mouse.range.?.bytes == null and std.ascii.eqlIgnoreCase(key.key, "c")) {
                    try state.dispatch(runtime, input.window_id, .copy_selection);
                    return;
                }
                if (std.ascii.eqlIgnoreCase(key.key, "enter") or std.ascii.eqlIgnoreCase(key.key, "return")) {
                    if (state.model.palette != .closed) {
                        try state.dispatch(runtime, input.window_id, .palette_accept);
                        return;
                    }
                    if (state.model.editing) {
                        try state.dispatch(runtime, input.window_id, .save_note);
                        return;
                    }
                }
                if (keyboard.primary(key.key, key.modifiers.shift)) |action| {
                    try state.dispatch(runtime, input.window_id, .{ .action = .{ .action = action } });
                    return;
                }
            }
            // Tab switches the branch picker between base and head.
            if (state.model.base_popover and !key.modifiers.super and std.ascii.eqlIgnoreCase(key.key, "tab")) {
                try state.dispatch(runtime, input.window_id, .{ .branch_slot = if (state.model.branch_slot == .base) .head else .base });
                return;
            }
            const decoded = keyboard.decode(key.key, key.modifiers.shift, key.modifiers.control, key.modifiers.super, key.modifiers.alt);
            if (decoded) |value| {
                if (value == .escape or (value == .control and value.control == '[')) {
                    try state.dispatch(runtime, input.window_id, .{ .action = .{ .action = .escape } });
                    return;
                }
                if (state.model.base_popover and state.model.palette == .closed) {
                    if (value == .up or value == .down or (value == .control and (value.control == 'n' or value.control == 'p'))) {
                        const down = value == .down or (value == .control and value.control == 'n');
                        try state.dispatch(runtime, input.window_id, .{ .branch_move = if (down) 1 else -1 });
                        return;
                    }
                }
                if (state.model.palette != .closed) {
                    if (value == .up or value == .down or (value == .control and (value.control == 'n' or value.control == 'p' or value.control == 'j' or value.control == 'k'))) {
                        const down = value == .down or (value == .control and (value.control == 'n' or value.control == 'j'));
                        try state.dispatch(runtime, input.window_id, .{ .palette_move = if (down) 1 else -1 });
                        return;
                    }
                }
            }
        }
    }
    if (event == .canvas_widget_pointer and state.model.palette == .closed) {
        const input = event.canvas_widget_pointer;
        const pointer = input.pointer;
        // Mouse geometry follows the retained list, including inset chrome,
        // side panels, resize, and error banners.
        const layout = runtime.canvasWidgetLayout(input.window_id, "main-canvas") catch null;
        if (layout) |tree| for (tree.nodes) |node| {
            if (!std.mem.eql(u8, node.widget.semantics.label, "Changes")) continue;
            state.model.review_bounds = .{ .x = node.frame.x, .y = node.frame.y, .width = node.frame.width, .height = node.frame.height };
            state.model.viewport_height = node.frame.height;
            break;
        };
        var floating = false;
        for (input.route) |entry| if (entry.kind == .popover or entry.kind == .dropdown_menu or entry.kind == .menu_surface) {
            floating = true;
            break;
        };
        if (!floating and pointer.button == 0) {
            session.pointer_point = pointer.point;
            const hit = mouseHit(&state.model, pointer.point.x, pointer.point.y);
            const moved = pointer.phase == .move or pointer.phase == .hover;
            const changed = !sameHit(hit, state.model.hover);
            const dragging = state.model.mouse.dragging;
            const distance = @abs(pointer.point.x - state.model.mouse.down_x) > 3 or @abs(pointer.point.y - state.model.mouse.down_y) > 3;
            if ((pointer.phase == .down and hit != null) or (moved and (changed or (dragging and distance and !state.model.mouse.active) or (dragging and dragEdge(&state.model) != 0))) or (pointer.phase == .up and dragging) or (pointer.phase == .cancel and dragging)) {
                const phase: selection.Phase = if (pointer.phase == .down) .down else if (pointer.phase == .up) .up else if (pointer.phase == .cancel) .cancel else .move;
                const bytes = if (phase == .up and state.model.mouse.active) nativeSelectionBytes(runtime, input.window_id, &state.model) else null;
                try state.dispatch(runtime, input.window_id, .{ .mouse = .{ .phase = phase, .hit = hit, .x = pointer.point.x, .y = pointer.point.y, .shift = pointer.modifiers.shift, .clicks = pointer.click_count, .native_bytes = bytes } });
            }
        }
    }
    if (original_event) |handler| try handler(context, runtime, event);
    // Only the review canvas sizes the review's panes: the Settings window's
    // canvas resizing must not (it once set the panes to Settings' width).
    if (event == .gpu_surface_resized and std.mem.eql(u8, event.gpu_surface_resized.label, "main-canvas")) try state.dispatch(runtime, event.gpu_surface_resized.window_id, .{ .viewport = .{ .width = event.gpu_surface_resized.frame.width, .height = event.gpu_surface_resized.frame.height } });
}
const settings_canvas = "settings-canvas";
/// Settings is its own window, as in Rex; it exists while the model declares it.
fn declaredWindows(model: *const Model, scratch: *PatchApp.WindowsScratch) []const PatchApp.WindowDescriptor {
    if (!model.settings_open) return scratch.windows[0..0];
    scratch.windows[0] = .{ .label = "settings", .canvas_label = settings_canvas, .title = "Settings", .width = 780, .height = 620, .resizable = false, .titlebar = .hidden_inset, .restore_policy = .center_on_primary, .allows_fullscreen = false, .on_close = .close_settings };
    return scratch.windows[0..1];
}
fn windowView(ui: *AppUi, model: *const Model, label: []const u8) AppUi.Node {
    _ = label;
    return @import("native/view.zig").settingsWindow(ui, model);
}
/// Settings sidebar icons: gradient squircles rendered from
/// src/native/settings-icons/*.svg (scripts/render-settings-icons.mjs).
pub const settings_icons = [_][]const u8{
    @embedFile("native/settings-icons/review.png"),
    @embedFile("native/settings-icons/layout.png"),
    @embedFile("native/settings-icons/keyboard.png"),
    @embedFile("native/settings-icons/about.png"),
    @embedFile("native/settings-icons/appearance.png"),
    @embedFile("native/settings-icons/patch.png"),
};
pub const settings_icon_base: canvas.ImageId = 0x5e7700;
fn initFx(model: *Model, fx: *Effects) void {
    for (settings_icons, 0..) |bytes, index| _ = fx.registerImageBytes(settings_icon_base + index, bytes) catch {};
    load(model, fx);
}
extern fn patch_install_glass() void;
var background_launch = false;
fn startApp(_: *anyopaque, runtime: *sdk.Runtime) !void {
    session.runtime = runtime;
    if (@import("builtin").os.tag == .macos) patch_install_glass();
    if (!background_launch) {
        var windows: [4]sdk.platform.WindowInfo = undefined;
        for (runtime.listWindows(&windows)) |window| try runtime.focusWindow(window.id);
    }
}

fn measureStartupFrame(model: *const Model, frame: sdk.platform.GpuFrame) ?Msg {
    if (!session.review_reported and model.generation == 1 and !model.busy and model.files.len > 0 and frame.nonblank) {
        session.review_reported = true;
        std.debug.print("patch-perf: review_presented wall_ns={d}\n", .{std.Io.Clock.real.now(session.io).nanoseconds});
    }
    return null;
}

/// The stock control register for each appearance, with Patch's type sizes.
var base_tokens: [2]canvas.DesignTokens = undefined;
fn baseTokens(scheme: canvas.ColorScheme) canvas.DesignTokens {
    var tokens = canvas.DesignTokens.theme(.{ .pack = .geist, .color_scheme = scheme, .density = .compact });
    tokens.typography.body_size = theme.body_size;
    tokens.typography.label_size = 12;
    tokens.typography.button_size = 12;
    return tokens;
}
/// Design tokens for each rebuild, from the palette in effect, so a theme
/// change restyles controls and syntax at once.
fn designTokens(_: *const Model) canvas.DesignTokens {
    var tokens = base_tokens[if (theme.dark) 0 else 1];
    tokens.colors.background = theme.clear;
    tokens.colors.surface = theme.chrome;
    // Rex separates surfaces with fills, not outlines; this also keeps split
    // dividers invisible until hovered.
    tokens.colors.border = theme.clear;
    tokens.colors.text = theme.ink;
    tokens.colors.text_muted = theme.muted;
    // Rex shows no line while a pane gap is dragged; nothing in Patch uses the stock accent.
    tokens.colors.accent = theme.clear;
    tokens.colors.accent_text = canvas.Color.rgb8(255, 255, 255);
    tokens.colors.focus_ring = theme.muted;
    // Code in the theme's ANSI colors (static-noir's for Noir, as Rex shows it).
    tokens.colors.syntax_plain = theme.ink;
    // Word-level emphasis inside changed lines (spans reference these tokens).
    tokens.colors.success = theme.word_added;
    tokens.colors.destructive = theme.word_removed;
    tokens.colors.warning = theme.search_hit;
    tokens.colors.syntax_comment = theme.syntax_comment;
    tokens.colors.syntax_keyword = theme.syntax_keyword;
    // Strings in straw, so green only ever means "added".
    tokens.colors.syntax_literal = theme.syntax_literal;
    tokens.colors.syntax_function = theme.syntax_function;
    tokens.colors.syntax_property = theme.syntax_property;
    tokens.colors.syntax_constant = theme.syntax_constant;
    return tokens;
}
pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(gpa);
    if (args.len >= 3 and std.mem.eql(u8, args[1], "--inspect-repository")) {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const mode = if (args.len > 3) std.meta.stringToEnum(git.Mode, args[3]) orelse return error.InvalidMode else .working;
        const review = try git.read(arena.allocator(), init.io, args[2], mode, if (args.len > 4) args[4] else "main", if (args.len > 5) args[5] else "");
        const bytes = try std.json.Stringify.valueAlloc(arena.allocator(), review, .{});
        try std.Io.File.stdout().writeStreamingAll(init.io, bytes);
        return;
    }
    var dir_buf: [4096]u8 = undefined;
    const dir = init.environ_map.get("PATCH_STATE_DIR") orelse try sdk.app_dirs.resolveOne(.{ .name = "computer.patch.app" }, sdk.app_dirs.currentPlatform(), .{ .home = init.environ_map.get("HOME"), .xdg_data_home = init.environ_map.get("XDG_DATA_HOME") }, .data, &dir_buf);
    try std.Io.Dir.cwd().createDirPath(init.io, dir);
    session = .{ .io = init.io, .data_dir = try gpa.dupe(u8, dir), .measure_startup = init.environ_map.contains("NATIVE_SDK_WINDOW_TIMING") };
    const last = try std.fmt.allocPrint(gpa, "{s}/repository", .{dir});
    defer gpa.free(last);
    session.repo = std.Io.Dir.cwd().readFileAlloc(init.io, last, gpa, .limited(8192)) catch ".";
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--background")) background_launch = true;
        if (std.mem.eql(u8, args[i], "--repo") and i + 1 < args.len) {
            i += 1;
            session.repo = args[i];
        }
        if (std.mem.eql(u8, args[i], "--patch") and i + 1 < args.len) {
            i += 1;
            session.imported = args[i];
        }
    }
    session.repo = std.Io.Dir.cwd().realPathFileAlloc(init.io, session.repo, gpa) catch session.repo;
    if (session.imported) |path| session.imported = std.Io.Dir.cwd().realPathFileAlloc(init.io, path, gpa) catch path;
    defer {
        if (session.pending) |job| job.destroy();
        if (session.document) |job| job.destroy();
    }
    canvas.icons.registerAppIcons(&app_icons);
    base_tokens = .{ baseTokens(.dark), baseTokens(.light) };
    const views = [_]sdk.ShellView{.{ .label = "main-canvas", .kind = .gpu_surface, .fill = true, .accessibility_label = "Patch", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .premultiplied, .gpu_color_space = .srgb, .gpu_vsync = true }};
    const windows = [_]sdk.ShellWindow{.{ .label = "main", .title = "Patch", .width = 1380, .height = 900, .min_width = 880, .min_height = 500, .titlebar = .hidden_inset, .transparent = true, .activate_on_show = false, .views = &views }};
    const state = try PatchApp.create(gpa, .{ .name = "patch", .scene = .{ .windows = &windows }, .canvas_label = "main-canvas", .update_fx = update, .init_fx = initFx, .view = view, .windows_fn = declaredWindows, .window_view = windowView, .tokens_fn = designTokens, .on_wheel = wheelMsg, .on_key = keys, .on_command = command, .on_frame = if (session.measure_startup) measureStartupFrame else null });
    defer state.destroy();
    // Read Git/parse while AppKit and Metal initialize. initFx adopts the
    // completed job before building the first view whenever it is ready.
    loadSettings(&state.model);
    _ = startLoad(&state.model);
    var application = state.app();
    application.start_fn = startApp;
    original_event = application.event_fn;
    application.event_fn = routeEvent;
    const permissions = [_][]const u8{ sdk.security.permission_command, sdk.security.permission_view };
    try runner.runWithOptions(application, .{ .app_name = "Patch", .window_title = "Patch", .bundle_id = "computer.patch.app", .icon_path = "public/favicon.svg", .default_frame = sdk.geometry.RectF.init(0, 0, 1380, 900), .js_window_api = false, .security = .{ .permissions = &permissions } }, init);
}

test {
    _ = patch;
    _ = git;
    _ = keyboard;
    _ = selection;
}

pub fn sourceRow(model: *const Model, index: usize) ?patch.Row {
    if (index >= model.display.len) return null;
    const ref = model.display[index];
    if (ref.spacer) return null;
    const code = ref.code orelse return null;
    const rows = if (model.split) model.files[ref.file].split else model.files[ref.file].unified;
    if (code >= rows.len or rows[code].meta) return null;
    return rows[code];
}
fn seekCode(model: *const Model, start: usize, forward: bool) ?usize {
    if (model.display.len == 0) return null;
    var index = @min(start, model.display.len - 1);
    while (true) {
        if (sourceRow(model, index) != null) return index;
        if (forward) {
            if (index + 1 >= model.display.len) return null;
            index += 1;
        } else {
            if (index == 0) return null;
            index -= 1;
        }
    }
}
/// The cursor rests on a folded file's header, which has no lines of its own.
pub fn onFoldedHeader(model: *const Model) bool {
    if (model.cursor >= model.display.len) return false;
    const row = model.display[model.cursor];
    return row.code == null and !row.spacer and model.files[row.file].collapsed;
}
fn ensureCursor(model: *Model) bool {
    if (model.display.len == 0) return false;
    if (!model.cursor_active or (sourceRow(model, model.cursor) == null and !onFoldedHeader(model))) model.cursor = seekCode(model, model.starts[model.selected], true) orelse return false;
    model.cursor_active = true;
    model.selected = model.display[model.cursor].file;
    return true;
}
pub fn cursorNumber(model: *const Model) u32 {
    const row = sourceRow(model, model.cursor) orelse return 0;
    return if (model.cursor_old and row.old > 0) row.old else if (row.new > 0) row.new else row.old;
}
pub fn cursorIsOld(model: *const Model) bool {
    const row = sourceRow(model, model.cursor) orelse return model.cursor_old;
    return (model.cursor_old and row.old > 0) or row.new == 0;
}
fn reveal(model: *Model, fx: *Effects) void {
    const position = @as(f32, @floatFromInt(model.cursor)) * 24;
    if (position < model.scroll_offset + 24) requestScroll(model, fx, position - 24) else if (position + 48 > model.scroll_offset + model.viewport_height) requestScroll(model, fx, position + 48 - model.viewport_height);
}
fn moveTo(model: *Model, fx: *Effects, index: usize) void {
    if (sourceRow(model, index) == null) return;
    model.cursor = index;
    model.cursor_active = true;
    model.selected = model.display[index].file;
    if (model.focus != .review and model.focus != .search) focusReview(model);
    reveal(model, fx);
}
fn moveLines(model: *Model, fx: *Effects, forward: bool, count: usize) void {
    if (!ensureCursor(model)) return;
    var target = model.cursor;
    for (0..count) |_| {
        if ((forward and target + 1 >= model.display.len) or (!forward and target == 0)) break;
        target = seekCode(model, if (forward) target + 1 else target - 1, forward) orelse break;
    }
    moveTo(model, fx, target);
}
/// Whether a saved note covers this line of this file's side.
pub fn noted(model: *const Model, file: usize, line: u32, old: bool) bool {
    if (line == 0 or file >= model.files.len) return false;
    const path = model.files[file].path;
    for (model.notes.items) |note| {
        if (note.line == 0 or note.old != old or !std.mem.eql(u8, note.path, path)) continue;
        if (line >= note.line and line <= @max(note.line, note.line_end)) return true;
    }
    return false;
}
fn goLine(model: *Model, fx: *Effects, number: usize) void {
    if (model.selected >= model.files.len) return;
    const start = model.starts[model.selected];
    const end = if (model.selected + 1 < model.starts.len) model.starts[model.selected + 1] else model.display.len;
    var closest: ?usize = null;
    const file = model.files[model.selected];
    const old = (model.cursor_old and file.status != .added) or file.status == .deleted;
    for (start..end) |index| if (sourceRow(model, index)) |row| {
        const line_number = if (old) row.old else row.new;
        if (line_number == 0) continue;
        closest = index;
        if (line_number >= number) break;
    };
    if (closest) |index| moveTo(model, fx, index);
}
fn lowerBound(values: []const usize, value: usize) usize {
    var low: usize = 0;
    var high = values.len;
    while (low < high) {
        const middle = low + (high - low) / 2;
        if (values[middle] < value) low = middle + 1 else high = middle;
    }
    return low;
}
pub fn isMatch(model: *const Model, index: usize) bool {
    const position = lowerBound(model.search_matches, index);
    return position < model.search_matches.len and model.search_matches[position] == index;
}
fn moveIndex(model: *Model, fx: *Effects, indices: []const usize, forward: bool, count: usize, wrap: bool) void {
    if (indices.len == 0 or !ensureCursor(model)) return;
    var position = lowerBound(indices, model.cursor);
    const exact = position < indices.len and indices[position] == model.cursor;
    if (forward) {
        if (exact) position += 1;
        if (!wrap and position >= indices.len) return;
        position += if (wrap) (count - 1) % indices.len else count - 1;
        position = if (wrap) position % indices.len else @min(position, indices.len - 1);
    } else {
        if (!wrap and position == 0) return;
        const amount = if (wrap) count % indices.len else count;
        position = if (wrap) (position + indices.len - amount) % indices.len else position -| amount;
    }
    moveTo(model, fx, indices[position]);
}
fn findMatches(model: *Model) void {
    if (model.search_matches.len > 0) gpa.free(model.search_matches);
    model.search_matches = &.{};
    const query = model.search_query.text();
    if (query.len == 0) return;
    var matches: std.ArrayList(usize) = .empty;
    for (model.display, 0..) |_, index| if (sourceRow(model, index)) |row| {
        if (std.ascii.indexOfIgnoreCase(row.left, query) != null or std.ascii.indexOfIgnoreCase(row.right, query) != null) matches.append(gpa, index) catch break;
    };
    model.search_matches = matches.toOwnedSlice(gpa) catch &.{};
}
/// Reviewing a file folds it away (and un-reviewing unfolds it) when enabled.
fn markReviewed(model: *Model, fx: *Effects, index: usize, value: bool) void {
    setReviewed(model, index, value);
    if (!model.collapse_reviewed or index >= model.files.len or model.files[index].collapsed == value) return;
    model.files[index].collapsed = value;
    refold(model, fx, index);
}
/// Rebuilds the rows after files fold or unfold, keeping the reader on `index`.
fn refold(model: *Model, fx: *Effects, index: usize) void {
    layoutRows(model);
    findMatches(model);
    clearSelection(model);
    if (model.cursor >= model.display.len) model.cursor = 0;
    const file = @min(index, model.files.len -| 1);
    jump(model, fx, file);
    // A folded file keeps the reader: the cursor parks on its header.
    if (file < model.files.len and model.files[file].collapsed) model.cursor = model.starts[file];
}
fn setReviewed(model: *Model, index: usize, value: bool) void {
    if (index >= model.files.len or model.files[index].reviewed == value) return;
    model.history.append(gpa, .{ .file = index, .reviewed = model.files[index].reviewed }) catch {};
    model.files[index].reviewed = value;
}
fn nextUnreviewed(model: *Model, fx: *Effects, forward: bool, count: usize) void {
    if (model.files.len == 0) return;
    var target = model.selected;
    var moved = false;
    for (0..count) |_| {
        var found = false;
        for (1..model.files.len + 1) |offset| {
            const index = if (forward) (target + offset) % model.files.len else (target + model.files.len - offset) % model.files.len;
            if (!model.files[index].reviewed) {
                target = index;
                found = true;
                moved = true;
                break;
            }
        }
        if (!found) break;
    }
    if (moved) {
        jump(model, fx, target);
        model.cursor_active = true;
    } else notify(model, fx, "All files reviewed");
}
fn matchChoices(model: *Model) void {
    model.choice_count = 0;
    model.choice_selected = 0;
    model.palette_offset = 0;
    const query = std.mem.trim(u8, model.palette_query.text(), " :");
    const command_count = if (model.palette == .files) @as(usize, 0) else keyboard.commands.len;
    const length = command_count + (if (model.palette == .files or query.len > 0) model.files.len else 0);
    for (0..length) |index| {
        var score: u32 = 0;
        const file = index >= command_count;
        const item_index = if (file) index - command_count else index;
        if (file) {
            const path = model.files[item_index].path;
            if (query.len == 0) score = if (item_index == model.selected) 0 else @intCast(@min(100000, item_index + 1)) else {
                score = if (keyboard.score(query, std.fs.path.basename(path))) |value| value else (keyboard.score(query, path) orelse continue) + 100;
            }
        } else {
            const item = keyboard.commands[index];
            if (item.document and model.files.len == 0) continue;
            score = keyboard.score(query, item.title) orelse continue;
        }
        var position: usize = 0;
        while (position < model.choice_count and model.choices[position].score <= score) : (position += 1) {}
        if (position >= model.choices.len) continue;
        const end = @min(model.choice_count, model.choices.len - 1);
        var shift = end;
        while (shift > position) : (shift -= 1) model.choices[shift] = model.choices[shift - 1];
        model.choices[position] = .{ .index = item_index, .score = score, .file = file };
        model.choice_count = @min(model.choice_count + 1, model.choices.len);
    }
}
fn openPalette(model: *Model, fx: *Effects, kind: Palette) void {
    const fresh = model.palette == .closed;
    model.palette = kind;
    model.focus = .palette;
    model.palette_query.clear();
    matchChoices(model);
    // Rex's floating surfaces arrive with a quick fade.
    if (fresh) {
        model.palette_fade = 0;
        model.palette_fade_start = sdk.monotonicMs();
        fx.startTimer(.{ .key = 9, .interval_ms = 8, .mode = .repeating, .on_fire = Effects.timerMsg(.palette_tick) });
    }
}
fn acceptChoice(model: *Model, fx: *Effects) void {
    if (model.palette == .closed or model.choice_selected >= model.choice_count) return;
    const choice = model.choices[model.choice_selected];
    const index = choice.index;
    model.palette = .closed;
    focusReview(model);
    if (choice.file) {
        jump(model, fx, index);
        model.cursor_active = true;
    } else perform(model, fx, .{ .action = keyboard.commands[index].action });
}
fn perform(model: *Model, fx: *Effects, invocation: keyboard.Invocation) void {
    const count = invocation.count;
    switch (invocation.action) {
        .line_down, .line_up, .file_next, .file_previous, .change_next, .change_previous, .first, .last, .go_line, .half_down, .half_up, .page_down, .page_up, .viewport_top, .viewport_middle, .viewport_bottom => clearSelection(model),
        else => {},
    }
    switch (invocation.action) {
        .commands => {
            if (model.palette == .commands) {
                model.palette = .closed;
                focusReview(model);
            } else openPalette(model, fx, .commands);
        },
        .files => {
            if (model.palette == .files) {
                model.palette = .closed;
                focusReview(model);
            } else openPalette(model, fx, .files);
        },
        .escape => {
            model.keys.reset();
            clearSelection(model);
            if (model.palette != .closed) model.palette = .closed else if (model.base_popover) {
                model.base_popover = false;
            } else if (model.focus == .file_filter) {
                model.filter.clear();
                reindex(model);
            } else if (model.focus != .search and model.search_query.len > 0) {
                model.search_query.clear();
                findMatches(model);
            }
            focusReview(model);
        },
        .line_down, .line_up => moveLines(model, fx, invocation.action == .line_down, count),
        .old_side, .new_side => {
            if (ensureCursor(model)) model.cursor_old = invocation.action == .old_side;
        },
        .file_next => {
            jump(model, fx, @min(model.selected + count, model.files.len -| 1));
            model.cursor_active = true;
        },
        .file_previous => {
            jump(model, fx, model.selected -| count);
            model.cursor_active = true;
        },
        .change_next, .change_previous => moveIndex(model, fx, model.changes, invocation.action == .change_next, count, false),
        .unreviewed_next, .unreviewed_previous => nextUnreviewed(model, fx, invocation.action == .unreviewed_next, count),
        .first => {
            if (seekCode(model, 0, true)) |index| moveTo(model, fx, index);
        },
        .last => {
            if (seekCode(model, model.display.len -| 1, false)) |index| moveTo(model, fx, index);
        },
        .go_line => goLine(model, fx, count),
        .half_down, .half_up, .page_down, .page_up => {
            const half = invocation.action == .half_down or invocation.action == .half_up;
            const forward = invocation.action == .half_down or invocation.action == .page_down;
            const lines = @max(1, @as(usize, @intFromFloat(model.viewport_height / (if (half) @as(f32, 48) else 24))));
            moveLines(model, fx, forward, @min(model.display.len, lines * count));
        },
        .scroll_down, .scroll_up => requestScroll(model, fx, model.scroll_offset + @as(f32, @floatFromInt(count)) * 24 * (if (invocation.action == .scroll_down) @as(f32, 1) else -1)),
        .viewport_top, .viewport_middle, .viewport_bottom => {
            const offset = if (invocation.action == .viewport_top) @as(f32, 0) else if (invocation.action == .viewport_middle) model.viewport_height / 2 else model.viewport_height - 24;
            const target = @as(usize, @intFromFloat(@max(0, model.scroll_offset + offset) / 24));
            if (seekCode(model, target, invocation.action != .viewport_bottom)) |index| moveTo(model, fx, index);
        },
        .center, .align_top, .align_bottom => {
            if (ensureCursor(model)) {
                const offset = if (invocation.action == .center) model.viewport_height / 2 else if (invocation.action == .align_bottom) model.viewport_height - 24 else 0;
                requestScroll(model, fx, @as(f32, @floatFromInt(model.cursor)) * 24 - offset);
            }
        },
        .collapse_toggle => if (model.selected < model.files.len) {
            model.files[model.selected].collapsed = !model.files[model.selected].collapsed;
            refold(model, fx, model.selected);
        },
        .collapse_all, .expand_all => if (model.files.len > 0) {
            for (model.files) |*file| file.collapsed = invocation.action == .collapse_all;
            refold(model, fx, model.selected);
        },
        .search => {
            model.focus = .search;
        },
        .match_next, .match_previous => {
            if (model.search_query.len == 0) model.focus = .search else if (model.search_matches.len == 0) notify(model, fx, "No matches") else moveIndex(model, fx, model.search_matches, invocation.action == .match_next, count, true);
        },
        .reviewed => {
            if (ensureCursor(model)) update(model, .reviewed, fx);
        },
        .review_next => {
            if (ensureCursor(model)) {
                markReviewed(model, fx, model.selected, true);
                persist(model);
                nextUnreviewed(model, fx, true, count);
            }
        },
        .undo => {
            for (0..count) |_| {
                const change = model.history.pop() orelse break;
                if (change.file < model.files.len) {
                    model.files[change.file].reviewed = change.reviewed;
                    if (model.collapse_reviewed) model.files[change.file].collapsed = change.reviewed;
                    refold(model, fx, change.file);
                    model.cursor_active = true;
                }
            }
            persist(model);
        },
        .comment_line => {
            if (model.mouse.active) {
                commentSelection(model);
                return;
            }
            if (!ensureCursor(model)) return;
            const row = sourceRow(model, model.cursor).?;
            const old = (model.cursor_old and row.old > 0) or row.new == 0;
            update(model, .{ .anchor = .{ .file = model.selected, .line = if (old) row.old else row.new, .old = old } }, fx);
        },
        .comment_file => update(model, .add_note, fx),
        .split => update(model, .toggle_split, fx),
        .sidebar => update(model, .toggle_sidebar, fx),
        .notes => update(model, .toggle_notes, fx),
        .refresh => update(model, .refresh, fx),
        .open_repo => update(model, .open_repo, fx),
        .open_patch => update(model, .open_patch, fx),
        .copy => update(model, .copy, fx),
        .export_review => update(model, .export_review, fx),
        .working => update(model, .{ .mode = .working }, fx),
        .staged => update(model, .{ .mode = .staged }, fx),
        .branch => update(model, .{ .mode = .branch }, fx),
        .settings => update(model, .open_settings, fx),
    }
}

pub const BranchSlot = enum { base, head };
pub const max_branch_matches = 64;
/// The branches the picker lists: every branch, or those containing the filter
/// text, newest commit first.
pub fn branchMatches(model: *const Model, out: *[max_branch_matches][]const u8) usize {
    const query = std.mem.trim(u8, model.branch_query.text(), " ");
    var count: usize = 0;
    var names = std.mem.tokenizeScalar(u8, if (model.branch_names.len > 0) model.branch_names else model.head, '\n');
    while (names.next()) |name| {
        if (count == out.len) break;
        if (query.len > 0 and std.ascii.indexOfIgnoreCase(name, query) == null) continue;
        out[count] = name;
        count += 1;
    }
    return count;
}
/// Opens the picker on one side with that side's branch already selected, so
/// ↩ keeps it and the arrows start from it.
fn openBranchPicker(model: *Model, slot: BranchSlot) void {
    model.base_popover = true;
    model.branch_slot = slot;
    model.branch_query.clear();
    model.branch_selected = 0;
    const current = switch (slot) {
        .base => model.base.text(),
        .head => if (model.compare_head.len > 0) model.compare_head.text() else model.head,
    };
    var matches: [max_branch_matches][]const u8 = undefined;
    const count = branchMatches(model, &matches);
    for (matches[0..count], 0..) |name, index| if (std.mem.eql(u8, name, current)) {
        model.branch_selected = index;
        break;
    };
}
/// Sets the picker's side to the selected branch (or to the typed name when
/// nothing matches) and compares.
fn pickBranch(model: *Model, fx: *Effects) void {
    var matches: [max_branch_matches][]const u8 = undefined;
    const count = branchMatches(model, &matches);
    const typed = std.mem.trim(u8, model.branch_query.text(), " ");
    const name = if (count > 0) matches[@min(model.branch_selected, count - 1)] else typed;
    if (name.len == 0) return;
    var copy: [128]u8 = undefined;
    const chosen = copy[0..@min(name.len, copy.len)];
    @memcpy(chosen, name[0..chosen.len]);
    switch (model.branch_slot) {
        .base => {
            model.base.set(chosen);
            saveSettings(model);
        },
        .head => model.compare_head.set(if (std.mem.eql(u8, chosen, model.head)) "" else chosen),
    }
    model.base_popover = false;
    model.mode = .branch;
    load(model, fx);
}
/// A new comment opens the notes at once, so its editor is on screen to take
/// focus and keystrokes.
fn openNotesNow(model: *Model) void {
    model.notes_open = true;
    model.notes_mounted = true;
    model.notes_shown = model.notes_width;
    if (model.motion) |*motion| motion.notes_from = model.notes_width;
}
fn beginNote(model: *Model, file: usize, anchor: Anchor) void {
    if (file >= model.files.len) return;
    openNotesNow(model);
    model.focus = .note;
    if (model.editing and !model.draft.isEmpty()) return;
    model.selected = file;
    model.draft_file = file;
    model.anchor = anchor;
    model.editing = true;
    model.edit_index = null;
    model.draft.clear();
}

fn sameHit(a: ?selection.Hit, b: ?selection.Hit) bool {
    if (a == null or b == null) return a == null and b == null;
    return a.?.file == b.?.file and a.?.row == b.?.row and a.?.old == b.?.old;
}
fn codeTop(model: *const Model) f32 {
    return model.review_bounds.y;
}
fn mouseHit(model: *const Model, x: f32, y: f32) ?selection.Hit {
    if (model.display.len == 0) return null;
    const left = model.review_bounds.x;
    const right = left + model.review_bounds.width;
    const top = codeTop(model);
    const bottom = top + model.viewport_height;
    if (x < left or x >= right or ((!model.mouse.dragging) and (y < top or y >= bottom))) return null;
    var index = @min(model.display.len - 1, @as(usize, @intFromFloat(@max(0, std.math.clamp(y, top, bottom - 1) - top + model.scroll_offset) / 24)));
    var old = x < left + (right - left) / 2;
    if (model.mouse.dragging) if (model.mouse.range) |range| {
        const first = model.starts[range.file];
        const last = if (range.file + 1 < model.starts.len) model.starts[range.file + 1] - 1 else model.display.len - 1;
        index = std.math.clamp(index, first, last);
        old = range.old;
    };
    const file = model.files[model.display[index].file];
    if (!model.split or file.status == .added or file.status == .deleted) {
        if (!model.mouse.dragging) old = file.status == .deleted or (sourceRow(model, index) != null and sourceRow(model, index).?.new == 0);
    }
    const candidate = index;
    const forward = if (model.mouse.range) |range| index >= range.anchor else true;
    while (true) {
        if (sourceRow(model, index)) |row| {
            const number = if (old) row.old else row.new;
            if (number > 0) return .{ .file = model.display[index].file, .row = index, .old = old, .line = number };
        }
        if (!model.mouse.dragging) return null;
        if ((forward and index + 1 >= model.display.len) or (!forward and index == 0)) return null;
        index = if (forward) index + 1 else index - 1;
        if (model.display[index].file != model.display[candidate].file) return null;
    }
}
fn dragEdge(model: *const Model) f32 {
    if (!model.mouse.dragging) return 0;
    const point = session.pointer_point;
    const top = codeTop(model);
    const bottom = top + model.viewport_height;
    if (point.y < top + 20) return -std.math.clamp(top + 20 - point.y, 12, 72);
    if (point.y > bottom - 20) return std.math.clamp(point.y - bottom + 20, 12, 72);
    return 0;
}
fn clearSelection(model: *Model) void {
    if (model.mouse.active) model.selection_epoch += 1;
    model.mouse.clear();
}
fn nativeSelectionBytes(runtime: *sdk.Runtime, window: sdk.platform.WindowId, model: *const Model) ?selection.Bytes {
    const range = model.mouse.range orelse return null;
    const group = selection.groupId(range.file, range.old, model.selection_epoch, model.generation);
    const layout = runtime.canvasWidgetLayout(window, "main-canvas") catch return null;
    var first: usize = std.math.maxInt(usize);
    var last: usize = 0;
    for (layout.nodes) |node| {
        const widget = node.widget;
        if (widget.static_text_group_id != group) continue;
        const selected = widget.text_selection orelse continue;
        const start = @min(selected.anchor, selected.focus);
        const end = @max(selected.anchor, selected.focus);
        if (start == end) continue;
        first = @min(first, widget.static_text_group_offset + start);
        last = @max(last, widget.static_text_group_offset + end);
    }
    return if (first < last) .{ .start = first, .end = last } else null;
}
fn normalizeNativeRange(model: *Model, bytes: selection.Bytes) void {
    const range = if (model.mouse.range) |*value| value else return;
    range.bytes = null;
    const anchor = sourceRow(model, range.anchor) orelse return;
    const focus = sourceRow(model, range.focus) orelse return;
    const anchor_offset = if (range.old) anchor.old_offset else anchor.new_offset;
    const focus_offset = if (range.old) focus.old_offset else focus.new_offset;
    const first_offset = @min(anchor_offset, focus_offset);
    const first_source = if (anchor_offset <= focus_offset) (if (range.old) anchor.left else anchor.right) else (if (range.old) focus.left else focus.right);
    if (bytes.start < first_offset or bytes.start > first_offset + first_source.len) return;
    const first = model.starts[range.file];
    const end = if (range.file + 1 < model.starts.len) model.starts[range.file + 1] else model.display.len;
    var begin: ?usize = null;
    var finish: usize = 0;
    for (first..end) |index| if (sourceRow(model, index)) |row| {
        const line_number = if (range.old) row.old else row.new;
        const offset = if (range.old) row.old_offset else row.new_offset;
        const source = if (range.old) row.left else row.right;
        if (line_number == 0 or offset >= bytes.end or offset + source.len + 1 <= bytes.start) continue;
        if (begin == null) begin = index;
        finish = index;
    };
    if (begin) |begin_index| {
        const first_row = sourceRow(model, begin_index).?;
        const last_row = sourceRow(model, finish).?;
        range.first_line = if (range.old) first_row.old else first_row.new;
        range.last_line = if (range.old) last_row.old else last_row.new;
        const forward = range.anchor <= range.focus;
        range.anchor = if (forward) begin_index else finish;
        range.focus = if (forward) finish else begin_index;
        range.anchor_line = if (forward) range.first_line else range.last_line;
        range.bytes = bytes;
    }
}
fn commentSelection(model: *Model) void {
    const range = model.mouse.range orelse return;
    beginNote(model, range.file, .{ .file = range.file, .old = range.old, .line = range.first_line, .line_end = range.last_line });
    model.mouse.active = false;
    model.mouse.dragging = false;
}
fn copySelection(model: *Model, fx: *Effects) void {
    const range = model.mouse.range orelse return;
    const text = selection.copy(gpa, model.files[range.file], range) catch return;
    defer gpa.free(text);
    fx.writeClipboard(.{ .key = 3, .text = text, .on_result = Effects.clipboardMsg(.clipboard_result) });
}

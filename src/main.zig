const std = @import("std");
const sdk = @import("native_sdk");
const runner = @import("runner");
const git = @import("native/git.zig");
const patch = @import("native/patch.zig");
const syntax = @import("native/syntax.zig");
const review = @import("native/review.zig");
pub const lookup = @import("native/lookup.zig");
pub const highlight = @import("native/highlight.zig");
/// Both sides of a file highlighted whole, when its language is known.
pub const Marks = struct { old: ?highlight.Highlights = null, new: ?highlight.Highlights = null };
pub const history = @import("native/history.zig");
const canvas = sdk.canvas;
pub const keyboard = @import("native/keyboard.zig");
pub const selection = @import("native/selection.zig");
const gpa = std.heap.page_allocator;
pub const panic = std.debug.FullPanic(sdk.debug.capturePanic);
pub const app_icons = @import("native/icons.zig").all;

const theme = @import("native/theme.zig");
const easing = @import("native/motion.zig");

pub const Note = review.Note;
/// Progress as Patch saved it before the review store: one file per snapshot.
const Legacy = struct { reviewed: []const []const u8 = &.{}, notes: []const Note = &.{} };
const Anchor = struct { line: u32 = 0, line_end: u32 = 0, old: bool = false, file: ?usize = null };
/// A row of the review: a file's header (no code), one of its rows, its
/// closing spacer, or a slice (from 1) of a picture block a binary file shows.
pub const DisplayRow = struct { file: usize, code: ?usize = null, spacer: bool = false, media: u16 = 0 };
/// An image Patch registered for drawing, with its size in pixels.
pub const Picture = struct { id: canvas.ImageId, width: usize, height: usize };
/// The two sides of an image file, once decoded.
pub const ImageView = struct { old: ?Picture = null, new: ?Picture = null, failed: bool = false };
const image_base: canvas.ImageId = 0x1a6e0000;
const image_extensions = [_][]const u8{ ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico", ".heic", ".avif", ".icns" };
pub fn isImage(path: []const u8) bool {
    const ext = std.fs.path.extension(path);
    for (image_extensions) |known| if (std.ascii.eqlIgnoreCase(ext, known)) return true;
    return false;
}
/// The box a picture is drawn in: its pixels as points, scaled down to fit
/// a 420-point column and 360 points of height.
pub fn fitted(picture: Picture) struct { width: f32, height: f32 } {
    const w: f32 = @floatFromInt(@max(1, picture.width));
    const h: f32 = @floatFromInt(@max(1, picture.height));
    const scale = @min(1, @min(420 / w, 360 / h));
    return .{ .width = @max(1, w * scale), .height = @max(1, h * scale) };
}
/// A binary file's block: its pictures' tallest box with a caption above,
/// or one row saying what changed.
pub fn mediaRows(model: *const Model, index: usize) u16 {
    if (index >= model.images.len) return 1;
    const view_of = model.images[index];
    var tallest: f32 = 0;
    for ([_]?Picture{ view_of.old, view_of.new }) |side| if (side) |picture| {
        tallest = @max(tallest, fitted(picture).height);
    };
    if (tallest == 0) return 1;
    return @intFromFloat(@ceil((14 + 18 + 8 + 16 + tallest + 16 + 14) / 24));
}
pub const RailRow = struct { file: ?usize = null, directory: []const u8 = "" };
pub const Focus = enum { review, note, file_filter, search, palette };
pub const Palette = enum { closed, commands, files, symbols };
pub const SettingsSection = enum { review, layout, appearance, keyboard, about };
/// Preferences saved beside review progress, applied before the first load.
const Settings = struct { collapse_reviewed: bool = true, split: bool = true, sidebar: bool = true, mode: git.Mode = .working, base: []const u8 = "main", sidebar_width: f32 = 219, notes_width: f32 = 300, theme: []const u8 = "noir", glass: bool = false, colors: [5][]const u8 = .{ "", "", "", "", "" }, ignore_whitespace: bool = false, algorithm: git.Algorithm = .default, fold_generated: bool = true };
/// Colors a person can set over any theme, in Settings › Appearance.
pub const color_roles = [_][]const u8{ "Background", "Text", "Accent", "Added", "Removed" };
pub const Choice = struct { index: usize, score: u32, file: bool = false };
/// A review state taken back by undo: a file's, or one of its hunks'.
/// A review step to undo. A file's step keeps which of its hunks were
/// reviewed before it (in the review's arena), to give them back.
const ReviewChange = struct { file: usize, reviewed: bool, hunk: ?u16 = null, hunks: []const bool = &.{} };
/// A hunk of a file, by its index in `patch.File.hunks`.
pub const HunkRef = struct { file: usize, hunk: u16 };
/// Lines to show of a gap the diff left out: above a hunk's header (or, for
/// the tail, after the last hunk), from the gap's top or its bottom, a step
/// of them or all.
pub const Expansion = struct { file: usize, hunk: u16 = 0, tail: bool = false, from_top: bool = false, all: bool = false };
/// What blame says about one line, shown beside it.
pub const BlameView = struct { row: usize, file: usize, old: bool, line: u32, loading: bool = true, failed: bool = false, info: lookup.Blame = .{} };
/// Lines a step of expansion shows.
pub const expand_step: u32 = 20;
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
    canvas_height: f32 = 900,
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
    /// The highlighter states rows start in (`patch.Row.old_carry`).
    carries: []const syntax.State = &.{},
    /// Both sides of each file, read whole once the review is up; empty until then.
    sources: []const patch.Sides = &.{},
    /// Each file's sides highlighted whole (owned by `gpa`, as long as
    /// `files`, references included); empty until highlighted.
    marks: []Marks = &.{},
    /// Each file's decoded images, when it is an image file.
    images: []const ImageView = &.{},
    /// Blame for the line it was asked of, while its card is open.
    blame: ?BlameView = null,
    /// Where the name in the symbol palette is defined and used, and whether
    /// a search for it is running.
    symbol_hits: []const lookup.Hit = &.{},
    symbol_busy: bool = false,
    /// Blocks of lines the diff moved rather than changed.
    moves: []const patch.Move = &.{},
    /// Hunks reviewed on their own, by content.
    hunk_records: std.ArrayList(review.HunkRecord) = .empty,
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
    /// Lockfiles and `linguist-generated` paths open folded.
    fold_generated: bool = true,
    /// Diff options; changing one reads the comparison again.
    ignore_whitespace: bool = false,
    algorithm: git.Algorithm = .default,
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
    /// The notes of the comparison shown: those of this view (the whole
    /// comparison, or the commit shown), then any left on commits a rewrite
    /// dropped. Saved with the rest of the store's notes.
    notes: std.ArrayList(Note) = .empty,
    /// Every file change reviewed in this repository (or patch), by content.
    records: std.ArrayList(review.Record) = .empty,
    /// Files reviewed in an earlier version show only what changed since.
    since_review: bool = false,
    /// Branch mode: its commits, oldest first, and the one under review on
    /// its own (null for all of them together).
    commits: []const git.Commit = &.{},
    commit: ?usize = null,
    commit_states: []history.CommitState = &.{},
    commit_menu: bool = false,
    commit_offset: f32 = 0,
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
    reviewed_hunk: HunkRef,
    collapse_hunk: HunkRef,
    expand: Expansion,
    goto_move: struct { move: u32, to: bool },
    blame_line: selection.Hit,
    find_symbol_at: selection.Hit,
    close_blame,
    copy_text: []const u8,
    close_reference: usize,
    lookup_tick: sdk.EffectTimer,
    sources_tick: sdk.EffectTimer,
    shade_tick: sdk.EffectTimer,
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
    toggle_generated_setting,
    toggle_whitespace,
    set_algorithm: git.Algorithm,
    toggle_rail_setting,
    default_split: bool,
    default_mode: git.Mode,
    reset_widths,
    copy_data_path,
    toggle_since,
    select_commit: ?usize,
    toggle_commit_menu,
    close_commit_menu,
    commit_menu_scrolled: canvas.ScrollState,
    resolve_note: usize,
    reopen_note: usize,
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
    keeper_tick: sdk.EffectTimer,
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
    options: git.Options = .{},
    imported: ?[]const u8 = null,
    /// Patch's data folder, absolute; each repository's store sits in it.
    data: []const u8 = "",
    result: ?git.Review = null,
    files: []patch.File = &.{},
    moves: []const patch.Move = &.{},
    carries: []const syntax.State = &.{},
    /// What the store holds, split for the view: records; this view's notes
    /// (then those of dropped commits); every other note.
    store_dir: []const u8 = "",
    scope: []const u8 = "",
    records: std.ArrayList(review.Record) = .empty,
    hunk_records: std.ArrayList(review.HunkRecord) = .empty,
    notes: std.ArrayList(Note) = .empty,
    hidden: std.ArrayList(Note) = .empty,
    tips: std.ArrayList(review.Tip) = .empty,
    marks: std.ArrayList(review.Mark) = .empty,
    migrated: std.ArrayList([]const u8) = .empty,
    commit_states: []history.CommitState = &.{},
    /// A file changed after Git read it, so what is shown is already behind.
    stale: bool = false,
    /// The store changed while loading (a migration, a rewritten branch).
    dirty: bool = false,
    /// The store could not be read, so this review is not saved.
    store_failed: bool = false,
    /// The store, and the thread writing the rest of the working tree's
    /// versions into it once the review is up (those not needed at once).
    store: ?git.Store = null,
    keeper: ?std.Thread = null,
    keeper_done: std.atomic.Value(bool) = .init(false),
    keeper_stale: std.atomic.Value(bool) = .init(false),
    /// Reviewed versions to copy from the repository into the store, and
    /// every version the store must keep (taken as loading ends, so the
    /// thread reads nothing the review then changes).
    copies: []const []const u8 = &.{},
    referenced: std.StringHashMapUnmanaged(void) = .empty,
    failure: ?anyerror = null,
    done: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    /// Both sides of every file, read whole once the review is up (to show
    /// more context, highlight whole files, and draw images), in an arena
    /// of their own since the review's is the main thread's by then.
    sources: []patch.Sides = &.{},
    source_arena: std.heap.ArenaAllocator = .init(gpa),
    source_requests: []const SourceRequest = &.{},
    sourcer: ?std.Thread = null,
    sources_done: std.atomic.Value(bool) = .init(false),
    /// Each file's sides highlighted whole, after the sources are read.
    highlights: []Marks = &.{},
    highlights_done: std.atomic.Value(bool) = .init(false),
    /// Set as the review is let go of, so highlighting stops early.
    stopping: std.atomic.Value(bool) = .init(false),
    /// Files opened for reference, highlighted off the main thread.
    shades: std.ArrayList(*Shade) = .empty,
    const SourceRequest = struct { path: []const u8, old: []const u8, new: []const u8, disk: bool };
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
        } else blk: {
            // Where Git may keep what it makes while diffing a merge.
            if (self.options.commit.len > 0 and self.options.scratch.len > 0) std.Io.Dir.cwd().createDirPath(self.io, self.options.scratch) catch {};
            break :blk try git.read(alloc, self.io, self.repo, self.mode, self.base, self.head, self.options);
        };
        const result = self.result.?;
        self.files = try patch.parse(alloc, result.patch);
        if (result.identity.len > 0) self.files = try withWhitespaceOnly(alloc, self.files, result.identity);
        std.mem.sort(patch.File, self.files, {}, struct {
            fn less(_: void, a: patch.File, b: patch.File) bool {
                return std.mem.lessThan(u8, a.path, b.path);
            }
        }.less);
        markGenerated(alloc, self.io, result.root, self.files);
        // A commit's review opens with its message.
        if (self.options.commit.len > 0) for (result.commits) |commit| if (std.mem.eql(u8, commit.id, self.options.commit)) {
            var files: std.ArrayList(patch.File) = .empty;
            try files.append(alloc, try history.messageFile(alloc, commit.message));
            try files.appendSlice(alloc, self.files);
            self.files = files.items;
            break;
        };
        self.moves = patch.findMoves(alloc, self.files) catch &.{};
        // Without the store read whole, nothing is saved over it.
        self.remember(alloc) catch {
            self.store_dir = "";
            self.store_failed = true;
        };
        // The changes since review are lexed alongside the full diffs.
        var lexed: std.ArrayList(patch.File) = .empty;
        try lexed.appendSlice(alloc, self.files);
        for (self.files) |file| if (file.since) |since| try lexed.append(alloc, .{ .path = file.path, .unified = since.unified, .split = since.split });
        self.carries = try syntax.carryStates(alloc, lexed.items);
        if (self.store != null) {
            self.keeper = std.Thread.spawn(.{}, keepRest, .{self}) catch null;
            if (self.keeper == null) self.keeper_done.store(true, .release);
        }
        // What the sources thread reads, taken now: files change hands next.
        if (self.store != null and result.root.len > 0) {
            const requests = try alloc.alloc(SourceRequest, self.files.len);
            for (self.files, requests) |file, *request| request.* = .{
                .path = if (file.message or file.whitespace_only) "" else file.path,
                .old = file.old_blob,
                .new = file.new_blob,
                .disk = self.mode == .working and file.status != .deleted,
            };
            self.source_requests = requests;
            self.sourcer = std.Thread.spawn(.{}, readSources, .{self}) catch null;
        }
        if (self.sourcer == null) {
            self.sources_done.store(true, .release);
            self.highlights_done.store(true, .release);
        }
    }
    /// Reads both sides of every file: the old from Git, the new from Git
    /// too, or from the working tree when that is what is compared.
    fn readSources(self: *Job) void {
        defer self.highlights_done.store(true, .release);
        self.loadSides();
        self.sources_done.store(true, .release);
        // Then highlight each file whole, so every line is colored as the
        // file reads, not as a hunk cut from it.
        const alloc = self.source_arena.allocator();
        const marks = alloc.alloc(Marks, self.sources.len) catch return;
        @memset(marks, .{});
        for (self.source_requests, self.sources, marks) |request, sides, *mark| {
            if (self.stopping.load(.monotonic)) break;
            const language = highlight.languageFor(request.path) orelse continue;
            if (sides.old) |text| if (!sides.old_binary) {
                mark.old = highlight.highlightUntil(alloc, language, text.bytes, &self.stopping) catch null;
            };
            if (sides.new) |text| if (!sides.new_binary) {
                mark.new = highlight.highlightUntil(alloc, language, text.bytes, &self.stopping) catch null;
            };
        }
        self.highlights = marks;
    }
    fn loadSides(self: *Job) void {
        const alloc = self.source_arena.allocator();
        const result = self.result.?;
        const sources = alloc.alloc(patch.Sides, self.source_requests.len) catch return;
        @memset(sources, .{});
        var ids: std.ArrayList([]const u8) = .empty;
        for (self.source_requests) |request| {
            if (request.path.len == 0) continue;
            if (request.old.len > 0) ids.append(alloc, request.old) catch return;
            if (!request.disk and request.new.len > 0) ids.append(alloc, request.new) catch return;
        }
        var blobs = git.readBlobs(alloc, self.io, result.root, self.store.?, ids.items) catch std.StringHashMapUnmanaged([]const u8).empty;
        const limit = 16 * 1024 * 1024;
        for (self.source_requests, sources) |request, *sides| {
            if (request.path.len == 0) continue;
            if (blobs.get(request.old)) |bytes| setSide(alloc, sides, true, bytes);
            if (request.disk) {
                const path = std.fs.path.join(alloc, &.{ result.root, request.path }) catch continue;
                const bytes = std.Io.Dir.cwd().readFileAlloc(self.io, path, alloc, .limited(limit)) catch continue;
                setSide(alloc, sides, false, bytes);
            } else if (blobs.get(request.new)) |bytes| setSide(alloc, sides, false, bytes);
        }
        self.sources = sources;
    }
    fn setSide(alloc: std.mem.Allocator, sides: *patch.Sides, old: bool, bytes: []const u8) void {
        const binary = patch.looksBinary(bytes);
        const text: patch.Text = if (binary) .{ .bytes = bytes, .starts = &.{} } else patch.textOf(alloc, bytes) catch return;
        if (old) {
            sides.old = text;
            sides.old_binary = binary;
        } else {
            sides.new = text;
            sides.new_binary = binary;
        }
    }
    /// Fills the store off the path to the first frame: the working tree's
    /// versions not yet in it, so a change marked reviewed can later be
    /// diffed, and reviewed versions the repository alone holds.
    fn keepRest(self: *Job) void {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const result = self.result.?;
        const context = history.Context{ .alloc = arena.allocator(), .io = self.io, .root = result.root, .store = self.store, .options = self.options };
        if (self.mode == .working and !history.snapshot(context, self.files, null)) self.keeper_stale.store(true, .release);
        git.copyBlobs(arena.allocator(), self.io, result.root, self.store.?, self.copies) catch {};
        history.prune(arena.allocator(), self.io, self.store.?.objects, &self.referenced);
        self.keeper_done.store(true, .release);
    }
    /// Reads the store and brings it to what was just read: which changes
    /// were reviewed, what changed since, where notes are now, and how a
    /// rewritten branch's commits pair with the ones reviewed.
    fn remember(self: *Job, alloc: std.mem.Allocator) !void {
        const result = self.result.?;
        const seed = self.imported orelse result.root;
        const folder = review.folder(seed);
        self.store_dir = try std.fmt.allocPrint(alloc, "{s}/{s}/{s}", .{ self.data, if (self.imported != null) "patches" else "repos", &folder });
        const objects = try std.fmt.allocPrint(alloc, "{s}/objects", .{self.store_dir});
        try std.Io.Dir.cwd().createDirPath(self.io, if (self.imported != null) self.store_dir else objects);
        const store_path = try std.fmt.allocPrint(alloc, "{s}/review.json", .{self.store_dir});
        if (std.Io.Dir.cwd().readFileAlloc(self.io, store_path, alloc, .limited(32 * 1024 * 1024))) |bytes| {
            const stored = try std.json.parseFromSliceLeaky(review.Store, alloc, bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
            try self.records.appendSlice(alloc, stored.records);
            try self.hunk_records.appendSlice(alloc, stored.hunks);
            try self.hidden.appendSlice(alloc, stored.notes);
            try self.tips.appendSlice(alloc, stored.tips);
            try self.marks.appendSlice(alloc, stored.commits);
            try self.migrated.appendSlice(alloc, stored.migrated);
        } else |err| if (err != error.FileNotFound) return err;
        var scope_buffer: [256]u8 = undefined;
        const head_name = if (self.head.len > 0) self.head else result.head;
        self.scope = try alloc.dupe(u8, if (self.imported != null) "patch" else review.scope(&scope_buffer, @tagName(self.mode), head_name));
        if (self.options.commit.len == 0) self.migrate(alloc);
        const store: ?git.Store = if (self.imported == null and result.objects.len > 0) .{ .objects = objects, .repository = result.objects } else null;
        self.store = store;
        var context = history.Context{ .alloc = alloc, .io = self.io, .root = result.root, .store = store, .options = self.options };
        // A message's versions are blobs too, so a reworded message diffs.
        if (store) |value| for (self.files) |file| if (file.message and !value.has(self.io, file.new_blob)) {
            for (result.commits) |commit| if (std.mem.eql(u8, commit.id, self.options.commit)) {
                _ = git.writeBlob(alloc, self.io, result.root, value, commit.message) catch {};
            };
        };
        var pairs: []const git.Pair = &.{};
        if (self.imported == null and self.mode == .branch) pairs = self.pair(alloc);
        // The message this commit had when last seen, under its id then or now.
        if (self.options.commit.len > 0) {
            var earlier: []const u8 = self.options.commit;
            for (pairs) |pairing| if (std.mem.eql(u8, pairing.new, earlier)) {
                earlier = pairing.old;
            };
            for (self.marks.items) |mark| if (mark.message.len > 0 and (std.mem.eql(u8, mark.id, earlier) or std.mem.eql(u8, mark.id, self.options.commit))) {
                context.earlier_message = mark.message;
            };
        }
        // This view's notes: the comparison's, and the commit's when one is
        // shown; in the combined view, also those of commits a rewrite dropped.
        var dropped: std.ArrayList(Note) = .empty;
        var others: std.ArrayList(Note) = .empty;
        for (self.hidden.items) |note| {
            if (!std.mem.eql(u8, note.scope, self.scope)) {
                try others.append(alloc, note);
            } else if (std.mem.eql(u8, note.commit, self.options.commit)) {
                try self.notes.append(alloc, note);
            } else if (self.options.commit.len == 0 and !listed(result.commits, note.commit)) {
                try dropped.append(alloc, note);
            } else try others.append(alloc, note);
        }
        self.hidden = others;
        // The working tree's versions this comparison diffs against now; the
        // rest are written once the review is up.
        if (self.imported == null and self.mode == .working) self.stale = !history.snapshot(context, self.files, history.urgent(alloc, self.files, self.records.items, self.notes.items));
        self.copies = history.toKeep(context, self.files, self.records.items);
        history.apply(context, self.files, self.records.items, self.notes.items);
        try self.notes.appendSlice(alloc, dropped.items);
        // Reviewed commit by commit, a file counts as reviewed together too.
        if (self.mode == .branch and self.options.commit.len == 0) for (self.files) |*file| {
            if (file.reviewed or !review.chained(alloc, self.records.items, file.path, file.old_blob, file.new_blob)) continue;
            file.reviewed = true;
            file.prior = .same;
        };
        // Hunks reviewed on their own; a file whose every hunk was is reviewed.
        for (self.files) |*file| {
            if (file.hunks.len == 0) continue;
            var all = true;
            for (file.hunks) |*hunk| {
                hunk.reviewed = file.reviewed or review.hunkReviewed(self.hunk_records.items, file.path, hunk.*);
                all = all and hunk.reviewed;
            }
            if (all and !file.reviewed) {
                file.reviewed = true;
                file.prior = .same;
                review.mark(alloc, &self.records, file.*) catch {};
                self.dirty = true;
            }
        }
        if (self.mode == .branch) self.commit_states = @constCast(history.commitStates(alloc, result.commits, self.records.items, self.marks.items, pairs));
        if (store != null) {
            for (self.records.items) |reviewed| for ([_][]const u8{ reviewed.old, reviewed.new }) |id| try self.referenced.put(alloc, id, {});
            for ([_][]const Note{ self.notes.items, self.hidden.items }) |group| for (group) |note| try self.referenced.put(alloc, note.blob, {});
            for (self.marks.items) |mark| try self.referenced.put(alloc, mark.message, {});
            for (self.files) |file| for ([_][]const u8{ file.old_blob, file.new_blob }) |id| try self.referenced.put(alloc, id, {});
        }
    }
    /// Pairs a rewritten branch's commits with those last reviewed (by
    /// `git range-diff` while Git has the old ones, else by subject and
    /// author time), moving notes to their commits' new ids and keeping
    /// reviews of commits whose changes are unchanged. Remembers the tip.
    fn pair(self: *Job, alloc: std.mem.Allocator) []const git.Pair {
        const result = self.result.?;
        var pairs: []const git.Pair = &.{};
        var previous: ?*review.Tip = null;
        for (self.tips.items) |*tip| if (std.mem.eql(u8, tip.scope, self.scope)) {
            previous = tip;
        };
        if (previous) |tip| if (tip.tip.len > 0 and !std.mem.eql(u8, tip.tip, result.tip)) {
            if (tip.base.len > 0 and result.merge_base.len > 0 and git.hasCommit(alloc, self.io, result.root, tip.tip)) {
                const old_range = std.fmt.allocPrint(alloc, "{s}..{s}", .{ tip.base, tip.tip }) catch "";
                const new_range = std.fmt.allocPrint(alloc, "{s}..{s}", .{ result.merge_base, result.tip }) catch "";
                pairs = git.rangeDiff(alloc, self.io, result.root, old_range, new_range) catch &.{};
            }
            if (pairs.len == 0) {
                var found: std.ArrayList(git.Pair) = .empty;
                for (self.marks.items) |mark| {
                    if (listed(result.commits, mark.id) or mark.subject.len == 0) continue;
                    for (result.commits) |commit| if (commit.time == mark.time and std.mem.eql(u8, commit.subject(), mark.subject)) {
                        found.append(alloc, .{ .old = mark.id, .new = commit.id, .same = false }) catch break;
                        break;
                    };
                }
                pairs = found.items;
            }
        };
        for (pairs) |pairing| {
            for (self.hidden.items) |*note| if (std.mem.eql(u8, note.scope, self.scope) and std.mem.eql(u8, note.commit, pairing.old)) {
                note.commit = pairing.new;
                self.dirty = true;
            };
            for (self.marks.items) |mark| if (std.mem.eql(u8, mark.id, pairing.old)) {
                for (result.commits) |commit| if (std.mem.eql(u8, commit.id, pairing.new)) {
                    self.marks.append(alloc, .{ .id = commit.id, .subject = commit.subject(), .time = commit.time, .reviewed = mark.reviewed and pairing.same, .message = mark.message }) catch {};
                    self.dirty = true;
                };
                break;
            };
        }
        const now = review.Tip{ .scope = self.scope, .base = result.merge_base, .tip = result.tip };
        if (previous) |tip| {
            if (!std.mem.eql(u8, tip.tip, now.tip) or !std.mem.eql(u8, tip.base, now.base)) self.dirty = true;
            tip.* = now;
        } else if (result.tip.len > 0) {
            self.tips.append(alloc, now) catch {};
            self.dirty = true;
        }
        return pairs;
    }
    /// Brings in progress saved before the review store, under the key it
    /// had then: the comparison as Git showed it by default. Each scope is
    /// tried once.
    fn migrate(self: *Job, alloc: std.mem.Allocator) void {
        const attempt = std.fmt.allocPrint(alloc, "scope {s}", .{self.scope}) catch return;
        for (self.migrated.items) |done| if (std.mem.eql(u8, done, attempt)) return;
        self.migrated.append(alloc, attempt) catch return;
        self.dirty = true;
        if (!legacyFiles(self.io, self.data)) return;
        const result = self.result.?;
        const text = if (self.imported != null) result.patch else (git.read(alloc, self.io, self.repo, self.mode, self.base, self.head, .{ .full_index = false }) catch return).patch;
        const key = review.legacyKey(self.imported orelse self.repo, text);
        const path = std.fmt.allocPrint(alloc, "{s}/{s}.json", .{ self.data, &key }) catch return;
        const bytes = std.Io.Dir.cwd().readFileAlloc(self.io, path, alloc, .limited(4 * 1024 * 1024)) catch return;
        const legacy = std.json.parseFromSliceLeaky(Legacy, alloc, bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch return;
        for (legacy.reviewed) |reviewed| for (self.files) |file| if (std.mem.eql(u8, file.path, reviewed)) {
            review.mark(alloc, &self.records, file) catch {};
        };
        for (legacy.notes) |legacy_note| {
            var note = legacy_note;
            note.scope = self.scope;
            for (self.files) |file| if (std.mem.eql(u8, file.path, note.path)) {
                note.blob = if (note.old) file.old_blob else file.new_blob;
                note.excerpt = review.excerpt(alloc, file.unified, note.old, note.line, note.line_end);
            };
            self.hidden.append(alloc, note) catch {};
        }
        self.migrated.append(alloc, alloc.dupe(u8, &key) catch return) catch {};
    }
    /// Whether any progress saved before the store is left to bring in:
    /// files named by a 64-digit key.
    fn legacyFiles(io: std.Io, data: []const u8) bool {
        var dir = std.Io.Dir.cwd().openDir(io, data, .{ .iterate = true }) catch return false;
        defer dir.close(io);
        var entries = dir.iterate();
        while (entries.next(io) catch return false) |entry| {
            if (entry.kind == .file and entry.name.len == 69 and std.mem.endsWith(u8, entry.name, ".json")) return true;
        }
        return false;
    }
    fn listed(commits: []const git.Commit, id: []const u8) bool {
        for (commits) |commit| if (std.mem.eql(u8, commit.id, id)) return true;
        return false;
    }
    /// Files the default diff changes but the shown one does not: every change
    /// was whitespace. They stay listed, so their review state stays too.
    fn withWhitespaceOnly(alloc: std.mem.Allocator, shown: []patch.File, identity: []const u8) ![]patch.File {
        var paths: std.StringHashMapUnmanaged(void) = .empty;
        for (shown) |file| try paths.put(alloc, file.path, {});
        var files: std.ArrayList(patch.File) = .fromOwnedSlice(shown);
        for (try patch.parse(alloc, identity)) |file| if (!paths.contains(file.path)) {
            try files.append(alloc, .{ .path = file.path, .previous = file.previous, .status = file.status, .unified = &.{}, .split = &.{}, .whitespace_only = true, .old_blob = file.old_blob, .new_blob = file.new_blob, .mode = file.mode, .change = file.change });
        };
        return files.items;
    }
    /// Generated files: lockfiles, unless an attribute says otherwise, and
    /// paths the repository marks `linguist-generated`.
    fn markGenerated(alloc: std.mem.Allocator, io: std.Io, root: []const u8, files: []patch.File) void {
        const paths = alloc.alloc([]const u8, files.len) catch return;
        const marks = alloc.alloc(?bool, files.len) catch return;
        for (files, paths) |file, *path| path.* = file.path;
        if (root.len > 0) git.generated(alloc, io, root, paths, marks) else @memset(marks, null);
        for (files, marks) |*file, mark| file.generated = mark orelse patch.isLockfile(file.path);
    }
    fn destroy(self: *Job) void {
        self.stopping.store(true, .monotonic);
        for (self.shades.items) |shade| shade.destroy();
        self.shades.deinit(gpa);
        if (self.thread) |thread| thread.join();
        if (self.keeper) |thread| thread.join();
        if (self.sourcer) |thread| thread.join();
        self.source_arena.deinit();
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
    /// The attributes file Git diffs with (`git.Options.attributes`).
    attributes_path: []const u8 = "",
    /// The data folder, absolute (Git runs elsewhere and needs it whole).
    data_abs: []const u8 = "",
    /// A file to return to once a re-read finishes, owned by `gpa`.
    keep: ?[]const u8 = null,
    measure_startup: bool = false,
    review_reported: bool = false,
    pointer_point: sdk.geometry.PointF = .{},
    /// A key event from the settings window is being delivered.
    settings_keys: bool = false,
    /// A Git question asked off the main thread (blame, grep), and whether
    /// the symbol search must run again for a query typed meanwhile.
    lookup: ?*Lookup = null,
    lookup_again: bool = false,
    /// Images registered for the review shown, to let go of on the next.
    registered: std.ArrayList(canvas.ImageId) = .empty,
    /// The output the shown blame and symbol hits point into, owned by `gpa`.
    blame_output: []u8 = &.{},
    symbol_output: []u8 = &.{},
};
/// A file opened for reference, highlighted on a thread of its own. Its
/// text is the review's (the review outlives it: `Job.destroy`).
const Shade = struct {
    language: highlight.Language,
    path: []const u8,
    text: []const u8,
    stop: *const std.atomic.Value(bool),
    arena: std.heap.ArenaAllocator = .init(gpa),
    result: ?highlight.Highlights = null,
    done: std.atomic.Value(bool) = .init(false),
    adopted: bool = false,
    thread: ?std.Thread = null,
    fn work(self: *Shade) void {
        self.result = highlight.highlightUntil(self.arena.allocator(), self.language, self.text, self.stop) catch null;
        self.done.store(true, .release);
    }
    fn destroy(self: *Shade) void {
        if (self.thread) |thread| thread.join();
        self.arena.deinit();
        gpa.destroy(self);
    }
};
/// One Git question, asked on a thread of its own.
const Lookup = struct {
    kind: enum { blame, grep },
    io: std.Io,
    arena: std.heap.ArenaAllocator = .init(gpa),
    root: []const u8,
    args: []const []const u8 = &.{},
    output: []u8 = &.{},
    failed: bool = false,
    done: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    /// A grep's revision prefix to strip and the name searched.
    strip: []const u8 = "",
    query: []const u8 = "",
    /// A path whose staged version (the index's) a blame reads as the
    /// file's contents (`--contents -`), with the store that passes it in.
    staged_path: []const u8 = "",
    store: ?git.Store = null,
    fn work(self: *Lookup) void {
        self.output = self.answer() catch blk: {
            self.failed = true;
            break :blk &.{};
        };
        self.done.store(true, .release);
    }
    fn answer(self: *Lookup) ![]u8 {
        if (self.staged_path.len == 0) return git.ask(gpa, self.io, self.root, self.args);
        const spec = try std.fmt.allocPrint(self.arena.allocator(), ":{s}", .{self.staged_path});
        const contents = try git.ask(gpa, self.io, self.root, &.{ "show", spec });
        defer gpa.free(contents);
        return git.askWith(gpa, self.io, self.root, self.store orelse return error.GitCommandFailed, self.args, contents);
    }
    fn destroy(self: *Lookup) void {
        if (self.thread) |thread| thread.join();
        self.arena.deinit();
        gpa.destroy(self);
    }
};
var session: Session = undefined;

pub fn ioHandle() std.Io {
    return session.io;
}
pub fn canvasWidth() ?f32 {
    const runtime = session.runtime orelse return null;
    const frame = runtime.gpuSurfaceFrame(1, "main-canvas") catch return null;
    return if (frame.size.width > 0) frame.size.width else null;
}
fn canvasHeight() ?f32 {
    const runtime = session.runtime orelse return null;
    const frame = runtime.gpuSurfaceFrame(1, "main-canvas") catch return null;
    return if (frame.size.height > 0) frame.size.height else null;
}
/// The review list's height: the window, less its insets, the review's
/// title strip, and an error banner when one shows. The status pill floats
/// over the list, so it takes no height.
pub fn listHeight(model: *const Model) f32 {
    const height = canvasHeight() orelse model.canvas_height;
    return height - 2 * theme.pane_inset - theme.pane_header - (if (model.error_text.len > 0) @as(f32, 32) else 0);
}
/// The review's edges carry 24-point pills: the file being read pinned at
/// the top once its header scrolls under it, and the status at the foot.
pub const pill_height: f32 = 24;
/// The file pinned at the review's top: an unfolded file whose header has
/// begun to scroll away, until its pane's closing edge reaches the top (then
/// the pane ends on its own, clear of the next file's header).
pub fn pinnedFile(model: *const Model, offset: f32) ?usize {
    if (model.display.len == 0 or offset <= 0) return null;
    const top = @min(model.display.len - 1, @as(usize, @intFromFloat(offset / 24)));
    if (model.display[top].spacer) return null;
    const file = model.display[top].file;
    if (file >= model.starts.len or model.files[file].collapsed) return null;
    const start = model.starts[file];
    if (start > top or (start == top and @mod(offset, 24) == 0)) return null;
    return file;
}
/// Whether the status has something to say: where the cursor is, the find
/// field or its matches, a pending key, or how far the code is panned.
pub fn statusShown(model: *const Model) bool {
    var buffer: [24]u8 = undefined;
    const position = model.cursor_active and !onFoldedHeader(model);
    return model.focus == .search or position or model.keys.hint(&buffer).len > 0 or model.scroll_x > 0 or model.search_query.len > 0;
}
/// The pill at the review's foot shows while the status has something to
/// say or a pane runs past the bottom edge, so the cut pane still ends round.
pub fn bottomPill(model: *const Model, offset: f32, height: f32) bool {
    if (height < 4 * pill_height or model.display.len == 0) return false;
    const end = @as(f32, @floatFromInt(model.display.len)) * 24 - 3 - offset;
    return statusShown(model) or end > height - 2.5;
}

fn showError(model: *Model, err: anyerror) void {
    model.error_text = switch (err) {
        error.InvalidRepository => "Choose a Git repository.",
        error.InvalidBaseBranch => "Base branch not found.",
        error.InvalidHeadBranch => "Head branch not found.",
        error.NoInitialCommit => "This repository has no commits yet.",
        error.InvalidPatch, error.InvalidHunk => "This patch could not be read.",
        error.PatchTooLarge, error.StreamTooLong => "Patch exceeds 64 MB.",
        error.CommitNotFound => "That commit is no longer on the branch.",
        else => @errorName(err),
    };
}
fn startLoad(model: *Model) bool {
    if (session.pending != null) return false;
    const job = gpa.create(Job) catch return false;
    job.* = .{ .io = session.io, .repo = session.repo, .mode = model.mode, .base = "main", .imported = session.imported, .data = session.data_abs, .options = .{ .ignore_whitespace = model.ignore_whitespace, .algorithm = model.algorithm, .attributes = session.attributes_path } };
    const alloc = job.arena.allocator();
    job.base = alloc.dupe(u8, model.base.text()) catch "main";
    job.head = alloc.dupe(u8, model.compare_head.text()) catch "";
    if (model.mode == .branch and session.imported == null) if (model.commit) |index| if (index < model.commits.len) {
        job.options.commit = alloc.dupe(u8, model.commits[index].id) catch "";
    };
    job.options.scratch = std.fmt.allocPrint(alloc, "{s}/scratch/objects", .{session.data_abs}) catch "";
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
        if (file.binary) {
            for (0..mediaRows(model, index)) |slice| rows.append(alloc, .{ .file = index, .media = @intCast(slice + 1) }) catch return;
            rows.append(alloc, .{ .file = index, .spacer = true }) catch return;
            continue;
        }
        const source = if (model.split) file.split else file.unified;
        var in_change = false;
        // Hunks folded away show only their headers (not while the rows are
        // the changes since review, whose hunks are another diff's).
        const hunks = if (file.showing_since) &[_]patch.Hunk{} else file.hunks;
        var headed = false;
        for (source, 0..) |row, code| {
            // Rows expanded above the first header belong to no hunk.
            headed = headed or row.meta;
            if (!row.meta and headed and row.hunk < hunks.len and hunks[row.hunk].collapsed) continue;
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
    anchorBlame(model);
}
/// Keeps an open blame card beside its line as rows come and go, closing
/// it when the line is no longer shown.
fn anchorBlame(model: *Model) void {
    const shown = if (model.blame) |*value| value else return;
    if (shown.file < model.starts.len) {
        const end = if (shown.file + 1 < model.starts.len) model.starts[shown.file + 1] else model.display.len;
        for (model.starts[shown.file]..end) |index| {
            const row = sourceRow(model, index) orelse continue;
            if ((if (shown.old) row.old else row.new) == shown.line) {
                shown.row = index;
                return;
            }
        }
    }
    model.blame = null;
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
    const bytes = std.json.Stringify.valueAlloc(gpa, Settings{ .collapse_reviewed = model.collapse_reviewed, .split = model.split, .sidebar = model.sidebar, .mode = model.default_mode, .base = model.base.text(), .sidebar_width = model.sidebar_width, .notes_width = model.notes_width, .theme = theme.schemes[model.theme_index].id, .glass = model.glass_panes, .colors = colors, .ignore_whitespace = model.ignore_whitespace, .algorithm = model.algorithm, .fold_generated = model.fold_generated }, .{}) catch return;
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
    model.fold_generated = value.fold_generated;
    model.ignore_whitespace = value.ignore_whitespace;
    model.algorithm = value.algorithm;
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
/// Saves the store: every record, this view's notes with every other note,
/// where each branch's review stood, and the commits worth finding again.
/// It is written whole beside the old one and renamed over it.
fn persist(model: *Model) void {
    const job = session.document orelse return;
    if (job.store_dir.len == 0) return;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const alloc = arena.allocator();
    var notes: std.ArrayList(Note) = .empty;
    notes.appendSlice(alloc, model.notes.items) catch return;
    notes.appendSlice(alloc, job.hidden.items) catch return;
    const store = review.Store{ .records = model.records.items, .notes = notes.items, .tips = job.tips.items, .commits = job.marks.items, .hunks = model.hunk_records.items, .migrated = job.migrated.items };
    const bytes = std.json.Stringify.valueAlloc(alloc, store, .{}) catch return;
    const path = std.fmt.allocPrint(alloc, "{s}/review.json", .{job.store_dir}) catch return;
    const temporary = std.fmt.allocPrint(alloc, "{s}/review.json.new", .{job.store_dir}) catch return;
    std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = temporary, .data = bytes }) catch |err| return showError(model, err);
    std.Io.Dir.cwd().rename(temporary, std.Io.Dir.cwd(), path, session.io) catch |err| showError(model, err);
}
/// Where a file folds by default: reviewed ones (when that setting is on),
/// whitespace-only ones, and generated ones (when that one is).
fn defaultFold(model: *const Model, file: patch.File) bool {
    return (file.reviewed and model.collapse_reviewed) or file.whitespace_only or (file.generated and model.fold_generated);
}
/// Shows, or stops showing, only what changed since review: a file reviewed
/// in an earlier version shows the diff from that version, and files whose
/// change was reviewed fold away.
fn showSince(model: *Model, on: bool) void {
    model.since_review = on;
    for (model.files) |*file| {
        if (file.since != null and file.showing_since != on) file.swapSince();
        file.collapsed = if (!on) defaultFold(model, file.*) else switch (file.prior) {
            .same, .rebased => true,
            .changed, .base => false,
            .none => defaultFold(model, file.*),
        };
    }
}
/// Files that an earlier review saw in another version.
pub fn changedSince(model: *const Model) usize {
    var count: usize = 0;
    for (model.files) |file| count += @intFromBool(file.prior == .changed or file.prior == .base);
    return count;
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
        if (session.keep) |path| gpa.free(path);
        session.keep = null;
        // A commit rewritten away: review the branch as a whole instead.
        if (err == error.CommitNotFound) {
            model.commit = null;
            load(model, fx);
        }
        return;
    }
    const old_document = session.document;
    session.document = job;
    model.files = job.files;
    model.moves = job.moves;
    model.carries = job.carries;
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
    model.commit_menu = false;
    focusReview(model);
    model.notes = job.notes;
    model.records = job.records;
    model.hunk_records = job.hunk_records;
    model.sources = &.{};
    if (model.marks.len > 0) gpa.free(model.marks);
    model.marks = &.{};
    if (model.images.len > 0) gpa.free(model.images);
    model.images = &.{};
    model.blame = null;
    model.commits = job.result.?.commits;
    model.commit_states = job.commit_states;
    model.commit = null;
    if (job.options.commit.len > 0) for (model.commits, 0..) |commit, index| if (std.mem.eql(u8, commit.id, job.options.commit)) {
        model.commit = index;
    };
    model.repository = job.result.?.repository;
    model.branch = if (job.result.?.kind.len == 3) job.result.?.base else "patch";
    model.head = if (job.result.?.kind.len == 3) job.result.?.head else "";
    model.branch_names = if (job.result.?.kind.len == 3) job.result.?.branches else "";
    model.imported = job.result.?.kind.len != 3;
    model.editing = false;
    model.draft.clear();
    model.generation += 1;
    model.scroll_x = 0;
    for (model.files) |*file| {
        file.collapsed = defaultFold(model, file.*);
        for (file.hunks) |*hunk| hunk.collapsed = hunk.reviewed and model.collapse_reviewed;
    }
    // Still reading what changed since review, if there is any.
    if (model.since_review) showSince(model, changedSince(model) > 0);
    reindex(model);
    layoutRows(model);
    model.jump_offset = null;
    if (session.keep) |path| {
        defer gpa.free(path);
        session.keep = null;
        for (model.files, 0..) |file, index| if (std.mem.eql(u8, file.path, path)) {
            jump(model, fx, index);
            break;
        };
    }
    if (old_document) |old_job| old_job.destroy();
    if (job.dirty) persist(model);
    if (job.stale) notify(model, fx, "Files changed while loading · ⌘R reads them again");
    if (job.store_failed) model.error_text = "Saved review progress could not be read; this review will not be saved.";
    if (job.keeper != null) fx.startTimer(.{ .key = 10, .interval_ms = 150, .mode = .repeating, .on_fire = Effects.timerMsg(.keeper_tick) });
    // Sources and highlights are taken in as each is ready, the highlights
    // perhaps well after the sources.
    if (!job.highlights_done.load(.acquire)) fx.startTimer(.{ .key = 11, .interval_ms = 16, .mode = .repeating, .on_fire = Effects.timerMsg(.sources_tick) });
    if (job.sources_done.load(.acquire)) adoptSources(model, fx);
    if (session.imported == null) {
        const last_path = std.fmt.allocPrint(gpa, "{s}/repository", .{session.data_dir}) catch return;
        defer gpa.free(last_path);
        std.Io.Dir.cwd().writeFile(session.io, .{ .sub_path = last_path, .data = session.repo }) catch {};
    }
    if (session.measure_startup and model.generation == 1) std.debug.print("patch-perf: review_ready wall_ns={d}\n", .{std.Io.Clock.real.now(session.io).nanoseconds});
}
/// A place in the review that survives the rows changing around it: a
/// file and the lines of its row (or its header), with how far into that row
/// the view's top was.
const Place = struct { file: usize, old: u32 = 0, new: u32 = 0, header: bool = false, hunk: u16 = 0, tail: bool = false, spacer: bool = false };
fn placeOf(model: *const Model, index: usize) ?Place {
    if (index >= model.display.len) return null;
    const entry = model.display[index];
    if (entry.spacer) return .{ .file = entry.file, .spacer = true };
    const code = entry.code orelse return .{ .file = entry.file, .header = true };
    const file = model.files[entry.file];
    const rows = if (model.split) file.split else file.unified;
    if (code >= rows.len) return .{ .file = entry.file, .header = true };
    const row = rows[code];
    if (row.meta) return .{ .file = entry.file, .hunk = row.hunk, .tail = row.tail, .old = std.math.maxInt(u32) };
    return .{ .file = entry.file, .old = row.old, .new = row.new };
}
/// Where a place is now: its row, or the nearest row of its file before it.
fn findPlace(model: *const Model, place: Place) usize {
    if (place.file >= model.starts.len) return 0;
    const start = model.starts[place.file];
    if (place.header) return start;
    const end = if (place.file + 1 < model.starts.len) model.starts[place.file + 1] else model.display.len;
    var best = start;
    for (start..end) |index| {
        const entry = model.display[index];
        if (entry.spacer) {
            if (place.spacer) return index;
            continue;
        }
        const code = entry.code orelse continue;
        const file = model.files[entry.file];
        const rows = if (model.split) file.split else file.unified;
        const row = rows[code];
        if (place.old == std.math.maxInt(u32)) {
            if (row.meta and row.tail == place.tail and (place.tail or row.hunk == place.hunk)) return index;
            continue;
        }
        if (row.meta) continue;
        if ((place.new > 0 and row.new == place.new) or (place.new == 0 and row.old == place.old and row.new == 0)) return index;
        if (place.new > 0 and row.new > 0 and row.new < place.new) best = index;
    }
    return best;
}
/// Lays the rows out again after a file's rows changed, keeping the view and
/// the cursor where they were.
fn relayout(model: *Model, fx: *Effects) void {
    const top_index: usize = @intFromFloat(@max(0, model.scroll_offset) / 24);
    const within = model.scroll_offset - @as(f32, @floatFromInt(top_index)) * 24;
    const top = placeOf(model, top_index);
    const cursor = if (model.cursor_active) placeOf(model, model.cursor) else null;
    layoutRows(model);
    findMatches(model);
    clearSelection(model);
    if (cursor) |place| model.cursor = findPlace(model, place) else model.cursor = @min(model.cursor, model.display.len -| 1);
    if (top) |place| requestScroll(model, fx, @as(f32, @floatFromInt(findPlace(model, place))) * 24 + within);
}
/// Sets a file's full-diff rows, wherever they are kept while the changes
/// since review are shown.
fn setRows(alloc: std.mem.Allocator, file: *patch.File, rows: []patch.Row) void {
    const split = patch.pairRows(alloc, rows) catch return;
    if (file.showing_since) {
        file.since.?.unified = rows;
        file.since.?.split = split;
    } else {
        file.unified = rows;
        file.split = split;
    }
}
/// Takes in the files' sides once read: files whose diff stops before the
/// file does gain a header for the rest, so every gap can be opened.
fn adoptSources(model: *Model, fx: *Effects) void {
    const job = session.document orelse return;
    if (job.highlights_done.load(.acquire)) {
        adoptMarks(model, job);
        fx.cancelTimer(11);
    }
    // Files opened for reference since (after the review's own) have none.
    if (model.sources.len > 0 or job.sources.len == 0 or job.sources.len > model.files.len) return;
    model.sources = job.sources;
    const alloc = job.arena.allocator();
    var changed = registerImages(model, fx);
    for (model.files[0..model.sources.len], 0..) |*file, index| {
        const text = model.sources[index].new orelse continue;
        if (file.message or file.binary or model.sources[index].new_binary or file.status == .added or file.status == .deleted) continue;
        const rows = file.fullRows();
        const tailed = patch.withTail(alloc, @constCast(rows), text.count()) catch continue;
        if (tailed.ptr == rows.ptr) continue;
        if (file.compact.len == 0) file.compact = tailed;
        setRows(alloc, file, tailed);
        changed = true;
    }
    if (changed) relayout(model, fx);
}
/// Takes in the files' highlights, keeping a slot for each file (files
/// opened for reference are highlighted as they open).
fn adoptMarks(model: *Model, job: *Job) void {
    const marks = gpa.alloc(Marks, model.files.len) catch return;
    @memset(marks, .{});
    for (marks, 0..) |*mark, index| {
        if (index < job.highlights.len) mark.* = job.highlights[index] else if (index < model.marks.len) mark.* = model.marks[index];
    }
    if (model.marks.len > 0) gpa.free(model.marks);
    model.marks = marks;
}
/// Decodes the image files' sides for drawing, letting go of the last
/// review's. Returns whether any file now has pictures.
fn registerImages(model: *Model, fx: *Effects) bool {
    for (session.registered.items) |id| _ = fx.unregisterImage(id);
    session.registered.clearRetainingCapacity();
    if (model.images.len > 0) gpa.free(model.images);
    model.images = &.{};
    const views = gpa.alloc(ImageView, model.files.len) catch return false;
    @memset(views, .{});
    var any = false;
    for (model.files, 0..) |file, index| {
        if (!file.binary or !isImage(file.path) or index >= model.sources.len) continue;
        const sides = model.sources[index];
        for ([_]bool{ true, false }) |old| {
            const text = sides.side(old) orelse continue;
            const id = image_base + index * 2 + @intFromBool(!old);
            const registered = fx.registerImageBytes(id, text.bytes) catch {
                views[index].failed = true;
                continue;
            };
            session.registered.append(gpa, id) catch {};
            const picture = Picture{ .id = id, .width = registered.width, .height = registered.height };
            if (old) views[index].old = picture else views[index].new = picture;
            any = true;
        }
    }
    model.images = views;
    return any;
}
/// Shows lines the diff left out of a file: a step of them, or all.
fn expandGap(model: *Model, fx: *Effects, expansion: Expansion) void {
    if (expansion.file >= model.files.len or expansion.file >= model.sources.len) return;
    const file = &model.files[expansion.file];
    if (file.showing_since) return notify(model, fx, "Context shows with all changes, not changes since review");
    const text = model.sources[expansion.file].new orelse return;
    const job = session.document orelse return;
    const rows = file.unified;
    const at = for (rows, 0..) |row, index| {
        if (row.meta and row.tail == expansion.tail and (expansion.tail or row.hunk == expansion.hunk)) break index;
    } else return;
    if (file.compact.len == 0) file.compact = rows;
    const expanded = (patch.expand(job.arena.allocator(), rows, at, text, if (expansion.all) std.math.maxInt(u32) else expand_step, expansion.from_top) catch return) orelse return;
    setRows(job.arena.allocator(), file, expanded);
    if (file.collapsed) file.collapsed = false;
    relayout(model, fx);
}
/// Shows a file whole, its changes in place, or takes it back to its hunks.
fn toggleWhole(model: *Model, fx: *Effects, index: usize) void {
    if (index >= model.files.len or index >= model.sources.len) return;
    const file = &model.files[index];
    if (file.showing_since) return notify(model, fx, "Context shows with all changes, not changes since review");
    const text = model.sources[index].new orelse return notify(model, fx, "This file has no lines to show");
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    var expanded = false;
    for (file.unified) |row| expanded = expanded or row.expanded;
    if (expanded and file.compact.len > 0) {
        setRows(alloc, file, @constCast(file.compact));
        relayout(model, fx);
        return notify(model, fx, "Showing changes only");
    }
    if (file.compact.len == 0) file.compact = file.unified;
    var rows = file.unified;
    var at: usize = 0;
    while (at < rows.len) : (at += 1) {
        if (!rows[at].meta) continue;
        if (patch.expand(alloc, rows, at, text, std.math.maxInt(u32), true) catch null) |next| {
            const tail = rows[at].tail;
            rows = next;
            // The shown lines now sit before the header (a tail is gone).
            if (tail) break;
            while (at < rows.len and !rows[at].meta) at += 1;
        }
    }
    setRows(alloc, file, rows);
    file.collapsed = false;
    relayout(model, fx);
    notify(model, fx, "Showing the whole file");
}
/// The hunk the cursor is in, if it is in one.
fn cursorHunk(model: *const Model) ?HunkRef {
    if (foldedHunk(model, model.cursor)) |at| return at;
    if (model.cursor >= model.display.len) return null;
    const entry = model.display[model.cursor];
    const code = entry.code orelse return null;
    const file = model.files[entry.file];
    if (file.showing_since or file.hunks.len == 0) return null;
    const rows = if (model.split) file.split else file.unified;
    if (code >= rows.len) return null;
    var headed = false;
    for (rows[0 .. code + 1]) |row| headed = headed or row.meta;
    if (!headed) return null;
    const hunk = rows[code].hunk;
    return if (hunk < file.hunks.len) .{ .file = entry.file, .hunk = hunk } else null;
}
/// Shows more context around the cursor's hunk: a step above and below.
fn expandAround(model: *Model, fx: *Effects) void {
    const at = cursorHunk(model) orelse return notify(model, fx, "Move into a hunk to show more around it");
    if (model.sources.len == 0) return notify(model, fx, "Still reading files");
    const file = model.files[at.file];
    var below: Expansion = .{ .file = at.file, .tail = true, .from_top = true };
    for (file.unified) |row| if (row.meta and !row.tail and row.hunk == at.hunk + 1) {
        below = .{ .file = at.file, .hunk = at.hunk + 1, .from_top = true };
    };
    expandGap(model, fx, below);
    expandGap(model, fx, .{ .file = at.file, .hunk = at.hunk });
}
/// Marks one hunk reviewed (or not). A file whose every hunk is reviewed is
/// reviewed; taking one back takes back the file's review but keeps the rest.
fn setHunkReviewed(model: *Model, fx: *Effects, at: HunkRef, value: bool) void {
    if (at.file >= model.files.len) return;
    const file = &model.files[at.file];
    if (at.hunk >= file.hunks.len or file.hunks[at.hunk].reviewed == value) return;
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    model.history.append(gpa, .{ .file = at.file, .reviewed = !value, .hunk = at.hunk }) catch {};
    const hunk = &file.hunks[at.hunk];
    hunk.reviewed = value;
    if (value) review.markHunk(alloc, &model.hunk_records, file.path, hunk.*) catch {} else review.unmarkHunk(&model.hunk_records, file.path, hunk.*);
    hunk.collapsed = value and model.collapse_reviewed;
    var all = true;
    for (file.hunks) |each| all = all and each.reviewed;
    if (all and !file.reviewed) {
        record(model, at.file, true);
        if (model.collapse_reviewed) file.collapsed = true;
    } else if (!value and file.reviewed) {
        // The others stay reviewed, on their own now.
        for (file.hunks) |each| if (each.reviewed) review.markHunk(alloc, &model.hunk_records, file.path, each) catch {};
        recordFile(model, at.file, false);
    }
    relayout(model, fx);
    persist(model);
}
/// Steps to the next (or previous) hunk not yet reviewed, across files.
fn nextUnreviewedHunk(model: *Model, fx: *Effects, forward: bool) void {
    if (model.display.len == 0) return;
    const start = model.cursor;
    var index = start;
    var steps: usize = 0;
    while (steps < model.display.len) : (steps += 1) {
        index = if (forward) (index + 1) % model.display.len else (index + model.display.len - 1) % model.display.len;
        const entry = model.display[index];
        const code = entry.code orelse continue;
        const file = model.files[entry.file];
        if (file.showing_since or file.reviewed) continue;
        const rows = if (model.split) file.split else file.unified;
        const row = rows[code];
        if (!row.meta or row.tail or row.hunk >= file.hunks.len or file.hunks[row.hunk].reviewed) continue;
        // The hunk's first line, or its header when the hunk is folded.
        moveTo(model, fx, if (file.hunks[row.hunk].collapsed) index else seekCode(model, index + 1, true) orelse continue);
        return;
    }
    notify(model, fx, "Every hunk reviewed");
}
/// The revisions the comparison's sides are read from, for questions Git
/// answers about them: "" stands for the working tree.
fn sideRevision(model: *const Model, alloc: std.mem.Allocator, old: bool) ?[]const u8 {
    const job = session.document orelse return null;
    const result = job.result orelse return null;
    if (model.imported or result.root.len == 0) return null;
    return switch (model.mode) {
        .working, .staged => if (old) "HEAD" else "",
        .branch => if (job.options.commit.len > 0)
            (if (old) std.fmt.allocPrint(alloc, "{s}^", .{job.options.commit}) catch null else job.options.commit)
        else if (old) result.merge_base else result.tip,
    };
}
fn startLookup(model: *Model, fx: *Effects, lookup_job: *Lookup) void {
    _ = model;
    if (session.lookup) |running| {
        // One question at a time: the newer one waits for the older to end.
        if (!running.done.load(.acquire)) {
            lookup_job.destroy();
            return;
        }
        running.destroy();
        session.lookup = null;
    }
    session.lookup = lookup_job;
    lookup_job.thread = std.Thread.spawn(.{}, Lookup.work, .{lookup_job}) catch null;
    if (lookup_job.thread == null) lookup_job.work();
    fx.startTimer(.{ .key = 12, .interval_ms = 16, .mode = .repeating, .on_fire = Effects.timerMsg(.lookup_tick) });
}
/// Asks who last changed a line, and shows the answer beside it.
fn blameRow(model: *Model, fx: *Effects, row: usize, old: bool) void {
    const source = sourceRow(model, row) orelse return;
    const file = model.files[model.display[row].file];
    const side_old = (old and source.old > 0) or source.new == 0;
    const line_number = if (side_old) source.old else source.new;
    if (line_number == 0 or file.message) return;
    if (session.lookup) |running| if (!running.done.load(.acquire)) return notify(model, fx, "Still looking something up");
    const job = session.document orelse return;
    const lookup_job = gpa.create(Lookup) catch return;
    lookup_job.* = .{ .kind = .blame, .io = session.io, .root = "" };
    const alloc = lookup_job.arena.allocator();
    // A reference file is read from the comparison's new side, like the
    // review's new lines.
    const revision = sideRevision(model, alloc, side_old) orelse {
        lookup_job.destroy();
        return notify(model, fx, "Blame needs a repository");
    };
    // The lookup may outlive the review it was asked from.
    lookup_job.root = alloc.dupe(u8, job.result.?.root) catch return lookup_job.destroy();
    const path = alloc.dupe(u8, if (side_old and file.previous.len > 0) file.previous else file.path) catch return lookup_job.destroy();
    var args: std.ArrayList([]const u8) = .empty;
    args.appendSlice(alloc, &.{ "blame", "--porcelain", "-L", std.fmt.allocPrint(alloc, "{d},{d}", .{ line_number, line_number }) catch return lookup_job.destroy() }) catch return lookup_job.destroy();
    // Staged lines are the index's: blame reads them as the file's contents.
    if (model.mode == .staged and !side_old) {
        const store = job.store orelse {
            lookup_job.destroy();
            return notify(model, fx, "Blame needs a repository");
        };
        lookup_job.store = .{ .objects = alloc.dupe(u8, store.objects) catch return lookup_job.destroy(), .repository = alloc.dupe(u8, store.repository) catch return lookup_job.destroy() };
        lookup_job.staged_path = path;
        args.appendSlice(alloc, &.{ "--contents", "-" }) catch return lookup_job.destroy();
    } else if (revision.len > 0) args.append(alloc, alloc.dupe(u8, revision) catch return lookup_job.destroy()) catch return lookup_job.destroy();
    args.appendSlice(alloc, &.{ "--", path }) catch return lookup_job.destroy();
    lookup_job.args = args.items;
    model.blame = .{ .row = row, .file = model.display[row].file, .old = side_old, .line = line_number };
    startLookup(model, fx, lookup_job);
}
/// Looks a name up across the repository (at the comparison's new side):
/// where it is defined, then where it is used.
fn searchSymbol(model: *Model, fx: *Effects) void {
    const query = std.mem.trim(u8, model.palette_query.text(), " ");
    if (query.len < 2) {
        if (model.symbol_hits.len > 0) gpa.free(model.symbol_hits);
        model.symbol_hits = &.{};
        matchChoices(model);
        return;
    }
    if (session.lookup) |running| if (!running.done.load(.acquire)) {
        session.lookup_again = true;
        return;
    };
    const job = session.document orelse return;
    if (model.imported or job.result.?.root.len == 0) return notify(model, fx, "Symbol search needs a repository");
    const lookup_job = gpa.create(Lookup) catch return;
    lookup_job.* = .{ .kind = .grep, .io = session.io, .root = "" };
    const alloc = lookup_job.arena.allocator();
    lookup_job.root = alloc.dupe(u8, job.result.?.root) catch return lookup_job.destroy();
    lookup_job.query = alloc.dupe(u8, query) catch return;
    var args: std.ArrayList([]const u8) = .empty;
    args.appendSlice(alloc, &.{ "grep", "-n", "-I", "-w", "-F", "--max-count=40" }) catch return;
    if (model.mode == .staged) args.append(alloc, "--cached") catch return;
    args.appendSlice(alloc, &.{ "-e", lookup_job.query }) catch return;
    if (model.mode == .branch) if (sideRevision(model, alloc, false)) |revision| if (revision.len > 0) {
        const owned = alloc.dupe(u8, revision) catch return lookup_job.destroy();
        args.append(alloc, owned) catch return lookup_job.destroy();
        lookup_job.strip = owned;
    };
    args.append(alloc, "--") catch return;
    lookup_job.args = args.items;
    model.symbol_busy = true;
    startLookup(model, fx, lookup_job);
}
/// Takes in a finished lookup's answer.
fn finishLookup(model: *Model, fx: *Effects) void {
    const lookup_job = session.lookup orelse return fx.cancelTimer(12);
    if (!lookup_job.done.load(.acquire)) return;
    fx.cancelTimer(12);
    session.lookup = null;
    defer lookup_job.destroy();
    switch (lookup_job.kind) {
        .blame => if (model.blame) |*shown| {
            gpa.free(session.blame_output);
            session.blame_output = lookup_job.output;
            shown.loading = false;
            if (lookup.parseBlame(lookup_job.output)) |info| shown.info = info else shown.failed = true;
        } else gpa.free(lookup_job.output),
        .grep => {
            model.symbol_busy = false;
            const typed = std.mem.trim(u8, model.palette_query.text(), " ");
            const again = session.lookup_again or !std.mem.eql(u8, typed, lookup_job.query);
            session.lookup_again = false;
            gpa.free(session.symbol_output);
            session.symbol_output = lookup_job.output;
            if (model.symbol_hits.len > 0) gpa.free(model.symbol_hits);
            model.symbol_hits = lookup.parseGrep(gpa, lookup_job.output, lookup_job.strip, lookup_job.query, model.choices.len) catch &.{};
            if (model.palette == .symbols) matchChoices(model);
            if (again and model.palette == .symbols) searchSymbol(model, fx);
        },
    }
}
/// Opens the symbol palette on the name the cursor's line most likely
/// means (or the selected text), and looks it up.
fn openSymbols(model: *Model, fx: *Effects, row: ?usize, old: bool) void {
    var name: []const u8 = "";
    if (model.mouse.range) |range| if (range.bytes) |bytes| if (bytes.end > bytes.start) {
        if (sourceRow(model, range.anchor)) |source| {
            const offset = if (range.old) source.old_offset else source.new_offset;
            const text = if (range.old) source.left else source.right;
            if (bytes.start >= offset and bytes.end <= offset + text.len) name = std.mem.trim(u8, text[bytes.start - offset .. bytes.end - offset], " \t");
        }
    };
    if (name.len == 0) if (row) |index| if (sourceRow(model, index)) |source| {
        const side_old = (old and source.old > 0) or source.new == 0;
        name = lookup.interestingName(if (side_old) source.left else source.right);
    };
    openPalette(model, fx, .symbols);
    model.palette_query.set(name[0..@min(name.len, 200)]);
    if (model.symbol_hits.len > 0) gpa.free(model.symbol_hits);
    model.symbol_hits = &.{};
    matchChoices(model);
    searchSymbol(model, fx);
}
/// Goes to a line of a file by path: in the review when the change has the
/// file (showing the lines around it if the diff left them out), else in a
/// reference pane opened for it, read from the comparison's new side.
fn openLocation(model: *Model, fx: *Effects, path: []const u8, line_number: u32) void {
    for (model.files, 0..) |*file, index| {
        if (file.message or !std.mem.eql(u8, file.path, path)) continue;
        if (file.collapsed) {
            file.collapsed = false;
            layoutRows(model);
        }
        revealLine(model, fx, index, line_number);
        jump(model, fx, index);
        model.cursor_old = false;
        goLine(model, fx, line_number);
        model.cursor_active = true;
        return;
    }
    const job = session.document orelse return;
    const result = job.result orelse return;
    const alloc = job.arena.allocator();
    const text = switch (model.mode) {
        .working => blk: {
            const full = std.fs.path.join(alloc, &.{ result.root, path }) catch return;
            break :blk std.Io.Dir.cwd().readFileAlloc(session.io, full, alloc, .limited(16 * 1024 * 1024)) catch return notify(model, fx, "Could not read that file");
        },
        else => blk: {
            const revision = if (model.mode == .staged) "" else sideRevision(model, alloc, false) orelse return;
            const spec = std.fmt.allocPrint(alloc, "{s}:{s}", .{ revision, path }) catch return;
            break :blk git.ask(alloc, session.io, result.root, &.{ "show", spec }) catch return notify(model, fx, "Could not read that file");
        },
    };
    if (patch.looksBinary(text)) return notify(model, fx, "That file is binary");
    const reference = patch.referenceFile(alloc, path, text) catch return;
    const files = alloc.alloc(patch.File, model.files.len + 1) catch return;
    @memcpy(files[0..model.files.len], model.files);
    files[model.files.len] = reference;
    model.files = files;
    job.files = files;
    if (gpa.alloc(Marks, files.len)) |marks| {
        @memset(marks, .{});
        @memcpy(marks[0..@min(model.marks.len, marks.len)], model.marks[0..@min(model.marks.len, marks.len)]);
        if (model.marks.len > 0) gpa.free(model.marks);
        model.marks = marks;
    } else |_| {}
    if (highlight.languageFor(path)) |language| shadeReference(fx, job, language, reference.path, text);
    reindex(model);
    layoutRows(model);
    findMatches(model);
    const index = files.len - 1;
    jump(model, fx, index);
    model.cursor_old = false;
    goLine(model, fx, line_number);
    model.cursor_active = true;
    alignCursor(model, fx);
}
/// Highlights a file opened for reference off the main thread; its lines
/// keep the line-by-line colors until then.
fn shadeReference(fx: *Effects, job: *Job, language: highlight.Language, path: []const u8, text: []const u8) void {
    const shade = gpa.create(Shade) catch return;
    shade.* = .{ .language = language, .path = path, .text = text, .stop = &job.stopping };
    job.shades.append(gpa, shade) catch {
        gpa.destroy(shade);
        return;
    };
    shade.thread = std.Thread.spawn(.{}, Shade.work, .{shade}) catch null;
    if (shade.thread == null) shade.work();
    fx.startTimer(.{ .key = 13, .interval_ms = 16, .mode = .repeating, .on_fire = Effects.timerMsg(.shade_tick) });
}
/// Takes in reference files' highlights as they finish.
fn adoptShades(model: *Model, fx: *Effects) void {
    const job = session.document orelse return fx.cancelTimer(13);
    var waiting = false;
    for (job.shades.items) |shade| {
        if (shade.adopted) continue;
        if (!shade.done.load(.acquire)) {
            waiting = true;
            continue;
        }
        shade.adopted = true;
        for (model.files, 0..) |file, index| if (file.reference and file.path.ptr == shade.path.ptr and index < model.marks.len) {
            model.marks[index].new = shade.result;
        };
    }
    if (!waiting) fx.cancelTimer(13);
}
/// Puts the cursor's line a third of the way down, with context above it.
fn alignCursor(model: *Model, fx: *Effects) void {
    requestScroll(model, fx, @as(f32, @floatFromInt(model.cursor)) * 24 - model.viewport_height / 3);
}
/// Shows the lines around a new-side line the diff left out.
fn revealLine(model: *Model, fx: *Effects, index: usize, line_number: u32) void {
    if (index >= model.sources.len) return;
    const file = &model.files[index];
    if (file.showing_since) return;
    const text = model.sources[index].new orelse return;
    for (file.unified) |row| if (row.new == line_number) return;
    for (file.unified, 0..) |row, at| {
        if (!row.meta) continue;
        const gap = patch.gapAt(file.unified, at, text.count()) orelse continue;
        if (line_number < gap.first or line_number > gap.last) continue;
        expandGap(model, fx, .{ .file = index, .hunk = row.hunk, .tail = row.tail, .from_top = true, .all = true });
        return;
    }
}
/// Reads a Git comparison again under new diff options, returning the
/// reader to the file they were on. An imported patch is shown as written.
fn rediff(model: *Model, fx: *Effects) void {
    if (model.imported) return;
    if (session.keep == null and model.selected < model.files.len) session.keep = gpa.dupe(u8, model.files[model.selected].path) catch null;
    load(model, fx);
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
/// The commit under review on its own, or "" for the whole comparison.
pub fn currentCommit(model: *const Model) []const u8 {
    const index = model.commit orelse return "";
    return if (index < model.commits.len) model.commits[index].id else "";
}
/// Whether a note belongs to what is shown (not to a commit a rewrite dropped).
pub fn inView(model: *const Model, note: Note) bool {
    return std.mem.eql(u8, note.commit, currentCommit(model));
}
/// A commit's short id and subject, from the branch or from what Patch kept.
fn commitTitle(model: *const Model, id: []const u8, buffer: []u8) []const u8 {
    const short = id[0..@min(id.len, 7)];
    for (model.commits) |commit| if (std.mem.eql(u8, commit.id, id)) return std.fmt.bufPrint(buffer, "`{s}` {s}", .{ short, commit.subject() }) catch short;
    if (session.document) |job| for (job.marks.items) |mark| if (std.mem.eql(u8, mark.id, id)) return std.fmt.bufPrint(buffer, "`{s}` {s} (no longer on the branch)", .{ short, mark.subject }) catch short;
    return std.fmt.bufPrint(buffer, "`{s}`", .{short}) catch short;
}
fn exportNote(writer: *std.Io.Writer, note: Note, level: []const u8) !void {
    try writer.print("\n{s} `{s}`", .{ level, note.path });
    if (note.line > 0) {
        try writer.print(":{d}", .{note.line});
        if (note.line_end > note.line) try writer.print("–{d}", .{note.line_end});
        try writer.print(" ({s})", .{if (note.old) "old" else "new"});
    }
    if (note.state == .outdated) try writer.writeAll(" · outdated");
    try writer.writeAll("\n\n");
    // An outdated note quotes the lines it was left on, since they changed.
    if (note.state == .outdated and note.excerpt.len > 0) {
        var lines = std.mem.splitScalar(u8, note.excerpt, '\n');
        while (lines.next()) |line| try writer.print("> {s}\n", .{line});
        try writer.writeAll("\n");
    }
    try writer.print("{s}\n", .{note.text});
}
/// The review as Markdown: the files and their state, then the open and
/// outdated notes (resolved ones are done), a branch's grouped by commit.
fn exportMarkdown(alloc: std.mem.Allocator, model: *const Model) ![]const u8 {
    var output: std.Io.Writer.Allocating = .init(alloc);
    const writer = &output.writer;
    var title: [256]u8 = undefined;
    try writer.print("# Review: {s}\n\n{s} · {s}\n", .{ model.repository, @tagName(model.mode), model.branch });
    if (model.commit != null) try writer.print("\nCommit {s}\n", .{commitTitle(model, currentCommit(model), &title)});
    try writer.writeAll("\n");
    for (model.files) |file| {
        if (file.reference) continue;
        const state = if (!file.reviewed and (file.prior == .changed or file.prior == .base)) " · changed since review" else "";
        try writer.print("- [{s}] `{s}` (+{d} −{d}){s}\n", .{ if (file.reviewed) "x" else " ", file.path, file.additions, file.deletions, state });
    }
    for (model.notes.items) |note| if (note.state != .resolved and inView(model, note)) try exportNote(writer, note, "##");
    // Notes on other commits of the branch, each commit under its own heading.
    var commits: std.ArrayList([]const u8) = .empty;
    defer commits.deinit(alloc);
    const others = if (session.document) |job| job.hidden.items else &.{};
    for ([_][]const Note{ model.notes.items, others }) |group| for (group) |note| {
        if (inView(model, note) or note.state == .resolved or note.scope.len == 0) continue;
        if (session.document) |job| if (!std.mem.eql(u8, note.scope, job.scope)) continue;
        const seen = for (commits.items) |id| {
            if (std.mem.eql(u8, id, note.commit)) break true;
        } else false;
        if (!seen) try commits.append(alloc, note.commit);
    };
    for (commits.items) |id| {
        try writer.print("\n## {s}\n", .{if (id.len == 0) "All changes" else commitTitle(model, id, &title)});
        for ([_][]const Note{ model.notes.items, others }) |group| for (group) |note| {
            if (note.state == .resolved or !std.mem.eql(u8, note.commit, id) or inView(model, note)) continue;
            if (session.document) |job| if (!std.mem.eql(u8, note.scope, job.scope)) continue;
            try exportNote(writer, note, "###");
        };
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
            model.canvas_height = size.height;
            model.viewport_height = @max(100, listHeight(model));
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
            model.commit = null;
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
            if (!inView(model, note)) return;
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
        .toggle_generated_setting => {
            model.fold_generated = !model.fold_generated;
            saveSettings(model);
        },
        .toggle_whitespace => if (!model.busy) {
            model.ignore_whitespace = !model.ignore_whitespace;
            saveSettings(model);
            rediff(model, fx);
            notify(model, fx, if (model.imported) "Imported patches show whitespace as written" else if (model.ignore_whitespace) "Ignoring whitespace" else "Showing whitespace");
        },
        .set_algorithm => |algorithm| if (!model.busy and model.algorithm != algorithm) {
            model.algorithm = algorithm;
            saveSettings(model);
            rediff(model, fx);
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
        .toggle_since => {
            if (!model.since_review and changedSince(model) == 0) return notify(model, fx, "Nothing changed since your review");
            const file = if (model.selected < model.files.len) model.files[model.selected].path else "";
            showSince(model, !model.since_review);
            layoutRows(model);
            findMatches(model);
            clearSelection(model);
            model.cursor_active = false;
            // Stay on the file being read; else start at the first that changed.
            var target: ?usize = null;
            for (model.files, 0..) |each, index| if (std.mem.eql(u8, each.path, file) and !each.collapsed) {
                target = index;
            };
            if (target == null) for (model.files, 0..) |each, index| if (!each.collapsed) {
                target = index;
                break;
            };
            jump(model, fx, target orelse 0);
            notify(model, fx, if (model.since_review) "Showing changes since review" else "Showing all changes");
        },
        .select_commit => |choice| if (!model.busy) {
            model.commit_menu = false;
            const next = if (choice) |index| (if (index < model.commits.len) index else return) else null;
            if (std.meta.eql(next, model.commit)) return;
            model.commit = next;
            load(model, fx);
        },
        .toggle_commit_menu => {
            model.commit_menu = !model.commit_menu;
            model.commit_offset = 0;
        },
        .close_commit_menu => model.commit_menu = false,
        .commit_menu_scrolled => |scroll| model.commit_offset = scroll.offset_y,
        .resolve_note, .reopen_note => |index| if (index < model.notes.items.len) {
            model.notes.items[index].state = if (msg == .resolve_note) .resolved else .open;
            persist(model);
        },
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
        .comment_selection => commentSelection(model, fx),
        .copy_selection => copySelection(model, fx),
        .line_press => |anchor| {
            if (!model.mouse.active) beginNote(model, fx, anchor.file orelse model.selected, anchor);
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
            if (model.palette == .symbols) searchSymbol(model, fx);
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
            model.commit = null;
            if (mode == .branch) openBranchPicker(model, .base) else {
                model.base_popover = false;
            }
            session.imported = null;
            load(model, fx);
        },
        .poll => |timer| if (timer.outcome == .fired) {
            poll(model, fx);
        },
        .keeper_tick => |timer| if (timer.outcome == .fired) {
            const job = session.document orelse return fx.cancelTimer(10);
            if (!job.keeper_done.load(.acquire)) return;
            fx.cancelTimer(10);
            if (job.keeper_stale.swap(false, .acq_rel)) notify(model, fx, "Files changed while loading · ⌘R reads them again");
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
        .note_file => |index| beginNote(model, fx, index, .{}),
        .reviewed_hunk => |at| if (at.file < model.files.len and at.hunk < model.files[at.file].hunks.len) {
            setHunkReviewed(model, fx, at, !model.files[at.file].hunks[at.hunk].reviewed);
        },
        .collapse_hunk => |at| if (at.file < model.files.len and at.hunk < model.files[at.file].hunks.len) {
            const hunk = &model.files[at.file].hunks[at.hunk];
            hunk.collapsed = !hunk.collapsed;
            relayout(model, fx);
        },
        .expand => |expansion| expandGap(model, fx, expansion),
        .blame_line => |hit| blameRow(model, fx, hit.row, hit.old),
        .find_symbol_at => |hit| openSymbols(model, fx, hit.row, hit.old),
        .close_blame => model.blame = null,
        .copy_text => |text| fx.writeClipboard(.{ .key = 3, .text = text, .on_result = Effects.clipboardMsg(.clipboard_result) }),
        .close_reference => |index| if (index < model.files.len and model.files[index].reference) {
            const job = session.document orelse return;
            const files = job.arena.allocator().alloc(patch.File, model.files.len - 1) catch return;
            @memcpy(files[0..index], model.files[0..index]);
            @memcpy(files[index..], model.files[index + 1 ..]);
            model.files = files;
            job.files = files;
            if (model.blame) |*shown| {
                if (shown.file == index) model.blame = null else if (shown.file > index) shown.file -= 1;
            }
            if (index < model.marks.len) if (gpa.alloc(Marks, model.marks.len - 1)) |marks| {
                @memcpy(marks[0..index], model.marks[0..index]);
                @memcpy(marks[index..], model.marks[index + 1 ..]);
                gpa.free(model.marks);
                model.marks = marks;
            } else |_| {};
            model.selected = @min(model.selected, files.len -| 1);
            reindex(model);
            layoutRows(model);
            findMatches(model);
            model.cursor = @min(model.cursor, model.display.len -| 1);
        },
        .lookup_tick => |timer| if (timer.outcome == .fired) finishLookup(model, fx),
        .shade_tick => |timer| if (timer.outcome == .fired) adoptShades(model, fx),
        .goto_move => |target| if (target.move > 0 and target.move <= model.moves.len) {
            const move = model.moves[target.move - 1];
            const index: usize = if (target.to) move.to_file else move.from_file;
            if (index >= model.files.len) return;
            if (model.files[index].collapsed) update(model, .{ .collapse_file = index }, fx);
            jump(model, fx, index);
            model.cursor_old = !target.to;
            goLine(model, fx, if (target.to) move.to_line else move.from_line);
        },
        .sources_tick => |timer| if (timer.outcome == .fired) {
            const job = session.document orelse return fx.cancelTimer(11);
            if (job.sources_done.load(.acquire)) adoptSources(model, fx);
        },
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
            beginNote(model, fx, anchor.file orelse model.selected, anchor);
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
            const alloc = job.arena.allocator();
            const file = model.files[model.draft_file];
            const old = model.anchor.old and model.anchor.line > 0;
            // Anchored to the version of its side, with the lines as they read,
            // so it can follow them as the file changes.
            var note = Note{ .path = file.path, .line = model.anchor.line, .line_end = model.anchor.line_end, .old = old, .text = bytes, .blob = if (old) file.old_blob else file.new_blob, .excerpt = review.excerpt(alloc, file.fullRows(), old, model.anchor.line, model.anchor.line_end), .scope = job.scope, .commit = job.options.commit };
            if (model.edit_index) |index| {
                const previous = model.notes.items[index];
                // Editing keeps where the note was left and what it was left on.
                note = previous;
                note.text = bytes;
            }
            if (model.edit_index) |index| model.notes.items[index] = note else model.notes.append(alloc, note) catch return;
            if (model.commit) |index| if (index < model.commits.len) markCommit(model, index, null);
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
    // Types, which the stock syntax tokens have no slot for, borrow `info`.
    tokens.colors.info = theme.syntax_type;
    return tokens;
}
pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(gpa);
    if (args.len >= 3 and std.mem.eql(u8, args[1], "--inspect-repository")) {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const mode = if (args.len > 3) std.meta.stringToEnum(git.Mode, args[3]) orelse return error.InvalidMode else .working;
        const inspected = try git.read(arena.allocator(), init.io, args[2], mode, if (args.len > 4) args[4] else "main", if (args.len > 5) args[5] else "", .{});
        const bytes = try std.json.Stringify.valueAlloc(arena.allocator(), inspected, .{});
        try std.Io.File.stdout().writeStreamingAll(init.io, bytes);
        return;
    }
    var dir_buf: [4096]u8 = undefined;
    const dir = init.environ_map.get("PATCH_STATE_DIR") orelse try sdk.app_dirs.resolveOne(.{ .name = "computer.patch.app" }, sdk.app_dirs.currentPlatform(), .{ .home = init.environ_map.get("HOME"), .xdg_data_home = init.environ_map.get("XDG_DATA_HOME") }, .data, &dir_buf);
    try std.Io.Dir.cwd().createDirPath(init.io, dir);
    session = .{ .io = init.io, .data_dir = try gpa.dupe(u8, dir), .measure_startup = init.environ_map.contains("NATIVE_SDK_WINDOW_TIMING") };
    // Git runs in the repository, so the attributes file needs an absolute path.
    const absolute_dir = std.Io.Dir.cwd().realPathFileAlloc(init.io, dir, gpa) catch try gpa.dupe(u8, dir);
    session.attributes_path = try std.fmt.allocPrint(gpa, "{s}/gitattributes", .{absolute_dir});
    session.data_abs = absolute_dir;
    git.environ = init.environ_map;
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
    _ = syntax;
    _ = review;
    _ = history;
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
/// A folded hunk's header, where the cursor rests to reach the hunk.
pub fn foldedHunk(model: *const Model, index: usize) ?HunkRef {
    if (index >= model.display.len) return null;
    const entry = model.display[index];
    const code = entry.code orelse return null;
    const file = model.files[entry.file];
    if (file.showing_since) return null;
    const rows = if (model.split) file.split else file.unified;
    if (code >= rows.len) return null;
    const row = rows[code];
    if (!row.meta or row.tail or row.hunk >= file.hunks.len or !file.hunks[row.hunk].collapsed) return null;
    return .{ .file = entry.file, .hunk = row.hunk };
}
fn seekCode(model: *const Model, start: usize, forward: bool) ?usize {
    if (model.display.len == 0) return null;
    var index = @min(start, model.display.len - 1);
    while (true) {
        if (sourceRow(model, index) != null or foldedHunk(model, index) != null) return index;
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
    if (!model.cursor_active or (sourceRow(model, model.cursor) == null and !onFoldedHeader(model) and foldedHunk(model, model.cursor) == null)) model.cursor = seekCode(model, model.starts[model.selected], true) orelse return false;
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
    if (sourceRow(model, index) == null and foldedHunk(model, index) == null) return;
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
    // The old side of the changes since review is the reviewed version, where no note counts lines.
    if (old and model.files[file].showing_since) return false;
    const path = model.files[file].path;
    for (model.notes.items) |note| {
        if (note.line == 0 or note.old != old or note.state == .resolved or !std.mem.eql(u8, note.path, path) or !inView(model, note)) continue;
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
    const old = if (file.oneSided()) file.status == .deleted else model.cursor_old;
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
/// Rebuilds the rows after files fold or unfold, keeping the reader on `index`
/// and the view still: that file's header stays where it is on screen, and
/// what follows it closes up beneath (or opens out) rather than the review
/// scrolling. A header scrolled past (folded from its pinned pill) lands at
/// the top, where the pill was.
fn refold(model: *Model, fx: *Effects, index: usize) void {
    const file = @min(index, model.files.len -| 1);
    const before = if (file < model.starts.len) @as(f32, @floatFromInt(model.starts[file])) * 24 - model.scroll_offset else 0;
    const screen = std.math.clamp(before, 0, @max(0, model.viewport_height - 24));
    layoutRows(model);
    findMatches(model);
    clearSelection(model);
    if (file >= model.files.len) {
        model.cursor = 0;
        return;
    }
    model.selected = file;
    // A folded file keeps the reader: the cursor parks on its header.
    model.cursor = if (model.files[file].collapsed) model.starts[file] else seekCode(model, model.starts[file], true) orelse model.starts[file];
    if (model.focus != .review) focusReview(model);
    requestScroll(model, fx, @as(f32, @floatFromInt(model.starts[file])) * 24 - screen);
}
fn setReviewed(model: *Model, index: usize, value: bool) void {
    if (index >= model.files.len or model.files[index].reviewed == value or model.files[index].reference) return;
    var hunks: []bool = &.{};
    if (session.document) |job| if (job.arena.allocator().alloc(bool, model.files[index].hunks.len)) |states| {
        for (model.files[index].hunks, states) |hunk, *state| state.* = hunk.reviewed;
        hunks = states;
    } else |_| {};
    model.history.append(gpa, .{ .file = index, .reviewed = model.files[index].reviewed, .hunks = hunks }) catch {};
    record(model, index, value);
}
/// Gives back the hunks reviewed on their own before a file's review that
/// undoing it took back.
fn restoreHunks(model: *Model, change: ReviewChange) void {
    const job = session.document orelse return;
    const file = &model.files[change.file];
    if (change.reviewed or file.showing_since or change.hunks.len != file.hunks.len) return;
    for (file.hunks, change.hunks) |*hunk, was| if (was and !hunk.reviewed) {
        hunk.reviewed = true;
        hunk.collapsed = model.collapse_reviewed;
        review.markHunk(job.arena.allocator(), &model.hunk_records, file.path, hunk.*) catch {};
    };
}
/// Marks a file's change reviewed (or not), and every hunk of it with it.
fn record(model: *Model, index: usize, value: bool) void {
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    const file = &model.files[index];
    if (!file.showing_since) for (file.hunks) |*hunk| {
        hunk.reviewed = value;
        hunk.collapsed = value and model.collapse_reviewed;
        if (value) review.markHunk(alloc, &model.hunk_records, file.path, hunk.*) catch {} else review.unmarkHunk(&model.hunk_records, file.path, hunk.*);
    };
    recordFile(model, index, value);
}
/// Marks a file's change reviewed (or not) in the records, which say so for
/// any comparison that shows the same change, and in the commit's progress.
fn recordFile(model: *Model, index: usize, value: bool) void {
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    const file = &model.files[index];
    file.reviewed = value;
    if (value) {
        review.mark(alloc, &model.records, file.*) catch {};
        file.prior = .same;
    } else {
        review.unmark(&model.records, file.*);
        file.prior = review.classify(model.records.items, file.*);
        if (file.prior == .changed) if (review.latest(model.records.items, file.path)) |latest| {
            if (std.mem.eql(u8, latest.new, file.new_blob)) file.prior = .base;
        };
    }
    const commit_index = model.commit orelse return;
    if (commit_index >= model.commits.len or commit_index >= model.commit_states.len) return;
    var done: usize = 0;
    for (model.files) |each| done += @intFromBool(each.reviewed);
    const state: history.CommitState = if (done == model.files.len) .reviewed else if (done > 0) .partial else .new;
    model.commit_states[commit_index] = state;
    markCommit(model, commit_index, state == .reviewed);
}
/// Remembers a commit (to find it after a rewrite) and whether it was reviewed.
fn markCommit(model: *Model, index: usize, reviewed: ?bool) void {
    const job = session.document orelse return;
    const alloc = job.arena.allocator();
    const commit = model.commits[index];
    const message = alloc.dupe(u8, &patch.blobId(commit.message)) catch "";
    for (job.marks.items) |*mark| if (std.mem.eql(u8, mark.id, commit.id)) {
        if (reviewed) |value| mark.reviewed = value;
        mark.message = message;
        return;
    };
    job.marks.append(alloc, .{ .id = commit.id, .subject = commit.subject(), .time = commit.time, .reviewed = reviewed orelse false, .message = message }) catch {};
}
fn nextUnreviewed(model: *Model, fx: *Effects, forward: bool, count: usize) void {
    if (model.files.len == 0) return;
    var target = model.selected;
    var moved = false;
    for (0..count) |_| {
        var found = false;
        for (1..model.files.len + 1) |offset| {
            const index = if (forward) (target + offset) % model.files.len else (target + model.files.len - offset) % model.files.len;
            if (!model.files[index].reviewed and !model.files[index].reference) {
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
    if (model.palette == .symbols) {
        for (model.symbol_hits, 0..) |_, index| {
            if (index == model.choices.len) break;
            model.choices[index] = .{ .index = index, .score = @intCast(index) };
            model.choice_count = index + 1;
        }
        return;
    }
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
    const symbols = model.palette == .symbols;
    model.palette = .closed;
    focusReview(model);
    if (symbols) {
        if (index < model.symbol_hits.len) openLocation(model, fx, model.symbol_hits[index].path, model.symbol_hits[index].line);
    } else if (choice.file) {
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
            model.blame = null;
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
                if (change.hunk) |hunk| {
                    // Undoing is not itself undone.
                    const kept = model.history.items.len;
                    setHunkReviewed(model, fx, .{ .file = change.file, .hunk = hunk }, change.reviewed);
                    model.history.shrinkRetainingCapacity(@min(kept, model.history.items.len));
                    continue;
                }
                if (change.file < model.files.len) {
                    record(model, change.file, change.reviewed);
                    restoreHunks(model, change);
                    if (model.collapse_reviewed) model.files[change.file].collapsed = change.reviewed;
                    refold(model, fx, change.file);
                    model.cursor_active = true;
                }
            }
            persist(model);
        },
        .comment_line => {
            if (model.mouse.active) {
                commentSelection(model, fx);
                return;
            }
            if (!ensureCursor(model)) return;
            const row = sourceRow(model, model.cursor) orelse return;
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
        .whitespace => update(model, .toggle_whitespace, fx),
        .since_review => update(model, .toggle_since, fx),
        .commit_next, .commit_previous => {
            if (model.mode != .branch or model.imported or model.commits.len == 0) return notify(model, fx, "Commits are listed when reviewing a branch");
            // The whole branch sits before its first commit and after its last.
            const slots = model.commits.len + 1;
            const at = if (model.commit) |index| index + 1 else 0;
            const step = count % slots;
            const next = if (invocation.action == .commit_next) (at + step) % slots else (at + slots - step) % slots;
            update(model, .{ .select_commit = if (next == 0) null else next - 1 }, fx);
        },
        .all_changes => update(model, .{ .select_commit = null }, fx),
        .expand_context => expandAround(model, fx),
        .whole_file => if (model.selected < model.files.len) toggleWhole(model, fx, model.selected),
        .hunk_reviewed, .hunk_review_next => {
            if (!ensureCursor(model)) return;
            const at = cursorHunk(model) orelse return notify(model, fx, "Move into a hunk to review it on its own");
            const file = model.files[at.file];
            if (invocation.action == .hunk_reviewed) setHunkReviewed(model, fx, at, !file.hunks[at.hunk].reviewed) else {
                setHunkReviewed(model, fx, at, true);
                nextUnreviewedHunk(model, fx, true);
            }
        },
        .hunk_next, .hunk_previous => nextUnreviewedHunk(model, fx, invocation.action == .hunk_next),
        .blame => {
            if (!ensureCursor(model)) return;
            blameRow(model, fx, model.cursor, model.cursor_old);
        },
        .find_symbol => {
            if (model.palette == .symbols) {
                model.palette = .closed;
                focusReview(model);
                return;
            }
            openSymbols(model, fx, if (ensureCursor(model)) model.cursor else null, model.cursor_old);
        },
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
    model.commit = null;
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
fn beginNote(model: *Model, fx: *Effects, file: usize, anchor: Anchor) void {
    if (file >= model.files.len) return;
    // Lines on the old side of the changes since review are the reviewed
    // version's, which no later review shows; notes go on the new side.
    if (anchor.old and anchor.line > 0 and model.files[file].showing_since) {
        notify(model, fx, "Notes go on the new side while showing changes since review");
        return;
    }
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
    // The edge pills take their own clicks; nothing under them is picked.
    if (!model.mouse.dragging and pinnedFile(model, model.scroll_offset) != null and y < top + pill_height) return null;
    if (!model.mouse.dragging and bottomPill(model, model.scroll_offset, model.viewport_height) and y >= bottom - pill_height) return null;
    var index = @min(model.display.len - 1, @as(usize, @intFromFloat(@max(0, std.math.clamp(y, top, bottom - 1) - top + model.scroll_offset) / 24)));
    var old = x < left + (right - left) / 2;
    if (model.mouse.dragging) if (model.mouse.range) |range| {
        const first = model.starts[range.file];
        const last = if (range.file + 1 < model.starts.len) model.starts[range.file + 1] - 1 else model.display.len - 1;
        index = std.math.clamp(index, first, last);
        old = range.old;
    };
    const file = model.files[model.display[index].file];
    if (!model.split or file.oneSided()) {
        if (!model.mouse.dragging) old = (file.oneSided() and file.status == .deleted) or (sourceRow(model, index) != null and sourceRow(model, index).?.new == 0);
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
fn commentSelection(model: *Model, fx: *Effects) void {
    const range = model.mouse.range orelse return;
    beginNote(model, fx, range.file, .{ .file = range.file, .old = range.old, .line = range.first_line, .line_end = range.last_line });
    model.mouse.active = false;
    model.mouse.dragging = false;
}
fn copySelection(model: *Model, fx: *Effects) void {
    const range = model.mouse.range orelse return;
    const text = selection.copy(gpa, model.files[range.file], range) catch return;
    defer gpa.free(text);
    fx.writeClipboard(.{ .key = 3, .text = text, .on_result = Effects.clipboardMsg(.clipboard_result) });
}

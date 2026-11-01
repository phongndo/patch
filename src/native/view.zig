//! Every surface drawn with Native SDK canvas widgets, including the
//! windowed file and diff lists that build only what is visible.

const std = @import("std");
const canvas = @import("native_sdk").canvas;
const app = @import("../main.zig");
const patch = @import("patch.zig");
const syntax = @import("syntax.zig");
const AppUi = app.AppUi;
const Model = app.Model;
const Msg = app.Msg;
const theme = @import("theme.zig");
const spell = app.keyboard.label;

fn space(ui: *AppUi, width: f32, height: f32) AppUi.Node {
    return ui.el(.row, .{ .width = width, .height = height, .padding = 0 }, .{});
}
fn line(ui: *AppUi, vertical: bool) AppUi.Node {
    return ui.el(.row, .{ .width = if (vertical) 1 else 0, .height = if (vertical) 0 else 1, .padding = 0, .style = .{ .background = theme.split_rule } }, .{});
}
fn smallText(ui: *AppUi, text: []const u8, color: canvas.Color) AppUi.Node {
    return ui.text(.{ .size = .sm, .style = .{ .foreground = color } }, text);
}
fn tinted(ui: *AppUi, key: []const u8, name: []const u8, label: []const u8, msg: Msg, color: canvas.Color, disabled: bool, size: f32) AppUi.Node {
    return ui.stack(.{ .key = .{ .str = key }, .width = size, .height = size, .padding = 0 }, .{
        ui.button(.{ .key = .{ .str = "button" }, .icon = ui.fmt("app:{s}", .{name}), .semantics = .{ .label = label }, .width = size, .height = size, .size = .icon, .variant = .ghost, .on_press = msg, .disabled = disabled, .style = .{ .foreground = color, .background = theme.clear, .radius = 6 } }, ""),
        ui.el(.tooltip, .{ .text = label, .anchor = .below, .anchor_alignment = .end, .tooltip_delay = 600, .size = .sm }, .{}),
    });
}
fn iconButton(ui: *AppUi, key: []const u8, name: []const u8, label: []const u8, msg: Msg, selected: bool, disabled: bool) AppUi.Node {
    return tinted(ui, key, name, label, msg, if (selected) theme.green else theme.muted, disabled, 28);
}
/// Rex's pane controls: small, quiet icons that sit in the pane's own header.
fn paneControl(ui: *AppUi, key: []const u8, name: []const u8, label: []const u8, msg: Msg, selected: bool, disabled: bool) AppUi.Node {
    return tinted(ui, key, name, label, msg, if (selected) theme.sidebar_ink else theme.tertiary, disabled, 24);
}
/// One segment of the scope capsule, the active one on a raised capsule.
/// `fill` shares the capsule's remaining room; otherwise it hugs its words.
/// One segment of the comparison control, over the highlight that slides
/// between them (`scopeBar`), so it draws only its word. It stays as it is
/// while a review loads (a press then does nothing) rather than greying out
/// under the highlight on every switch.
fn segment(ui: *AppUi, label: []const u8, text: []const u8, msg: Msg, active: bool, width: ?f32) AppUi.Node {
    return ui.button(.{ .width = width orelse 0, .grow = if (width == null) 1 else 0, .height = 24, .size = .sm, .variant = .ghost, .on_press = msg, .semantics = .{ .label = label }, .style = .{ .foreground = if (active) theme.ink else theme.sidebar_ink, .background = theme.clear, .border = theme.clear, .radius = 12, .quiet_hover = true } }, text);
}
/// A full-width capsule field that shares the file rows' icon column.
fn capsuleField(ui: *AppUi, icon: []const u8, field: AppUi.Node) AppUi.Node {
    return ui.row(.{ .grow = 1, .height = 28, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, theme.rail_left, 0),
        ui.row(.{ .grow = 1, .height = 28, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.field, .radius = 14 } }, .{
            space(ui, 12.5, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.tertiary } }, icon),
            // The field insets its own text; this lands it on the rows' label column.
            space(ui, 1, 0),
            field,
            space(ui, 10, 0),
        }),
        space(ui, theme.rail_right, 0),
    });
}
/// The review's view controls sit as Rex's do: the rail toggle beside the
/// traffic lights, the rest right-aligned to the rail's edge (the last one
/// 15.5 points in from where the pane begins), all 28-point controls on a
/// 30-point pitch. They follow the rail's width, not whether it is open, so
/// nothing moves when it opens or closes. What no longer fits folds into "…".
const band_toggle_right: f32 = 120;
fn bandRight(model: *const Model) f32 {
    return model.sidebar_width + theme.pane_inset - 15.5;
}
fn bandFits(model: *const Model) usize {
    const room = bandRight(model) - band_toggle_right - 2;
    return @intFromFloat(@max(0, @floor((room + 2) / 30)));
}
/// The right-aligned group's width: 28 points a control, 2 between.
fn bandWidth(model: *const Model) f32 {
    const fits = bandFits(model);
    const overflow = fits < 3;
    const count: f32 = @floatFromInt((if (overflow) fits -| 1 else 3) + @as(usize, if (overflow) 1 else 0));
    return @max(0, count * 30 - 2);
}
fn bandIcons(ui: *AppUi, model: *const Model) AppUi.Node {
    const Control = struct { key: []const u8, icon: []const u8, label: []const u8, title: []const u8, msg: Msg, color: canvas.Color, disabled: bool };
    const controls = [_]Control{
        .{ .key = "split", .icon = if (model.split) "columns" else "rows", .label = if (model.split) "Switch to unified diff" else "Switch to split diff", .title = if (model.split) "Unified Diff" else "Split Diff", .msg = .toggle_split, .color = theme.sidebar_ink, .disabled = model.files.len == 0 },
        .{ .key = "notes", .icon = "note", .label = "Notes", .title = if (model.notes_open) "Hide Notes" else "Show Notes", .msg = .toggle_notes, .color = if (model.notes_open) theme.ink else theme.sidebar_ink, .disabled = model.files.len == 0 },
        .{ .key = "commands", .icon = "command", .label = spell("Commands · ⌘K"), .title = "Command Palette", .msg = .{ .action = .{ .action = .commands } }, .color = theme.sidebar_ink, .disabled = false },
    };
    const fits = bandFits(model);
    const shown = if (fits >= controls.len) controls.len else fits -| 1;
    var nodes: [controls.len + 3]AppUi.Node = undefined;
    var count: usize = 0;
    for (controls[0..shown]) |control| {
        nodes[count] = tinted(ui, control.key, control.icon, control.label, control.msg, if (control.disabled) theme.tertiary else control.color, false, 28);
        count += 1;
    }
    if (shown < controls.len) {
        var items: [controls.len]AppUi.Node = undefined;
        for (controls[shown..], 0..) |control, index| {
            items[index] = ui.el(.menu_item, .{ .text = control.title, .icon = ui.fmt("app:{s}", .{control.icon}), .height = 30, .on_press = control.msg, .disabled = control.disabled }, .{});
        }
        nodes[count] = ui.stack(.{ .key = .{ .str = "more" }, .width = 28, .height = 28, .padding = 0 }, .{
            tinted(ui, "more", "more", "More", .toggle_band_menu, if (model.band_menu) theme.ink else theme.sidebar_ink, false, 28),
            if (model.band_menu) ui.el(.dropdown_menu, .{ .width = 200, .anchor = .below, .anchor_alignment = .start, .anchor_offset = 4, .padding = 5, .gap = 0, .on_dismiss = .close_band_menu, .style = .{ .background = theme.menu, .border = theme.glass_edge, .radius = 12 } }, ui.arena.dupe(AppUi.Node, items[0 .. controls.len - shown]) catch &.{}) else ui.spacer(0),
        });
        count += 1;
    }
    return ui.row(.{ .height = 28, .padding = 0, .gap = 2, .cross = .center }, ui.arena.dupe(AppUi.Node, nodes[0..count]) catch &.{});
}
/// Files the change touches, leaving out those opened for reference; when
/// browsing, the project's files.
fn changedFiles(model: *const Model) usize {
    var count: usize = 0;
    for (model.files) |file| count += @intFromBool(!file.reference or file.listed);
    return count;
}
/// Browsing every file of the project rather than reviewing a change.
fn browsing(model: *const Model) bool {
    return model.mode == .files and !model.imported;
}
fn band(ui: *AppUi) AppUi.Node {
    return ui.row(.{ .height = theme.band_height, .padding = 0, .gap = 0, .window_drag = true }, .{});
}
/// The title band floats above both panes at fixed window coordinates: the
/// controls beside the traffic lights and the review's title where the pane
/// begins. Panes slide underneath when the rail opens or closes; nothing here moves.
fn headerLayer(ui: *AppUi, model: *const Model) AppUi.Node {
    var totals: struct { additions: u32 = 0, deletions: u32 = 0 } = .{};
    for (model.files) |file| {
        totals.additions += file.additions;
        totals.deletions += file.deletions;
    }
    // With the rail open the controls sit at its edge and the title where the
    // panes begin; as the rail eases shut they ease back beside the toggle, so
    // nothing is left stranded mid-band. At the default width both are the
    // same place; the rail toggle itself never moves.
    const open_t = if (model.sidebar_width > 0) std.math.clamp(model.rail_shown / model.sidebar_width, 0, 1) else 0;
    const group_open = @max(band_toggle_right + 2, bandRight(model) - bandWidth(model));
    const group_closed = band_toggle_right + 3.5; // where the group sits at the default width
    const group_left = group_closed + (group_open - group_closed) * open_t;
    const title_open = model.sidebar_width + theme.pane_inset + 12;
    const title_closed = @max(theme.sidebar_width + 12, group_closed + bandWidth(model) + 25);
    const title_x = @max(group_left + bandWidth(model) + 8, title_closed + (title_open - title_closed) * open_t);
    const reserved = (if (model.notes_open) model.notes_width + theme.pane_inset else 0) + 150;
    return ui.column(.{ .padding = 0, .gap = 0, .cross = .start }, .{
        ui.row(.{ .height = 50, .padding = 0, .gap = 0, .cross = .center }, .{
            space(ui, 92, 0),
            tinted(ui, "sidebar", "sidebar", if (model.sidebar) spell("Hide file rail · ⌘B") else spell("Show file rail · ⌘B"), .toggle_sidebar, theme.sidebar_ink, false, 28),
            space(ui, group_left - band_toggle_right, 0),
            bandIcons(ui, model),
            space(ui, @max(0, title_x - group_left - bandWidth(model)), 0),
            ui.row(.{ .width = @max(0, model.canvas_width - title_x - reserved), .height = 24, .padding = 0, .gap = 0, .cross = .center }, .{
                ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.sidebar_ink } }, if (model.imported) "document" else if (browsing(model)) "folder" else "branch"),
                space(ui, 8, 0),
                ui.text(.{ .style = .{ .foreground = if (model.active) theme.ink else theme.inactive_ink } }, reviewTitle(ui, model)),
                space(ui, 8, 0),
                ui.text(.{ .style = .{ .foreground = theme.tertiary } }, if (changedFiles(model) == 1) "1 file" else ui.fmt("{d} files", .{changedFiles(model)})),
                space(ui, 10, 0),
                if (model.files.len > 0 and !browsing(model)) smallText(ui, ui.fmt("+{d}", .{totals.additions}), theme.green) else ui.spacer(0),
                space(ui, 4, 0),
                if (model.files.len > 0 and !browsing(model)) smallText(ui, ui.fmt("−{d}", .{totals.deletions}), theme.red) else ui.spacer(0),
            }),
        }),
    });
}
/// What is under review, at the top of the rail with its reload. Beside the
/// repository's name, quietly, its checked-out branch; when reviewing a
/// branch (whose name the comparison control already gives) that place
/// picks the commits instead: all of them, or one.
fn repositoryRow(ui: *AppUi, model: *const Model) AppUi.Node {
    const name = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = model.repository, .weight = .medium }}) catch &.{};
    const commits = model.mode == .branch and !model.imported and model.commits.len > 0;
    return ui.row(.{ .height = 30, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, theme.rail_left, 0),
        ui.row(.{ .key = .{ .str = "open-repo" }, .grow = if (commits) 0 else 1, .height = 30, .padding = 0, .gap = 0, .cross = .center, .on_press = .open_repo, .semantics = .{ .label = spell("Open repository · ⌘O"), .role = .button }, .style = .{ .radius = 15 } }, .{
            space(ui, 11.5, 0),
            ui.appIcon(.{ .width = 16, .height = 16, .style = .{ .foreground = theme.sidebar_ink } }, if (model.imported) "document" else "repository"),
            space(ui, 10.5, 0),
            ui.paragraph(.{ .height = 18, .wrap = false, .overflow = .clip, .style = .{ .foreground = theme.ink } }, name),
            space(ui, if (commits) 6 else 7, 0),
            if (commits) ui.spacer(0) else ui.text(.{ .grow = 1, .style = .{ .foreground = theme.tertiary } }, if (model.imported) "Patch file" else model.head),
            if (commits) ui.spacer(0) else space(ui, 4, 0),
        }),
        if (commits) commitPicker(ui, model) else ui.spacer(0),
        tinted(ui, "refresh", "refresh", spell("Refresh · ⌘R"), .refresh, theme.tertiary, model.busy, 28),
        space(ui, theme.rail_right, 0),
    });
}
/// The comparison control holds the rail's foot. Branch asks for its base in a
/// popover above it, so choosing a comparison never moves anything.
/// The checked-out branch, or the one chosen to review against the base.
fn headName(model: *const Model) []const u8 {
    return if (model.compare_head.len > 0) model.compare_head.text() else if (model.head.len > 0) model.head else "Branch";
}
/// One side of the comparison: its role, then its branch. The side being
/// chosen is raised like the active scope segment.
fn branchSide(ui: *AppUi, model: *const Model, slot: app.BranchSlot, name: []const u8) AppUi.Node {
    const active = model.branch_slot == slot;
    const role = if (slot == .base) "Base" else "Head";
    return ui.row(.{ .key = .{ .str = role }, .grow = 1, .height = 28, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .branch_slot = slot }, .semantics = .{ .role = .button, .label = ui.fmt("{s} {s}", .{ role, name }) }, .style = .{ .background = if (active) theme.segment_on else theme.clear, .border = if (active) theme.selected_edge else theme.clear, .stroke_width = 0.5, .radius = 14 } }, .{
        space(ui, 10, 0),
        smallText(ui, role, theme.palette_hint),
        space(ui, 7, 0),
        ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) theme.palette_ink else theme.sidebar_ink } }, name),
        space(ui, 8, 0),
    });
}
/// Choosing what to compare, in the palette's language: the two sides on
/// top, a capsule filter, the branches newest first with the choice in theme.red,
/// and keycaps at the foot.
fn branchPicker(ui: *AppUi, model: *const Model) AppUi.Node {
    var matches: [app.max_branch_matches][]const u8 = undefined;
    const count = app.branchMatches(model, &matches);
    const visible = 8;
    const selected = @min(model.branch_selected, count -| 1);
    const first = if (selected >= visible) selected + 1 - visible else 0;
    const last = @min(count, first + visible);
    const white = canvas.Color.rgb8(255, 255, 255);
    var rows: [visible]AppUi.Node = undefined;
    var n: usize = 0;
    for (matches[first..last], first..) |name, position| {
        const active = position == selected;
        rows[n] = ui.row(.{ .key = .{ .index = position }, .height = theme.palette_row, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .branch_pick = position }, .semantics = .{ .role = .listitem, .label = name }, .style = .{ .background = if (active) theme.palette_active else theme.clear, .quiet_hover = true, .radius = 11 } }, .{
            space(ui, 11, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = if (active) white else theme.palette_hint } }, "branch"),
            space(ui, 8, 0),
            ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) white else theme.palette_ink } }, name),
            if (std.mem.eql(u8, name, model.head)) smallText(ui, "checked out", if (active) canvas.Color.rgba8(255, 255, 255, 200) else theme.palette_hint) else ui.spacer(0),
            space(ui, 11, 0),
        });
        n += 1;
    }
    const typed = std.mem.trim(u8, model.branch_query.text(), " ");
    const role = if (model.branch_slot == .base) "base" else "head";
    return ui.el(.popover, .{ .key = .{ .str = "branch-picker" }, .width = 300, .anchor = .above, .anchor_alignment = .start, .anchor_offset = 8, .padding = 5, .backdrop_blur_token = if (theme.native_blur) .md else null, .on_dismiss = .close_base, .semantics = .{ .role = .dialog, .label = "Compare branches" }, .style = .{ .background = theme.paletteFill(), .border = theme.glass_edge, .radius = 16 } }, .{ui.column(.{ .padding = 0, .gap = 0 }, .{
        ui.row(.{ .height = 28, .padding = 0, .gap = 2, .cross = .center }, .{
            branchSide(ui, model, .base, model.base.text()),
            tinted(ui, "swap", "swap", "Swap base and head", .branch_swap, theme.palette_hint, false, 26),
            branchSide(ui, model, .head, headName(model)),
        }),
        space(ui, 0, 6),
        ui.row(.{ .height = 30, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.palette_field, .radius = 15 } }, .{
            space(ui, 11, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.secondary } }, "find"),
            space(ui, 1, 0),
            ui.textField(.{ .key = .{ .str = ui.fmt("branch-query-{s}", .{role}) }, .grow = 1, .height = 26, .text = model.branch_query.text(), .placeholder = ui.fmt("Choose the {s} branch…", .{role}), .autofocus = true, .on_input = AppUi.inputMsg(.branch_query_edit), .on_submit = .base_compare, .semantics = .{ .label = "Filter branches" }, .variant = .ghost, .style = .{ .background = theme.clear, .border = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
            space(ui, 8, 0),
        }),
        space(ui, 0, 6),
        if (n > 0) ui.column(.{ .padding = 0, .gap = 0, .semantics = .{ .role = .list, .label = "Branches" } }, ui.arena.dupe(AppUi.Node, rows[0..n]) catch &.{}) else ui.row(.{ .height = 44, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, 12, 0), ui.text(.{ .grow = 1, .size = .sm, .text_alignment = .center, .style = .{ .foreground = theme.secondary } }, if (typed.len > 0) ui.fmt("No match · ↩ compares with “{s}”", .{typed}) else "No branches"), space(ui, 12, 0) }),
        space(ui, 0, 5),
        ui.row(.{ .height = 1, .padding = 0, .style = .{ .background = theme.hairline } }, .{}),
        ui.row(.{ .height = 28, .padding = 0, .gap = 0, .cross = .center, .semantics = .{ .label = "Branch hints", .role = .group } }, .{
            ui.spacer(1),
            keyHint(ui, if (model.branch_slot == .base) "Head" else "Base", "⇥"),
            space(ui, 14, 0),
            keyHint(ui, "Compare", "↩"),
            space(ui, 9.5, 0),
        }),
    })});
}
fn scopeBar(ui: *AppUi, model: *const Model) AppUi.Node {
    // Three segments: every file of the project, the uncommitted changes
    // (or the staged ones alone), and the checked-out branch against its base.
    const head = headName(model);
    const staged = model.mode == .staged;
    const changes_text: []const u8 = if (staged) "Staged" else "Changes";
    const changes_active = model.mode == .working or staged;
    // Pressing Changes again trades all uncommitted changes for the staged
    // ones alone, and back. The branch only switches; what it compares is
    // changed from the button that appears in it once it is shown.
    const changes_msg: Msg = .{ .mode = if (model.mode == .working) .staged else .working };
    const branch_msg: Msg = .{ .mode = .branch };
    const files_msg: Msg = .{ .mode = .files };
    const branch_tip = ui.el(.tooltip, .{ .text = ui.fmt("Changes on {s} since {s}", .{ head, model.base.text() }), .anchor = .above, .anchor_alignment = .end, .tooltip_delay = 600, .size = .sm }, .{});
    const changes_tip = ui.el(.tooltip, .{ .text = if (staged) "Staged changes · click for all uncommitted changes" else if (changes_active) "Uncommitted changes · click for staged changes only" else "Uncommitted changes", .anchor = .above, .anchor_alignment = .start, .tooltip_delay = 600, .size = .sm }, .{});
    // Three equal thirds, the branch's name truncating in its own (its
    // tooltip names it whole); in a rail too narrow for Changes (61.5 points
    // as laid out) to fit a third, one capsule names the scope and opens a
    // menu of them, as Rex folds its Filter capsule.
    const inner = model.sidebar_width - theme.rail_left - theme.rail_right - 8;
    const compact = inner / 3 < 62;
    const content = if (compact) blk: {
        const name: []const u8 = switch (model.mode) {
            .files => "Files",
            .working => "Changes",
            .staged => "Staged",
            .branch => head,
        };
        const Item = struct { text: []const u8, active: bool, msg: Msg };
        const entries = [_]Item{
            .{ .text = "Files", .active = model.mode == .files, .msg = files_msg },
            .{ .text = "Changes", .active = model.mode == .working, .msg = .{ .mode = .working } },
            .{ .text = "Staged changes", .active = staged, .msg = .{ .mode = .staged } },
            .{ .text = head, .active = model.mode == .branch, .msg = branch_msg },
            .{ .text = "Change branches…", .active = false, .msg = .open_base },
        };
        var items: [entries.len]AppUi.Node = undefined;
        for (entries, &items) |entry, *item| {
            item.* = ui.el(.menu_item, .{ .text = entry.text, .icon = if (entry.active) "app:check" else "app:blank", .height = 30, .on_press = entry.msg, .disabled = model.busy }, .{});
        }
        break :blk ui.stack(.{ .grow = 1, .height = 24, .padding = 0 }, .{
            // The scope's name centered in the capsule, the chevron at its
            // trailing edge, as a macOS pop-up button draws them.
            ui.row(.{ .key = .{ .str = "scope" }, .grow = 1, .height = 24, .padding = 0, .gap = 0, .cross = .center, .on_press = .toggle_scope_menu, .semantics = .{ .role = .button, .label = ui.fmt("Review scope: {s}", .{name}) }, .style = .{ .background = theme.segment_on, .border = theme.selected_edge, .stroke_width = 0.5, .radius = 12 } }, .{
                space(ui, 28, 0),
                ui.text(.{ .grow = 1, .size = .sm, .text_alignment = .center, .style = .{ .foreground = theme.ink } }, name),
                ui.appIcon(.{ .width = 10, .height = 10, .style = .{ .foreground = theme.sidebar_ink } }, "chevron"),
                space(ui, 18, 0),
            }),
            if (model.scope_menu) ui.el(.dropdown_menu, .{ .width = 200, .anchor = .above, .anchor_alignment = .start, .anchor_offset = 6, .padding = 5, .gap = 0, .on_dismiss = .close_scope_menu, .style = .{ .background = theme.menu, .border = theme.glass_edge, .radius = 12 } }, ui.arena.dupe(AppUi.Node, &items) catch &.{}) else ui.spacer(0),
        });
    } else blk: {
        // Each segment's place, so the highlight can sit under one and
        // slide between them.
        const widths: [3]f32 = @splat(inner / 3);
        const starts = [3]f32{ 0, widths[0] + 2, widths[0] + widths[1] + 4 };
        const position = std.math.clamp(app.scopePosition(model), 0, 2);
        const from: usize = @min(1, @as(usize, @intFromFloat(@floor(position))));
        const along = position - @as(f32, @floatFromInt(from));
        const thumb_x = std.math.lerp(starts[from], starts[from + 1], along);
        const thumb_width = std.math.lerp(widths[from], widths[from + 1], along);
        const thumb = ui.row(.{ .width = thumb_width, .height = 24, .padding = 0, .transform = canvas.Affine.translate(thumb_x, 0), .style = .{ .background = theme.segment_on, .border = theme.selected_edge, .stroke_width = 0.5, .radius = 12 } }, .{});
        var changes = ui.stack(.{ .width = widths[1], .height = 24, .padding = 0 }, .{
            segment(ui, changes_text, changes_text, changes_msg, changes_active, widths[1]),
            changes_tip,
        });
        changes.widget.layout.grow = 0;
        // A chevron at the branch's trailing edge opens the picker for its
        // base and head, whatever is shown; pressing the branch only shows it.
        const shown = model.mode == .branch;
        var picker = ui.stack(.{ .width = 20, .height = 24, .padding = 0 }, .{
            ui.button(.{ .key = .{ .str = "change-branches" }, .width = 20, .height = 24, .icon = "app:chevron", .size = .icon, .variant = .ghost, .on_press = .open_base, .semantics = .{ .label = "Change branches…" }, .style = .{ .foreground = theme.sidebar_ink, .background = theme.clear, .radius = 12, .quiet_hover = true } }, ""),
            ui.el(.tooltip, .{ .text = "Change branches…", .anchor = .above, .anchor_alignment = .end, .tooltip_delay = 400, .size = .sm }, .{}),
        });
        picker.widget.layout.grow = 0;
        var branch = ui.stack(.{ .width = widths[2], .height = 24, .padding = 0 }, .{
            ui.row(.{ .width = widths[2], .height = 24, .padding = 0, .gap = 0, .cross = .center }, .{
                segment(ui, ui.fmt("Branch {s}", .{head}), head, branch_msg, shown, null),
                picker,
            }),
            if (model.base_popover) ui.spacer(0) else branch_tip,
        });
        branch.widget.layout.grow = 0;
        break :blk ui.stack(.{ .grow = 1, .height = 24, .padding = 0 }, .{
            ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0 }, .{thumb}),
            ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 2, .cross = .center }, .{
                segment(ui, "Files", "Files", files_msg, model.mode == .files, widths[0]),
                changes,
                branch,
            }),
        });
    };
    return ui.row(.{ .height = 28, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, theme.rail_left, 0),
        ui.stack(.{ .grow = 1, .height = 28, .padding = 0 }, .{
            ui.row(.{ .grow = 1, .height = 28, .padding = 2, .gap = 0, .cross = .center, .semantics = .{ .label = "Review scope", .role = .group }, .style = .{ .background = theme.field, .radius = 14 } }, .{content}),
            if (model.base_popover) branchPicker(ui, model) else ui.spacer(0),
        }),
        space(ui, theme.rail_right, 0),
    });
}
/// A file's name for the rail, shortened in the middle when the rail is too
/// narrow for it (about 6.6 points a character), so its extension and its end
/// - what tells "tool-server.test.ts" from "tool-server.ts" - survive.
fn railName(ui: *AppUi, model: *const Model, file: patch.File) []const u8 {
    const name = std.fs.path.basename(file.path);
    var stats: f32 = 0;
    if (file.additions > 0) stats += 7 * @as(f32, @floatFromInt(std.fmt.count("+{d}", .{file.additions})));
    if (file.deletions > 0) stats += 4 + 7 * @as(f32, @floatFromInt(std.fmt.count("-{d}", .{file.deletions})));
    const room = model.sidebar_width - theme.rail_left - theme.rail_right - 11.5 - 16 - 10.5 - 6 - stats - 11;
    const fits: usize = @intFromFloat(@max(6, room / 6.6));
    if (name.len <= fits) return name;
    const tail = (fits - 1) / 2;
    const head = fits - 1 - tail;
    return ui.fmt("{s}…{s}", .{ name[0..head], name[name.len - tail ..] });
}
/// How far a commit's review has come, as an icon and its color.
fn commitMark(state: app.history.CommitState) struct { icon: []const u8, color: canvas.Color } {
    return switch (state) {
        .reviewed => .{ .icon = "check", .color = theme.green },
        .partial => .{ .icon = "checkbox", .color = theme.secondary },
        .changed => .{ .icon = "modified", .color = theme.note },
        .new => .{ .icon = "document", .color = theme.tertiary },
    };
}
/// A branch's commits, all together or one at a time: how many, or which,
/// in the repository row's quiet ink, opening the list of them. ]C and [C
/// step through them.
fn commitPicker(ui: *AppUi, model: *const Model) AppUi.Node {
    const count = model.commits.len;
    const label = if (model.commit) |index| ui.fmt("{d} of {d}", .{ index + 1, count }) else if (count == 1) "1 commit" else ui.fmt("{d} commits", .{count});
    const face = ui.row(.{ .key = .{ .str = "commit-picker" }, .height = 26, .padding = 0, .gap = 0, .cross = .center, .on_press = .toggle_commit_menu, .semantics = .{ .role = .button, .label = ui.fmt("Commits: {s} · {s} / {s}", .{ label, app.keyboard.shortcut(.commit_next), app.keyboard.shortcut(.commit_previous) }) }, .style = .{ .background = if (model.commit_menu) theme.selected else theme.clear, .radius = 13 } }, .{
        space(ui, 7, 0),
        ui.text(.{ .style = .{ .foreground = if (model.commit != null) theme.sidebar_ink else theme.tertiary } }, label),
        space(ui, 5, 0),
        ui.appIcon(.{ .width = 10, .height = 10, .style = .{ .foreground = theme.tertiary } }, "chevron"),
        space(ui, 7, 0),
    });
    return ui.row(.{ .grow = 1, .height = 30, .padding = 0, .gap = 0, .cross = .center }, .{
        ui.stack(.{ .height = 26, .padding = 0 }, .{ face, if (model.commit_menu) commitMenu(ui, model) else ui.spacer(0) }),
        ui.spacer(1),
    });
}
/// The branch's commits, oldest first, after the whole branch, each with
/// how far its review has come.
fn commitMenu(ui: *AppUi, model: *const Model) AppUi.Node {
    const row_h = theme.palette_row;
    const total = model.commits.len + 1;
    const height = @as(f32, @floatFromInt(@min(total, 12))) * row_h;
    const options = AppUi.VirtualListOptions{ .id = "commit-list", .item_count = total, .item_extent = row_h, .height = height, .overscan = 1, .semantics = .{ .label = "Commits" }, .on_scroll = AppUi.scrollMsg(.commit_menu_scrolled) };
    const window = canvas.virtualListRange(.{ .item_count = total, .item_extent = row_h, .viewport_extent = height, .scroll_offset = model.commit_offset, .overscan = 1 });
    const white = canvas.Color.rgb8(255, 255, 255);
    var rows: [20]AppUi.Node = undefined;
    var n: usize = 0;
    for (window.start_index..window.end_index) |position| {
        if (n == rows.len) break;
        const index: ?usize = if (position == 0) null else position - 1;
        const active = std.meta.eql(index, model.commit);
        const commit = if (index) |value| model.commits[value] else null;
        const mark = if (index) |value| (if (value < model.commit_states.len) commitMark(model.commit_states[value]) else commitMark(.new)) else @TypeOf(commitMark(.new)){ .icon = "branch", .color = theme.palette_hint };
        const title = if (commit) |value| value.subject() else "All changes";
        const detail = if (commit) |value| value.id[0..@min(7, value.id.len)] else if (model.commits.len == 1) "1 commit" else ui.fmt("{d} commits", .{model.commits.len});
        rows[n] = ui.row(.{ .key = .{ .index = position }, .height = row_h, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .select_commit = index }, .semantics = .{ .role = .listitem, .label = title }, .style = .{ .background = if (active) theme.palette_active else theme.clear, .quiet_hover = true, .radius = 11 } }, .{
            space(ui, 11, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = if (active) white else mark.color } }, mark.icon),
            space(ui, 8, 0),
            ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) white else theme.palette_ink } }, title),
            space(ui, 8, 0),
            smallText(ui, detail, if (active) canvas.Color.rgba8(255, 255, 255, 200) else theme.palette_hint),
            space(ui, 11, 0),
        });
        n += 1;
    }
    return ui.el(.popover, .{ .key = .{ .str = "commit-menu" }, .width = 340, .anchor = .below, .anchor_alignment = .start, .anchor_offset = 6, .padding = 5, .backdrop_blur_token = if (theme.native_blur) .md else null, .on_dismiss = .close_commit_menu, .semantics = .{ .role = .dialog, .label = "Commits" }, .style = .{ .background = theme.paletteFill(), .border = theme.glass_edge, .radius = 16 } }, .{ui.virtualList(options, window, rows[0..n])});
}
fn fileRail(ui: *AppUi, model: *const Model) AppUi.Node {
    const options = AppUi.VirtualListOptions{ .id = "files", .item_count = model.rail_rows.len, .item_extent = theme.row_pitch, .overscan = 1, .grow = 1 };
    const window = ui.virtualWindow(options);
    var nodes: [100]AppUi.Node = undefined;
    var count: usize = 0;
    for (model.rail_rows[window.start_index..window.end_index], window.start_index..) |entry, row_index| {
        if (count == nodes.len) break;
        nodes[count] = if (entry.file) |index| blk: {
            const file = model.files[index];
            const active = index == model.selected;
            // Reviewed files are checked; those reviewed in another version are marked changed.
            const changed = !file.reviewed and (file.prior == .changed or file.prior == .base);
            const icon = if (file.reviewed) "check" else if (changed) "modified" else if (file.message) "note" else if (file.listed) (if (app.isImage(file.path)) "image" else "document") else if (file.reference) "symbol" else if (file.binary and app.isImage(file.path)) "image" else "document";
            const tint = if (file.reviewed) theme.green else if (changed) theme.note else if (file.listed and !file.collapsed) theme.ink else if (file.listed) theme.tertiary else theme.sidebar_ink;
            // Rex's selection: a quiet capsule with a hairline edge, inset from the sidebar.
            const item = ui.row(.{ .key = .{ .str = "file" }, .grow = 1, .height = theme.row_height, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .select = index }, .semantics = .{ .label = file.path, .role = .listitem }, .style = .{ .background = if (active) theme.selected else theme.clear, .border = if (active) theme.selected_edge else theme.clear, .stroke_width = 0.5, .radius = theme.row_height / 2, .quiet_hover = active } }, .{
                space(ui, 11.5, 0),
                ui.appIcon(.{ .width = 16, .height = 16, .style = .{ .foreground = tint } }, icon),
                space(ui, 10.5, 0),
                ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) theme.ink else if (file.reviewed) theme.tertiary else if (model.active) theme.sidebar_ink else theme.sidebar_inactive } }, railName(ui, model, file)),
                space(ui, 6, 0),
                if (file.additions > 0) smallText(ui, ui.fmt("+{d}", .{file.additions}), theme.green) else ui.spacer(0),
                if (file.additions > 0 and file.deletions > 0) space(ui, 4, 0) else ui.spacer(0),
                if (file.deletions > 0) smallText(ui, ui.fmt("−{d}", .{file.deletions}), theme.red) else ui.spacer(0),
                space(ui, 11, 0),
            });
            break :blk ui.row(.{ .key = .{ .index = row_index }, .height = theme.row_pitch, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, theme.rail_left, 0), item, space(ui, theme.rail_right, 0) });
        } else blk: {
            // Directories read as Rex's group headers: small, medium weight, secondary.
            var header = ui.paragraph(.{ .height = 14, .grow = 1, .wrap = false, .overflow = .clip, .style = .{ .foreground = theme.secondary } }, ui.arena.dupe(canvas.TextSpan, &.{.{ .text = entry.directory, .weight = .medium, .scale = 11.0 / 13.0 }}) catch &.{});
            header.widget.semantics.label = entry.directory;
            break :blk ui.column(.{ .key = .{ .index = row_index }, .height = theme.row_pitch, .padding = 0, .gap = 0 }, .{
                space(ui, 0, 10),
                ui.row(.{ .height = 14, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, 22.5, 0), header, space(ui, 10, 0) }),
            });
        };
        count += 1;
    }
    return ui.column(.{ .width = model.sidebar_width, .padding = 0, .gap = 0 }, .{
        band(ui),
        repositoryRow(ui, model),
        space(ui, 0, 6),
        ui.row(.{ .height = 28, .padding = 0, .gap = 0, .cross = .center }, .{
            capsuleField(ui, "find", ui.textField(.{ .key = .{ .str = "filter" }, .grow = 1, .height = 24, .text = model.filter.text(), .placeholder = "Find file", .on_input = AppUi.inputMsg(.filter_edit), .on_submit = .filter_accept, .semantics = .{ .label = "Find file" }, .variant = .ghost, .style = .{ .border = theme.clear, .background = theme.clear, .focus_ring = theme.clear, .radius = 0 } })),
        }),
        space(ui, 0, 10),
        ui.virtualList(options, window, nodes[0..count]),
        space(ui, 0, 8),
        if (model.imported) ui.spacer(0) else scopeBar(ui, model),
        // Lands the foot control on Rex's foot-bar line, 25 points above the edge.
        space(ui, 0, 11),
    });
}
fn groupedCode(ui: *AppUi, node: AppUi.Node, group: u64, offset: usize) AppUi.Node {
    var result = node;
    result.static_text_group_fingerprint = 0;
    if (result.widget.kind == .text) {
        result.widget.static_text_group_id = group;
        result.widget.static_text_group_offset = offset;
    }
    if (node.nodes.len > 0) {
        const children = ui.arena.dupe(AppUi.Node, node.nodes) catch return result;
        for (children) |*child| child.* = groupedCode(ui, child.*, group, offset);
        result.nodes = children;
    }
    return result;
}
const words = @import("words.zig");
/// The changed runs inside a line: byte ranges of its source.
const Emphasis = []const words.Range;
/// Lays a background over each range of `text`, splitting highlighted spans
/// at the edges. Falls back to the plain spans if the split would not fit.
fn emphasize(spans: []const canvas.TextSpan, text: []const u8, ranges: Emphasis, color: canvas.TextSpanColor, out: []canvas.TextSpan) []const canvas.TextSpan {
    var current = spans;
    var scratch: [2][canvas.max_text_spans_per_paragraph]canvas.TextSpan = undefined;
    for (ranges, 0..) |range, which| {
        if (range.end <= range.start) continue;
        const target: []canvas.TextSpan = if (which + 1 == ranges.len) out else &scratch[which % 2];
        var count: usize = 0;
        for (current) |span| {
            const begin = @intFromPtr(span.text.ptr) - @intFromPtr(text.ptr);
            const finish = begin + span.text.len;
            const cuts = [_]usize{ begin, std.math.clamp(range.start, begin, finish), std.math.clamp(range.end, begin, finish), finish };
            for (0..3) |part| {
                if (cuts[part + 1] <= cuts[part]) continue;
                if (count == target.len) return spans;
                var piece = span;
                piece.text = text[cuts[part]..cuts[part + 1]];
                if (part == 1) piece.background = color;
                target[count] = piece;
                count += 1;
            }
        }
        current = target[0..count];
    }
    if (current.ptr != out.ptr and current.ptr != spans.ptr) {
        @memcpy(out[0..current.len], current);
        return out[0..current.len];
    }
    return current;
}
/// The color each kind of token takes.
fn tokenColor(kind: app.highlight.Kind) canvas.TextSpanColor {
    return switch (kind) {
        .plain => .syntax_plain,
        .comment => .syntax_comment,
        .keyword => .syntax_keyword,
        .string => .syntax_literal,
        .function => .syntax_function,
        .property => .syntax_property,
        .constant => .syntax_constant,
        .type => .info,
    };
}
/// A line's spans from its file's whole-file highlighting, when the file was
/// highlighted and the row's text is that line of it (rows of the changes
/// since review, whose old side is another version, are left to the lexer).
fn wholeFileSpans(model: *const Model, file: usize, old: bool, number: u32, source: []const u8, text: []const u8, out: []canvas.TextSpan) ?[]const canvas.TextSpan {
    if (file >= model.marks.len or number == 0) return null;
    const entry = model.files[file];
    if (entry.showing_since and old) return null;
    const marks = (if (old) model.marks[file].old else model.marks[file].new) orelse return null;
    // The row's text must be the file's line, or the offsets mean nothing.
    if (!entry.reference) {
        if (file >= model.sources.len) return null;
        const sides = model.sources[file].side(old) orelse return null;
        if (!std.mem.eql(u8, sides.line(number), source)) return null;
    }
    const tokens = marks.line(number - 1);
    var count: usize = 0;
    var at: usize = 0;
    for (tokens) |token| {
        const start = @min(token.start, source.len);
        const end = @min(token.end, source.len);
        if (end <= start or start < at) continue;
        if (count + 2 >= out.len) break;
        if (start > at) {
            out[count] = .{ .text = text[at..start], .monospace = true, .color = .syntax_plain };
            count += 1;
        }
        out[count] = .{ .text = text[start..end], .monospace = true, .color = tokenColor(token.kind) };
        count += 1;
        at = end;
    }
    if (count >= out.len) return null;
    out[count] = .{ .text = text[at..], .monospace = true, .color = .syntax_plain };
    return out[0 .. count + 1];
}
fn codeLine(ui: *AppUi, model: *const Model, source: []const u8, number: u32, old: bool, file: usize, row_index: usize, offset: usize, language: canvas.code.Language, carry: u16, emphasis: Emphasis) AppUi.Node {
    const group = app.selection.groupId(file, old, model.selection_epoch, model.generation);
    const key = ui.fmt("source-{d}-{d}-{any}", .{ model.generation, row_index, old });
    const label = ui.fmt("{s} code line {d}", .{ if (old) "Old" else "New", number });
    const text = ui.fmt("{s}\n", .{source});
    // The general code component also creates vertical scrolling, a track,
    // and a root container. A virtualized single line needs just native text;
    // the review pans every line together. Keep the SDK's chunking for
    // unusually long lines.
    if (source.len > 4096) return groupedCode(ui, ui.code(.{ .global_key = .{ .str = key }, .language = language, .wrap = false, .height = 24, .grow = 1, .semantics = .{ .label = label } }, text), group, offset);
    var storage: [canvas.max_text_spans_per_paragraph]canvas.TextSpan = undefined;
    // The file's own highlighting, read whole, when this line is the file's;
    // else the line lexed from the state the lines above it left (a comment
    // or string still open), as worked out once when the patch was read.
    const highlighted = wholeFileSpans(model, file, old, number, source, text, &storage) orelse blk: {
        var state: canvas.code.HighlightState = if (carry < model.carries.len) model.carries[carry] else .{};
        break :blk canvas.CodeContentPolicy.highlight(ui.code_content_policy, text, language, &storage, &state);
    };
    var split: [canvas.max_text_spans_per_paragraph]canvas.TextSpan = undefined;
    const changed = emphasize(highlighted, text, emphasis, if (old) .destructive else .success, &split);
    // The first search hit on the line is marked in amber, as the search counts it.
    const query = model.search_query.text();
    var hits: [canvas.max_text_spans_per_paragraph]canvas.TextSpan = undefined;
    const spans = if (query.len > 0) if (std.ascii.indexOfIgnoreCase(source, query)) |at| emphasize(changed, text, &.{.{ .start = at, .end = at + query.len }}, .warning, &hits) else changed else changed;
    // One clipped line of text, shifted by the review's shared horizontal
    // offset so every line pans together; the cell does the clipping. The
    // 17-point line box sits on the line numbers' baseline.
    // Monospace text has a known width, so the line is sized without
    // measuring it (measuring every line cost a frame of scroll latency).
    var paragraph = ui.paragraph(.{ .global_key = .{ .str = key }, .width = @as(f32, @floatFromInt(source.len)) * app.code_advance + 24, .height = 17, .wrap = false, .overflow = .clip, .transform = if (model.scroll_x > 0) canvas.Affine.translate(-model.scroll_x, 0) else .{} }, spans);
    paragraph.widget.static_text_group_id = group;
    paragraph.widget.static_text_group_offset = offset;
    paragraph.widget.layout.zero_intrinsic = true;
    // The clip names the line; the cell around it carries the context menu.
    var cell = ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0, .cross = .center, .semantics = .{ .label = label, .role = .group } }, .{paragraph});
    cell.widget.layout.clip_content = true;
    cell.widget.layout.zero_intrinsic = true;
    return cell;
}
/// The gutter: one button per line. Numbers are padded to four digit widths
/// with figure spaces, so the centered labels line up on their right edges; a
/// noted line adds a short amber bar at the edge (the only extra widget, and
/// only there: a row of extras per line overran the canvas's widget budget).
fn gutter(ui: *AppUi, model: *const Model, file: usize, number: u32, old: bool, hovered: bool, current: bool, selected: bool, match: bool, wash: canvas.Color) AppUi.Node {
    const color = if (current or selected or hovered) theme.ink else if (std.meta.eql(wash, theme.added)) theme.gutter_added else if (std.meta.eql(wash, theme.removed)) theme.gutter_removed else if (std.meta.eql(wash, theme.moved)) theme.moved_ink else theme.line_number;
    const digits = std.fmt.count("{d}", .{number});
    const pad = "\u{2007}\u{2007}\u{2007}";
    const text = if (hovered) "" else ui.fmt("{s}{d}", .{ pad[0 .. 3 * (4 -| digits)], number });
    const noted = app.noted(model, file, number, old);
    const button = ui.button(.{ .width = if (noted) 46 else 48, .height = 24, .size = .sm, .variant = .ghost, .icon = if (hovered) "app:add" else "", .on_press = .{ .line_press = .{ .file = file, .line = number, .old = old } }, .style = .{ .foreground = color, .background = if (current) theme.current_line else if (match) theme.match else theme.clear, .radius = 0 }, .semantics = .{ .label = ui.fmt("Comment on {s} line {d}", .{ if (old) "old" else "new", number }) } }, text);
    if (!noted) return button;
    return ui.row(.{ .width = 48, .height = 24, .padding = 0, .gap = 0, .cross = .center }, .{ ui.row(.{ .width = 2, .height = 16, .padding = 0, .style = .{ .background = theme.note, .radius = 1 } }, .{}), button });
}
/// Where a moved block went (or came from), on the block's first line: a
/// quiet link in the move's ink that jumps there.
fn moveLink(ui: *AppUi, model: *const Model, moved: u32, old: bool) AppUi.Node {
    if (moved == 0 or moved > model.moves.len) return ui.spacer(0);
    const move = model.moves[moved - 1];
    const other: usize = if (old) move.to_file else move.from_file;
    const line_number = if (old) move.to_line else move.from_line;
    const same = other == (if (old) move.from_file else move.to_file);
    const name = if (other < model.files.len) std.fs.path.basename(model.files[other].path) else "";
    const text = if (same) ui.fmt("{s} line {d}", .{ if (old) "Moved to" else "Moved from", line_number }) else ui.fmt("{s} {s}:{d}", .{ if (old) "Moved to" else "Moved from", name, line_number });
    return ui.row(.{ .height = 24, .padding = 0, .gap = 0, .cross = .center }, .{
        ui.button(.{ .key = .{ .str = "move" }, .height = 20, .size = .sm, .variant = .ghost, .icon = if (old) "app:right" else "app:left", .on_press = .{ .goto_move = .{ .move = moved, .to = old } }, .semantics = .{ .label = text }, .style = .{ .foreground = theme.moved_ink, .background = theme.clear, .radius = 10, .quiet_hover = true } }, text),
        space(ui, 6, 0),
    });
}
fn codeCell(ui: *AppUi, model: *const Model, source: []const u8, number: u32, old: bool, file: usize, row_index: usize, offset: usize, wash: canvas.Color, language: canvas.code.Language, carry: u16, current: bool, match: bool, emphasis: Emphasis, moved_link: u32) AppUi.Node {
    const hovered = if (model.hover) |hit| hit.row == row_index and hit.old == old else false;
    const selected = model.mouse.active and model.mouse.range != null and model.mouse.range.?.contains(file, old, row_index);
    const fill = if (selected) theme.text_selection else wash;
    // The opaque review pane already supplies the unchanged-line color.
    const background = if (!selected and std.meta.eql(wash, theme.background)) theme.clear else fill;
    // Empty sides still occupy their half of the row, but have no source,
    // gutter action, or enabled context action to construct.
    if (number == 0) return ui.row(.{ .grow = 1, .min_width = 48, .height = 24, .padding = 0, .gap = 0, .style = .{ .background = background } }, .{});
    const menu_items = ui.arena.dupe(AppUi.ContextMenuItem, &.{
        .{ .label = if (selected) "Comment on selection" else "Add line comment", .msg = if (selected) Msg.comment_selection else .{ .anchor = .{ .file = file, .line = number, .old = old } }, .enabled = number > 0 },
        .{ .label = if (selected) "Copy selection" else "Copy line", .msg = .{ .copy_line = .{ .file = file, .row = row_index, .old = old, .line = number } }, .enabled = number > 0 },
        .{ .label = "Blame line", .msg = .{ .blame_line = .{ .file = file, .row = row_index, .old = old, .line = number } }, .enabled = number > 0 and !model.imported },
    }) catch &.{};
    const source_node = if (number > 0) codeLine(ui, model, source, number, old, file, row_index, offset, language, carry, emphasis) else ui.spacer(1);
    return ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0, .cross = .center, .context_menu = menu_items, .style = .{ .background = background } }, .{
        // A noted line carries a short accent bar at the gutter's edge; its
        // number keeps the change's color.
        // A noted line carries a short amber bar at the gutter's edge; the
        // number, right-aligned in fixed-width digits, keeps the change's color.
        if (number > 0) gutter(ui, model, file, number, old, hovered, current, selected, match, wash) else space(ui, 48, 0),
        source_node,
        if (moved_link != 0) moveLink(ui, model, moved_link, old) else ui.spacer(0),
    });
}
/// Actions for a mouse selection: a small raised capsule floating 6 points
/// under the selection's last line, 12 points in from the pane's edge, holding
/// only the selected range and two quiet icons, comment and copy.
fn selectionBar(ui: *AppUi, model: *const Model) AppUi.Node {
    const range = model.mouse.range.?;
    const label = if (range.last_line > range.first_line) ui.fmt("{d}–{d}", .{ range.first_line, range.last_line }) else ui.fmt("{d}", .{range.first_line});
    // Figures run about 6.7 points apiece at the small size, the dash about 7.
    const text_width = @as(f32, @floatFromInt(std.unicode.utf8CountCodepoints(label) catch label.len)) * 6.8;
    const width = 12 + text_width + 6 + 28 + 28 + 28 + 2 * 2;
    const bar = ui.el(.popover, .{ .width = width, .height = 32, .padding = 2, .anchor = .below, .anchor_alignment = .end, .anchor_offset = 6, .on_dismiss = .clear_selection, .semantics = .{ .label = "Selection actions" }, .style = .{ .background = theme.menu, .border = theme.glass_edge, .stroke_width = 0.5, .radius = 16 } }, .{
        ui.row(.{ .height = 28, .padding = 0, .gap = 0, .cross = .center }, .{
            space(ui, 10, 0),
            ui.text(.{ .size = .sm, .style = .{ .foreground = theme.secondary } }, label),
            space(ui, 6, 0),
            tinted(ui, "comment-selection", "comment", "Comment on selected lines", .comment_selection, theme.sidebar_ink, false, 28),
            tinted(ui, "copy-selection", "copy", "Copy selected code", .copy_selection, theme.sidebar_ink, false, 28),
            tinted(ui, "find-selection", "symbol", ui.fmt("Find where this is defined and used · {s}", .{app.keyboard.shortcut(.find_symbol)}), .{ .find_symbol_at = .{ .file = range.file, .row = range.focus, .old = range.old, .line = range.last_line } }, theme.sidebar_ink, model.imported, 28),
        }),
    });
    // The bar anchors to a marker of its width at the row's right, 12 points in.
    return ui.row(.{ .height = 24, .padding = 0, .gap = 0 }, .{ ui.spacer(1), ui.stack(.{ .width = width, .height = 24, .padding = 0 }, .{bar}), space(ui, 12, 0) });
}
/// A file's header is the title row of its pane, as a Rex block's is: 3
/// points of ground above it (the file pane before ends 3 points short, so
/// panes part by 6), then the pane's rounded top. A folded file is just this
/// row: a short pane rounded at both ends, filling all but a point of ground
/// above and below, so folded files read as a list of full-height rows (as
/// the rail's 30-point rows sit on a 32-point pitch) rather than thin bars.
fn fileHeader(ui: *AppUi, model: *const Model, index: usize, current: bool) AppUi.Node {
    const folded = model.files[index].collapsed;
    const height: f32 = if (folded) 22 else 21;
    return ui.column(.{ .height = 24, .padding = 0, .gap = 0 }, .{
        space(ui, 0, if (folded) 1 else 3),
        ui.stack(.{ .height = height, .padding = 0 }, .{ paneEdge(ui, height, true, folded), headerRow(ui, model, index, current, height) }),
        if (folded) space(ui, 0, 1) else ui.spacer(0),
    });
}
/// What a file's header says: the whole row folds the file, naming it and
/// then, quietly, its folder, with its counts, note and reviewed controls.
fn headerRow(ui: *AppUi, model: *const Model, index: usize, current: bool, height: f32) AppUi.Node {
    const file = model.files[index];
    var notes: usize = 0;
    for (model.notes.items) |note| if (note.state != .resolved and std.mem.eql(u8, note.path, file.path) and app.inView(model, note)) {
        notes += 1;
    };
    // What kind of change it is, or what an earlier review makes of it.
    const label: []const u8 = if (file.listed) (if (file.unreadable) "Could not be read" else if (file.unread or file.binary) "" else if (file.unified.len == 1) "1 line" else ui.fmt("{d} lines", .{file.unified.len})) else if (file.reference) "Reference · unchanged" else if (file.whitespace_only) "Whitespace only" else if (file.generated) "Generated" else switch (file.prior) {
        .rebased => "Reviewed on another base",
        .changed => if (file.showing_since) (if (file.since.?.base_moved) "Since review · base moved too" else "Since review") else "Changed since review",
        .base => "Base changed since review",
        else => "",
    };
    const label_color = if (file.prior == .changed or file.prior == .base) theme.note else theme.tertiary;
    const folded = file.collapsed;
    const name = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = std.fs.path.basename(file.path), .weight = .medium }}) catch &.{};
    var header = ui.row(.{ .key = .{ .str = ui.fmt("header-{d}", .{index}) }, .grow = 1, .height = height, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .collapse_file = index }, .semantics = .{ .label = ui.fmt("{s} {s}", .{ if (folded) "Expand" else "Collapse", file.path }), .role = .button }, .style = .{ .background = if (current) theme.selected else theme.clear, .radius = @min(theme.pane_radius, height / 2) } }, .{
        space(ui, 8, 0),
        ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.tertiary } }, if (folded) "collapsed" else "expanded"),
        space(ui, 6, 0),
        ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.muted } }, if (file.message) "note" else "document"),
        space(ui, 8, 0),
        ui.paragraph(.{ .height = 16, .size = .sm, .wrap = false, .overflow = .clip, .style = .{ .foreground = if (folded) theme.sidebar_ink else theme.ink } }, name),
        space(ui, 8, 0),
        ui.text(.{ .grow = 1, .size = .sm, .style = .{ .foreground = theme.tertiary } }, std.fs.path.dirname(file.path) orelse ""),
        if (label.len > 0) smallText(ui, label, label_color) else ui.spacer(0),
        if (label.len > 0 and file.additions + file.deletions > 0) space(ui, 8, 0) else ui.spacer(0),
        if (file.additions > 0) smallText(ui, ui.fmt("+{d}", .{file.additions}), theme.green) else ui.spacer(0),
        if (file.additions > 0 and file.deletions > 0) space(ui, 6, 0) else ui.spacer(0),
        if (file.deletions > 0) smallText(ui, ui.fmt("−{d}", .{file.deletions}), theme.red) else ui.spacer(0),
        space(ui, 8, 0),
        if (file.listed) ui.spacer(0) else ui.button(.{ .key = .{ .str = "file-note" }, .width = 24, .height = height, .icon = "app:comment", .size = .icon, .variant = .ghost, .on_press = .{ .note_file = index }, .style = .{ .foreground = if (notes > 0) theme.note else theme.tertiary, .radius = 0 }, .semantics = .{ .label = ui.fmt("Add note to {s}", .{file.path}) } }, ""),
        if (file.listed) ui.button(.{ .key = .{ .str = "close-file" }, .width = 24, .height = height, .icon = "app:close", .size = .icon, .variant = .ghost, .on_press = .{ .collapse_file = index }, .style = .{ .foreground = theme.tertiary, .radius = 0 }, .semantics = .{ .label = ui.fmt("Close {s}", .{file.path}) } }, "") else if (file.reference) ui.button(.{ .key = .{ .str = "close-reference" }, .width = 24, .height = height, .icon = "app:close", .size = .icon, .variant = .ghost, .on_press = .{ .close_reference = index }, .style = .{ .foreground = theme.tertiary, .radius = 0 }, .semantics = .{ .label = ui.fmt("Close {s}", .{file.path}) } }, "") else ui.button(.{ .key = .{ .str = "file-reviewed" }, .width = 24, .height = height, .icon = if (file.reviewed) "app:check" else "app:checkbox", .size = .icon, .variant = .ghost, .on_press = .{ .reviewed_file = index }, .style = .{ .foreground = if (file.reviewed) theme.green else theme.tertiary, .radius = 0 }, .semantics = .{ .label = ui.fmt("Mark {s} reviewed", .{file.path}) } }, ""),
        space(ui, 7, 0),
    });
    header.widget.layout.clip_content = true;
    return header;
}
/// What a hunk header says once git's range syntax is set aside: the enclosing
/// declaration git found, or the new side's line range when there is none.
fn hunkTitle(ui: *AppUi, header: []const u8) []const u8 {
    const close = std.mem.indexOfPos(u8, header, 2, "@@") orelse return header;
    const context = std.mem.trim(u8, header[close + 2 ..], " \t");
    if (context.len > 0) return context;
    // "@@ -a,b +c,d @@": report c through c + d - 1.
    const plus = std.mem.indexOfScalar(u8, header, '+') orelse return header;
    var parts = std.mem.tokenizeAny(u8, header[plus + 1 .. close], ", ");
    const start = std.fmt.parseInt(u32, parts.next() orelse "", 10) catch return header;
    const count = std.fmt.parseInt(u32, parts.next() orelse "1", 10) catch 1;
    return if (count <= 1) ui.fmt("Line {d}", .{start}) else ui.fmt("Lines {d}–{d}", .{ start, start + count - 1 });
}
/// A quiet 24-point icon button in a hunk header's gutter.
fn gutterButton(ui: *AppUi, key: []const u8, icon: []const u8, label: []const u8, msg: Msg) AppUi.Node {
    return ui.stack(.{ .key = .{ .str = key }, .width = 24, .height = 24, .padding = 0 }, .{
        ui.button(.{ .key = .{ .str = "button" }, .icon = ui.fmt("app:{s}", .{icon}), .semantics = .{ .label = label }, .width = 24, .height = 24, .size = .icon, .variant = .ghost, .on_press = msg, .style = .{ .foreground = theme.secondary, .background = theme.clear, .radius = 6 } }, ""),
        ui.el(.tooltip, .{ .text = label, .anchor = .above, .anchor_alignment = .start, .tooltip_delay = 500, .size = .sm }, .{}),
    });
}
/// A hunk's header, between hunks: the declaration it sits in, the lines the
/// diff left out above it with buttons in the gutter to show them (a step
/// from either end, or all when they are few), and, when the file has more
/// than one hunk, the hunk's own review. A tail header stands for the rest
/// of the file. A reviewed hunk folds to this row, which then counts it.
fn hunkHeader(ui: *AppUi, model: *const Model, file_index: usize, rows: []const patch.Row, code: usize, current: bool) AppUi.Node {
    const file = model.files[file_index];
    const row = rows[code];
    const sides: ?patch.Text = if (file_index < model.sources.len and !file.showing_since) model.sources[file_index].new else null;
    const gap: patch.Gap = if (sides) |text| patch.gapAt(rows, code, text.count()) orelse .{ .first = 1, .last = 0, .delta = 0 } else .{ .first = 1, .last = 0, .delta = 0 };
    const hidden = if (file.oneSided() or file.binary) 0 else gap.size();
    const step = app.expand_step;
    const base: app.Expansion = .{ .file = file_index, .hunk = row.hunk, .tail = row.tail };
    var up = base;
    up.from_top = false;
    var down = base;
    down.from_top = true;
    var all = base;
    all.all = true;
    all.from_top = true;
    // The first header has nothing above its gap; a tail nothing below.
    const first = gap.first <= 1;
    const controls = if (hidden == 0) ui.row(.{ .width = 48, .height = 24, .padding = 0, .main = .center, .cross = .center }, .{smallText(ui, "⋯", theme.line_number)}) else if (hidden <= step) ui.row(.{ .width = 48, .height = 24, .padding = 0, .main = .center, .cross = .center }, .{
        gutterButton(ui, "expand-all", "expand-all", ui.fmt("Show {d} hidden line{s}", .{ hidden, if (hidden == 1) "" else "s" }), .{ .expand = all }),
    }) else if (row.tail) ui.row(.{ .width = 48, .height = 24, .padding = 0, .main = .center, .cross = .center }, .{
        gutterButton(ui, "expand-down", "expand-down", ui.fmt("Show {d} more lines", .{step}), .{ .expand = down }),
    }) else if (first) ui.row(.{ .width = 48, .height = 24, .padding = 0, .main = .center, .cross = .center }, .{
        gutterButton(ui, "expand-up", "expand-up", ui.fmt("Show {d} lines above", .{step}), .{ .expand = up }),
    }) else ui.row(.{ .width = 48, .height = 24, .padding = 0, .gap = 0, .cross = .center }, .{
        gutterButton(ui, "expand-down", "expand-down", ui.fmt("Show {d} lines below the hunk above", .{step}), .{ .expand = down }),
        gutterButton(ui, "expand-up", "expand-up", ui.fmt("Show {d} lines above this hunk", .{step}), .{ .expand = up }),
    });
    const hunk: ?patch.Hunk = if (!row.tail and !file.showing_since and file.hunks.len > 1 and row.hunk < file.hunks.len) file.hunks[row.hunk] else null;
    const text = if (row.tail) (if (hidden == 1) "1 more line" else ui.fmt("{d} more lines", .{hidden})) else if (file.oneSided() and file.status == .added) "New file" else if (file.oneSided()) "Deleted file" else hunkTitle(ui, row.left);
    const title = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = text, .monospace = !row.tail }}) catch &.{};
    var paragraph = ui.paragraph(.{ .height = 16, .size = .sm, .wrap = false, .overflow = .clip, .semantics = .{ .label = if (row.tail) text else row.left }, .style = .{ .foreground = theme.line_number } }, title);
    paragraph.widget.layout.zero_intrinsic = true;
    paragraph.widget.layout.grow = 1;
    // A folded hunk counts what it holds.
    var additions: u32 = 0;
    var deletions: u32 = 0;
    if (hunk != null and hunk.?.collapsed) for (rows[code + 1 ..]) |each| {
        if (each.meta) break;
        additions += @intFromBool(each.added);
        deletions += @intFromBool(each.removed);
    };
    const folded = hunk != null and hunk.?.collapsed;
    const reviewed = hunk != null and hunk.?.reviewed;
    const at: app.HunkRef = .{ .file = file_index, .hunk = row.hunk };
    var top = ui.row(.{ .key = .{ .str = ui.fmt("hunk-{d}-{d}-{any}", .{ file_index, row.hunk, row.tail }) }, .height = 24, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = if (current) theme.current_line else theme.pane } }, .{
        controls,
        ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0, .cross = .center, .on_press = if (hunk != null) Msg{ .collapse_hunk = at } else if (hidden > 0) Msg{ .expand = all } else null, .semantics = .{ .role = .button, .label = if (hunk != null) ui.fmt("{s} hunk {s}", .{ if (folded) "Unfold" else "Fold", text }) else text } }, .{
            paragraph,
            if (folded and additions > 0) smallText(ui, ui.fmt("+{d}", .{additions}), theme.gutter_added) else ui.spacer(0),
            if (folded and additions > 0 and deletions > 0) space(ui, 6, 0) else ui.spacer(0),
            if (folded and deletions > 0) smallText(ui, ui.fmt("−{d}", .{deletions}), theme.gutter_removed) else ui.spacer(0),
            if (folded) space(ui, 10, 0) else ui.spacer(0),
            if (hidden > 0 and !row.tail) smallText(ui, if (hidden == 1) "1 hidden line" else ui.fmt("{d} hidden lines", .{hidden}), theme.line_number) else ui.spacer(0),
            if (hidden > 0 and !row.tail) space(ui, 8, 0) else ui.spacer(0),
        }),
        if (hunk != null) ui.button(.{ .key = .{ .str = "hunk-reviewed" }, .width = 24, .height = 24, .icon = if (reviewed) "app:check" else "app:checkbox", .size = .icon, .variant = .ghost, .on_press = .{ .reviewed_hunk = at }, .style = .{ .foreground = if (reviewed) theme.green else theme.tertiary, .radius = 0 }, .semantics = .{ .label = ui.fmt("Mark hunk {s} · {s}", .{ if (reviewed) "unreviewed" else "reviewed", app.keyboard.shortcut(.hunk_reviewed) }) } }, "") else ui.spacer(0),
        space(ui, 7, 0),
    });
    top.widget.layout.clip_content = true;
    return top;
}
/// Bytes as a person reads them: "812 B", "14.2 KB", "3.1 MB".
fn byteSize(ui: *AppUi, bytes: usize) []const u8 {
    const value: f64 = @floatFromInt(bytes);
    if (bytes < 1024) return ui.fmt("{d} B", .{bytes});
    if (bytes < 1024 * 1024) return ui.fmt("{d:.1} KB", .{value / 1024});
    return ui.fmt("{d:.1} MB", .{value / (1024 * 1024)});
}
/// One side of an image change: a caption (which side, its size in pixels
/// and bytes) over the picture on a quiet card, centered in its column.
fn pictureSide(ui: *AppUi, picture: ?app.Picture, bytes: usize, label: []const u8, ink: canvas.Color) AppUi.Node {
    const shown = picture orelse return ui.column(.{ .grow = 1, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, 0, 14),
        smallText(ui, ui.fmt("{s} · could not be drawn", .{label}), theme.secondary),
    });
    const size = app.fitted(shown);
    return ui.column(.{ .grow = 1, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, 0, 14),
        ui.row(.{ .height = 18, .padding = 0, .gap = 0, .cross = .center }, .{
            ui.row(.{ .width = 6, .height = 6, .padding = 0, .style = .{ .background = ink, .radius = 3 } }, .{}),
            space(ui, 7, 0),
            smallText(ui, label, theme.ink),
            space(ui, 8, 0),
            smallText(ui, ui.fmt("{d} × {d} · {s}", .{ shown.width, shown.height, byteSize(ui, bytes) }), theme.secondary),
        }),
        space(ui, 0, 8),
        ui.column(.{ .width = size.width + 16, .height = size.height + 16, .padding = 8, .gap = 0, .style = .{ .background = theme.hunk, .border = theme.hairline, .stroke_width = 1, .radius = 8 } }, .{
            ui.image(.{ .width = size.width, .height = size.height, .image = shown.id }),
        }),
    });
}
/// What a binary file's pane shows: the picture before and after, side by
/// side (one side for an image added or deleted), or, for other binary
/// files, a line saying how their size changed.
fn mediaBlock(ui: *AppUi, model: *const Model, index: usize, height: f32) AppUi.Node {
    const file = model.files[index];
    const sides: patch.Sides = if (index < model.sources.len) model.sources[index] else .{};
    const old_bytes = if (sides.old) |text| text.bytes.len else 0;
    const new_bytes = if (sides.new) |text| text.bytes.len else 0;
    const images: app.ImageView = if (index < model.images.len) model.images[index] else .{};
    if (images.old == null and images.new == null) {
        const text = if (model.sources.len == 0) "Binary file" else switch (file.status) {
            .added => ui.fmt("Binary file added · {s}", .{byteSize(ui, new_bytes)}),
            .deleted => ui.fmt("Binary file deleted · {s}", .{byteSize(ui, old_bytes)}),
            else => if (sides.old != null and sides.new != null) ui.fmt("Binary file changed · {s} → {s}", .{ byteSize(ui, old_bytes), byteSize(ui, new_bytes) }) else "Binary file changed",
        };
        return ui.row(.{ .height = height, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.pane } }, .{
            ui.row(.{ .width = 48, .height = 24, .padding = 0, .main = .center, .cross = .center }, .{ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.line_number } }, if (app.isImage(file.path)) "image" else "document")}),
            smallText(ui, text, theme.secondary),
        });
    }
    const before = file.status != .added and (images.old != null or sides.old != null);
    const after = file.status != .deleted and (images.new != null or sides.new != null);
    return ui.row(.{ .height = height, .padding = 0, .gap = 16, .style = .{ .background = theme.pane } }, .{
        space(ui, 0, 0),
        if (before) pictureSide(ui, images.old, old_bytes, "Before", theme.red) else ui.spacer(0),
        if (before and after) ui.row(.{ .width = 1, .height = height - 24, .padding = 0, .style = .{ .background = theme.split_rule } }, .{}) else ui.spacer(0),
        if (after) pictureSide(ui, images.new, new_bytes, if (before) "After" else "Added", theme.green) else ui.spacer(0),
        space(ui, 0, 0),
    });
}
/// One 24-point slice of a binary file's block: the whole block, shifted up
/// by the slices above it and clipped, so a tall picture scrolls a row at a
/// time like code does.
fn mediaSlice(ui: *AppUi, model: *const Model, index: usize, slice: u16) AppUi.Node {
    const rows = app.mediaRows(model, index);
    const height = @as(f32, @floatFromInt(rows)) * 24;
    var block = mediaBlock(ui, model, index, height);
    block.widget.layout.grow = 0;
    block.key = .{ .str = ui.fmt("media-{d}-{d}", .{ index, slice }) };
    block.widget.transform = canvas.Affine.translate(0, -@as(f32, @floatFromInt(slice)) * 24);
    var clip = ui.column(.{ .height = 24, .padding = 0, .gap = 0 }, .{block});
    clip.widget.layout.clip_content = true;
    return clip;
}
/// A rounded end of a file pane, `height` points of pane color. The review
/// is built from 24-point rows, so a pane is assembled from row slices: its
/// header's top, the code rows, and its closing row's bottom. A one-sided end
/// is a taller rounded rectangle clipped to its slice, so the code rows meet
/// it square and no opaque corner masks are needed, which also rounds glass.
fn paneEdge(ui: *AppUi, height: f32, top: bool, bottom: bool) AppUi.Node {
    const radius = @min(theme.pane_radius, height / 2);
    if (top and bottom) return ui.row(.{ .grow = 1, .height = height, .padding = 0, .style = .{ .background = theme.pane, .radius = radius } }, .{});
    const shape = ui.row(.{ .grow = 1, .height = height + radius, .padding = 0, .transform = if (bottom) canvas.Affine.translate(0, -radius) else .{}, .style = .{ .background = theme.pane, .radius = radius } }, .{});
    var slice = ui.column(.{ .grow = 1, .height = height, .padding = 0, .gap = 0 }, .{shape});
    slice.widget.layout.clip_content = true;
    return slice;
}
/// A pill over one of the review's edges: the file being read pinned at the
/// top once its header scrolls under it (so a long file can be folded from
/// anywhere in it), and the status at the foot. Each is a slice of pane in
/// the pane's own color, so it reads as part of the diff: the pinned header
/// is its file's rounded top, and the status the rounded foot of the pane it
/// cuts (or, past the last file, a pane of its own). No row draws under a
/// pill, so glass panes stay even, and the pill sits in a layer above the
/// list's: code text paints after the fills in its own layer.
fn edgePill(ui: *AppUi, content: AppUi.Node, top: bool, bottom: bool) AppUi.Node {
    var pill = ui.stack(.{ .height = app.pill_height, .padding = 0 }, .{ paneEdge(ui, app.pill_height, top, bottom), content });
    pill.widget.layer = 200;
    return pill;
}
/// The part of a 24-point row from `from` to `to` points down it, the rest
/// clipped away, so nothing draws under an edge pill.
fn rowSlice(ui: *AppUi, node: AppUi.Node, top: f32, bottom: f32) AppUi.Node {
    const from = std.math.clamp(top, 0, 24);
    const to = std.math.clamp(bottom, 0, 24);
    if (to <= from) return ui.row(.{ .height = 24, .padding = 0 }, .{});
    if (from <= 0 and to >= 24) return node;
    var inner = node;
    inner.widget.layout.grow = 0;
    inner.widget.transform = canvas.Affine.translate(0, -from);
    var slice = ui.column(.{ .height = to - from, .padding = 0, .gap = 0 }, .{inner});
    slice.widget.layout.clip_content = true;
    return ui.column(.{ .height = 24, .padding = 0, .gap = 0 }, .{ space(ui, 0, from), slice, space(ui, 0, 24 - to) });
}
fn review(ui: *AppUi, model: *const Model) AppUi.Node {
    // Browsing with no file open: the rail lists them.
    if (browsing(model) and model.files.len > 0 and model.display.len == 0) return ui.column(.{ .grow = 1, .main = .center, .cross = .center, .gap = 12 }, .{
        ui.appIcon(.{ .width = 28, .height = 28, .style = .{ .foreground = theme.muted } }, "folder"),
        smallText(ui, "Choose a file in the rail to read it", theme.muted),
        ui.button(.{ .icon = "app:search", .size = .sm, .variant = .ghost, .on_press = .{ .action = .{ .action = .files } } }, "Go to file · ⌘P"),
    });
    if (model.files.len == 0) return ui.column(.{ .grow = 1, .main = .center, .cross = .center, .gap = 12 }, .{
        ui.appIcon(.{ .width = 28, .height = 28, .style = .{ .foreground = theme.muted } }, if (model.busy) "refresh" else "check"),
        smallText(ui, if (model.busy) "Loading…" else if (browsing(model)) "No files" else "No changes", theme.muted),
        ui.button(.{ .icon = "app:folder", .size = .sm, .variant = .ghost, .on_press = .open_repo }, "Open repository"),
    });
    const options = AppUi.VirtualListOptions{ .id = ui.fmt("review-{d}", .{model.generation}), .item_count = model.display.len, .item_extent = 24, .overscan = 1, .grow = 1, .semantics = .{ .label = "Changes" }, .on_scroll = AppUi.scrollMsg(.scrolled) };
    var window = ui.virtualWindow(options);
    if (model.jump_offset) |offset| {
        const viewport = @max(100, model.viewport_height);
        window = canvas.virtualListRange(.{ .item_count = model.display.len, .item_extent = 24, .viewport_extent = viewport, .scroll_offset = offset, .overscan = 1 });
    }
    var nodes: [100]AppUi.Node = undefined;
    var count: usize = 0;
    // A pane cut by either edge ends in the pill there: the rows stop at
    // the pill, whose rounded corners become the pane's.
    const offset = model.scroll_offset;
    const height = app.listHeight(model);
    const pinned = app.pinnedFile(model, offset);
    const bottom = app.bottomPill(model, offset, height);
    // Whether a pane runs on under the status pill, which then closes it.
    const cut = @as(f32, @floatFromInt(model.display.len)) * 24 - 3 - offset > height - app.pill_height;
    const top_edge: f32 = if (pinned != null) app.pill_height else -24;
    const bottom_edge: f32 = if (bottom) height - app.pill_height else std.math.inf(f32);
    for (model.display[window.start_index..window.end_index], window.start_index..) |entry, index| {
        if (count == nodes.len) break;
        const file = model.files[entry.file];
        const rows = if (model.split) file.split else file.unified;
        // A file's closing row ends its pane: the rounded bottom, then 3
        // points of ground before the next file's header.
        nodes[count] = if (entry.media > 0) mediaSlice(ui, model, entry.file, entry.media - 1) else if (entry.spacer) ui.column(.{ .height = 24, .padding = 0, .gap = 0 }, .{ paneEdge(ui, 21, false, true), space(ui, 0, 3) }) else if (entry.code) |code| blk: {
            const row = rows[code];
            // Hunks share their file's pane, parted by their headers, in the
            // code's own face: a quiet ellipsis in the gutter and the
            // enclosing declaration where the code begins. The full git
            // header stays as its label.
            if (row.meta) break :blk hunkHeader(ui, model, entry.file, rows, code, model.cursor_active and model.cursor == index);
            const language = syntax.languageFor(file.path);
            const current = model.cursor_active and model.cursor == index;
            const match = app.isMatch(model, index);
            const old = (model.cursor_old and row.old > 0) or row.new == 0;
            const pair = if (row.removed and row.added and row.moved_old == 0 and row.moved_new == 0) words.diff(row.left, row.right) else words.Pair{};
            // A moved block's first line on each side says where it went.
            const above = if (code > 0) rows[code - 1] else patch.Row{};
            const link_old = if (row.moved_old != 0 and above.moved_old != row.moved_old) row.moved_old else 0;
            const link_new = if (row.moved_new != 0 and above.moved_new != row.moved_new) row.moved_new else 0;
            const wash_old = if (row.base and row.removed) theme.hunk else if (row.moved_old != 0) theme.moved else if (row.removed) theme.removed else theme.background;
            const wash_new = if (row.base and row.added) theme.hunk else if (row.moved_new != 0) theme.moved else if (row.added) theme.added else theme.background;
            const content = if (model.split and !file.oneSided()) ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0, .style = .{ .background = theme.pane } }, .{
                codeCell(ui, model, row.left, row.old, true, entry.file, index, row.old_offset, wash_old, language, row.old_carry, current and old, match, pair.old.slice(), link_old),    line(ui, true),
                codeCell(ui, model, row.right, row.new, false, entry.file, index, row.new_offset, wash_new, language, row.new_carry, current and !old, match, pair.new.slice(), link_new),
            }) else ui.row(.{ .grow = 1, .height = 24, .padding = 0, .gap = 0, .style = .{ .background = theme.pane } }, .{
                codeCell(ui, model, if (row.removed) row.left else row.right, if (row.removed) row.old else row.new, row.removed, entry.file, index, if (row.removed) row.old_offset else row.new_offset, if (row.removed) wash_old else wash_new, language, if (row.removed) row.old_carry else row.new_carry, current, match, &.{}, if (row.removed) link_old else link_new),
            });
            break :blk content;
        } else fileHeader(ui, model, entry.file, model.cursor_active and model.cursor == index);
        const y = @as(f32, @floatFromInt(index)) * 24 - offset;
        nodes[count] = rowSlice(ui, nodes[count], top_edge - y, bottom_edge - y);
        const bar = model.mouse.active and !model.mouse.dragging and model.mouse.range != null and model.mouse.range.?.focus == index;
        const blamed = model.blame != null and model.blame.?.row == index;
        if (bar) {
            nodes[count] = ui.stack(.{ .key = .{ .index = index }, .height = 24, .padding = 0 }, .{ nodes[count], selectionBar(ui, model) });
        } else if (blamed) {
            nodes[count] = ui.stack(.{ .key = .{ .index = index }, .height = 24, .padding = 0 }, .{ nodes[count], blameCard(ui, model) });
        } else {
            nodes[count].key = .{ .index = index };
            nodes[count].widget.layout.grow = 0;
        }
        count += 1;
    }
    // The list is the review's ground; each file paints its own pane on it.
    var ground = ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{ui.virtualList(options, window, nodes[0..count])});
    ground.widget.layout.grow = 1;
    if (pinned == null and !bottom) return ground;
    var stacked = ui.stack(.{ .grow = 1, .padding = 0 }, .{ ground, ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{
        if (pinned) |file| edgePill(ui, headerRow(ui, model, file, false, app.pill_height), true, false) else ui.spacer(0),
        ui.spacer(1),
        if (bottom) edgePill(ui, statusRow(ui, model), !cut, true) else ui.spacer(0),
    }) });
    stacked.widget.layout.grow = 1;
    return stacked;
}
/// One note: where it sits, its state, its actions, and its text. An
/// outdated note quotes the lines it was left on, which have since changed;
/// a resolved one reads quietly. Notes from elsewhere name their file.
fn noteCard(ui: *AppUi, note: app.Note, index: usize, elsewhere: bool) AppUi.Node {
    const where = if (note.line_end > note.line) ui.fmt("{s}ines {d}–{d}", .{ if (note.old) "Old l" else "L", note.line, note.line_end }) else if (note.line > 0) ui.fmt("{s}ine {d}", .{ if (note.old) "Old l" else "L", note.line }) else "Whole file";
    const resolved = note.state == .resolved;
    const quoted = note.state == .outdated and note.excerpt.len > 0;
    var excerpt_lines: usize = 0;
    var excerpt_end: usize = 0;
    if (quoted) {
        // At most three lines of what it was left on.
        while (excerpt_end < note.excerpt.len and excerpt_lines < 3) : (excerpt_lines += 1) {
            excerpt_end = if (std.mem.indexOfScalarPos(u8, note.excerpt, excerpt_end, '\n')) |at| at + 1 else note.excerpt.len;
        }
    }
    const excerpt = std.mem.trimEnd(u8, note.excerpt[0..excerpt_end], "\n");
    return ui.column(.{ .key = .{ .index = index }, .padding = 12, .gap = 8, .on_press = if (elsewhere) null else Msg{ .goto_note = index }, .semantics = .{ .role = .button, .label = ui.fmt("Go to note on {s}", .{note.path}) }, .style = .{ .background = theme.background, .radius = 8 } }, .{
        ui.row(.{ .padding = 0, .cross = .center }, .{
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = if (resolved) theme.tertiary else theme.note } }, if (resolved) "check" else "note"),
            space(ui, 7, 0),
            smallText(ui, if (elsewhere) ui.fmt("{s} · {s}", .{ std.fs.path.basename(note.path), where }) else where, theme.muted),
            if (note.state != .open) space(ui, 7, 0) else ui.spacer(0),
            if (note.state == .outdated) smallText(ui, "Outdated", theme.note) else if (resolved) smallText(ui, "Resolved", theme.tertiary) else ui.spacer(0),
            ui.spacer(1),
            iconButton(ui, ui.fmt("resolve-{d}", .{index}), if (resolved) "left" else "check", if (resolved) "Reopen note" else "Resolve note", if (resolved) Msg{ .reopen_note = index } else Msg{ .resolve_note = index }, false, false),
            iconButton(ui, ui.fmt("edit-{d}", .{index}), "add", "Edit note", .{ .edit_note = index }, false, elsewhere),
            iconButton(ui, ui.fmt("delete-{d}", .{index}), "trash", "Delete note", .{ .delete_note = index }, false, false),
        }),
        if (quoted) ui.paragraph(.{ .wrap = false, .overflow = .clip, .semantics = .{ .label = ui.fmt("Was: {s}", .{excerpt}) }, .style = .{ .foreground = theme.tertiary } }, ui.arena.dupe(canvas.TextSpan, &.{.{ .text = excerpt, .monospace = true, .scale = 11.0 / 13.0 }}) catch &.{}) else ui.spacer(0),
        ui.text(.{ .wrap = true, .style = .{ .foreground = if (resolved) theme.tertiary else theme.ink } }, note.text),
    });
}
/// Every note in the review, grouped by file in review order: a file's name
/// jumps to it, a note to its line, and the file being read is marked.
/// Notes this view cannot place (on files no longer changed, or on commits a
/// rewrite dropped) follow under Elsewhere, so none is lost from sight.
fn notePanel(ui: *AppUi, model: *const Model) AppUi.Node {
    var nodes: [160]AppUi.Node = undefined;
    var count: usize = 0;
    for (model.files, 0..) |file, file_index| {
        var any = false;
        for (model.notes.items) |note| any = any or (std.mem.eql(u8, note.path, file.path) and app.inView(model, note));
        if (!any or count + 2 >= nodes.len) continue;
        const current = file_index == model.selected;
        const name = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = std.fs.path.basename(file.path), .weight = .medium }}) catch &.{};
        nodes[count] = ui.row(.{ .key = .{ .str = ui.fmt("notes-file-{d}", .{file_index}) }, .height = 26, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .select = file_index }, .semantics = .{ .role = .button, .label = ui.fmt("Go to {s}", .{file.path}) }, .style = .{ .background = if (current) theme.selected else theme.clear, .radius = 7 } }, .{
            space(ui, 6, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.muted } }, if (file.message) "note" else "document"),
            space(ui, 7, 0),
            ui.paragraph(.{ .height = 16, .wrap = false, .overflow = .clip, .style = .{ .foreground = if (current) theme.ink else theme.sidebar_ink } }, name),
            space(ui, 7, 0),
            ui.text(.{ .grow = 1, .size = .sm, .style = .{ .foreground = theme.tertiary } }, std.fs.path.dirname(file.path) orelse ""),
            space(ui, 6, 0),
        });
        count += 1;
        for (model.notes.items, 0..) |note, index| {
            if (!std.mem.eql(u8, note.path, file.path) or !app.inView(model, note) or count >= nodes.len) continue;
            nodes[count] = noteCard(ui, note, index, false);
            count += 1;
        }
    }
    var heading_shown = false;
    for (model.notes.items, 0..) |note, index| {
        if (count + 2 >= nodes.len) break;
        var placed = false;
        if (app.inView(model, note)) for (model.files) |file| {
            placed = placed or std.mem.eql(u8, file.path, note.path);
        };
        if (placed) continue;
        if (!heading_shown) {
            heading_shown = true;
            nodes[count] = ui.row(.{ .key = .{ .str = "notes-elsewhere" }, .height = 26, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, 6, 0), smallText(ui, "Elsewhere", theme.secondary) });
            count += 1;
        }
        nodes[count] = noteCard(ui, note, index, true);
        count += 1;
    }
    if (count == 0 and !model.editing) {
        nodes[0] = ui.column(.{ .padding = 16, .gap = 6, .cross = .center }, .{
            smallText(ui, "No notes yet", theme.secondary),
            caption(ui, "Select lines and press C to add one."),
        });
        count = 1;
    }
    return paneSurface(ui, "notes-pane", 0, .{
        ui.row(.{ .height = theme.pane_header, .padding = 0, .gap = 0, .cross = .center }, .{
            space(ui, 12, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.sidebar_ink } }, "comment"),
            space(ui, 8, 0),
            ui.text(.{ .grow = 1, .style = .{ .foreground = theme.ink } }, "Notes"),
            paneControl(ui, "new-note", "add", ui.fmt("Add file note · {s}", .{app.keyboard.shortcut(.comment_file)}), .add_note, false, false),
            paneControl(ui, "close-notes", "close", "Close notes", .toggle_notes, false, false),
            space(ui, 8, 0),
        }),
        // A scroll region holds one track; the cards flow down it.
        ui.scroll(.{ .grow = 1, .padding = 10, .gap = 0 }, .{ui.column(.{ .padding = 0, .gap = 8 }, ui.arena.dupe(AppUi.Node, nodes[0..count]) catch &.{})}),
        if (model.editing) ui.column(.{ .padding = 10, .gap = 8 }, .{
            smallText(ui, if (model.anchor.line_end > model.anchor.line) ui.fmt("{s}:{d}–{d}", .{ model.files[model.draft_file].path, model.anchor.line, model.anchor.line_end }) else if (model.anchor.line > 0) ui.fmt("{s}:{d}", .{ model.files[model.draft_file].path, model.anchor.line }) else model.files[model.draft_file].path, theme.muted),
            ui.el(.textarea, .{ .key = .{ .str = "draft" }, .height = 140, .text = model.draft.text(), .placeholder = "Leave a note…", .autofocus = model.focus == .note, .on_input = AppUi.inputMsg(.draft_edit), .on_submit = .save_note, .semantics = .{ .label = "Review note" }, .style = .{ .background = theme.field, .border = theme.clear, .radius = 10 } }, .{}),
            ui.row(.{ .padding = 0, .gap = 6, .main = .end }, .{
                iconButton(ui, "cancel-note", "close", "Cancel note", .cancel_note, false, false),
                iconButton(ui, "save-note", "check", spell("Save note · ⌘↵"), .save_note, true, model.draft.isEmpty()),
            }),
        }) else ui.spacer(0),
    });
}
/// A Rex pane: an opaque rounded surface. Its content clips to the pane's
/// rectangle: a rounded clip costs a frame of scroll latency, and nothing that
/// fills reaches the corners (the header and status rows have no fill).
fn paneSurface(ui: *AppUi, key: []const u8, width: f32, children: anytype) AppUi.Node {
    var surface = ui.column(.{ .key = .{ .str = key }, .width = width, .grow = if (width == 0) 1 else 0, .padding = 0, .gap = 0, .style = .{ .background = theme.pane, .radius = theme.pane_radius } }, children);
    surface.widget.layout.clip_content = true;
    if (theme.pane_edge.a == 0) return surface;
    // Glass panes carry a faint edge, as Rex's Modern material does. Only a
    // panel draws a border, so the solid panes skip the extra layer.
    var edged = ui.el(.panel, .{ .key = .{ .str = ui.fmt("{s}-edge", .{key}) }, .width = width, .grow = if (width == 0) 1 else 0, .padding = 0, .style = .{ .background = theme.clear, .border = theme.pane_edge, .stroke_width = 1, .radius = theme.pane_radius } }, .{surface});
    edged.widget.layout.grow = if (width == 0) 1 else 0;
    return edged;
}
/// The status pill's content. Left: the find field or where the cursor is;
/// right: panning and match counts.
fn statusRow(ui: *AppUi, model: *const Model) AppUi.Node {
    const matches = model.search_matches;
    var match_index: usize = 0;
    for (matches, 0..) |index, position| {
        if (index <= model.cursor) match_index = position + 1 else break;
    }
    const column_text = if (model.scroll_x > 0) ui.fmt("From column {d}", .{@as(usize, @intFromFloat(model.scroll_x / app.code_advance)) + 1}) else "";
    const position = model.cursor_active and !app.onFoldedHeader(model);
    const searching = model.focus == .search;
    const height = app.pill_height;
    return ui.row(.{ .grow = 1, .height = height, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, 12, 0),
        if (searching) ui.row(.{ .grow = 1, .height = height, .padding = 0, .gap = 0, .cross = .center }, .{
            ui.appIcon(.{ .width = 13, .height = 13, .style = .{ .foreground = theme.secondary } }, "find"),
            space(ui, 4, 0),
            ui.textField(.{ .key = .{ .str = "diff-search" }, .grow = 1, .height = height - 2, .text = model.search_query.text(), .placeholder = "Find in diff…", .autofocus = true, .on_input = AppUi.inputMsg(.search_edit), .on_submit = .search_accept, .semantics = .{ .label = "Find in diff" }, .variant = .ghost, .style = .{ .background = theme.clear, .border = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
        }) else if (position) smallText(ui, ui.fmt("Line {d} · {s}", .{ app.cursorNumber(model), if (app.cursorIsOld(model)) "old" else "new" }), theme.muted) else ui.spacer(0),
        if (searching) space(ui, 12, 0) else ui.spacer(1),
        if (column_text.len > 0) smallText(ui, column_text, theme.tertiary) else ui.spacer(0),
        if (column_text.len > 0 and model.search_query.len > 0) space(ui, 12, 0) else ui.spacer(0),
        if (model.search_query.len > 0) smallText(ui, ui.fmt("{d}/{d}", .{ match_index, matches.len }), if (matches.len == 0) theme.red else theme.muted) else ui.spacer(0),
        if (model.search_query.len > 0 and !searching) space(ui, 10, 0) else ui.spacer(0),
        if (model.search_query.len > 0 and !searching) smallText(ui, ui.fmt("{s} / {s}", .{ app.keyboard.shortcut(.match_next), app.keyboard.shortcut(.match_previous) }), theme.muted) else ui.spacer(0),
        space(ui, 12, 0),
    });
}
fn reviewTitle(ui: *AppUi, model: *const Model) []const u8 {
    if (model.imported) return model.repository;
    return switch (model.mode) {
        .working => "Working changes",
        .staged => "Staged changes",
        .files => "All files",
        // A commit under review on its own is titled by its subject.
        .branch => if (model.commit) |index| (if (index < model.commits.len) model.commits[index].subject() else "Commit") else if (model.head.len > 0 or model.compare_head.len > 0) ui.fmt("{s} since {s}", .{ headName(model), model.base.text() }) else ui.fmt("Changes since {s}", .{model.base.text()}),
    };
}
/// The pane is titled by the comparison under review, with its totals and progress.
fn paneHeader(ui: *AppUi, model: *const Model) AppUi.Node {
    var totals: struct { reviewed: usize = 0, additions: u32 = 0, deletions: u32 = 0, files: usize = 0 } = .{};
    for (model.files) |file| {
        if (file.reference) continue;
        totals.files += 1;
        totals.reviewed += @intFromBool(file.reviewed);
        totals.additions += file.additions;
        totals.deletions += file.deletions;
    }
    const changed = app.changedSince(model);
    // The title lives in the header layer above; this strip keeps notices and progress.
    return ui.row(.{ .height = theme.pane_header, .padding = 0, .gap = 0, .cross = .center, .window_drag = true }, .{
        ui.spacer(1),
        // Files reviewed in an earlier version: show only what changed since.
        if (changed > 0 or model.since_review) ui.button(.{ .key = .{ .str = "since-review" }, .height = 24, .size = .sm, .variant = .ghost, .on_press = .toggle_since, .semantics = .{ .label = if (model.since_review) "Show all changes" else "Show changes since review" }, .style = .{ .foreground = if (model.since_review) theme.ink else theme.note, .background = if (model.since_review) theme.segment_on else theme.clear, .border = if (model.since_review) theme.selected_edge else theme.clear, .stroke_width = 0.5, .radius = 12, .quiet_hover = true } }, if (model.since_review) "Since review" else if (changed == 1) "1 changed since review" else ui.fmt("{d} changed since review", .{changed})) else ui.spacer(0),
        space(ui, 12, 0),
        // Review progress: the check brightens once every file is done.
        if (model.files.len > 0 and !browsing(model)) ui.row(.{ .padding = 0, .gap = 5, .cross = .center, .semantics = .{ .label = "Review progress" } }, .{
            ui.appIcon(.{ .width = 13, .height = 13, .style = .{ .foreground = if (totals.reviewed == totals.files) theme.green else theme.tertiary } }, "check"),
            smallText(ui, ui.fmt("{d}/{d}", .{ totals.reviewed, totals.files }), theme.secondary),
        }) else ui.spacer(0),
        space(ui, 14, 0),
    });
}
fn reviewPane(ui: *AppUi, model: *const Model) AppUi.Node {
    // The review is no pane of its own: its title strip and the ground
    // between files are the window itself, flat like the rail, and each file
    // below is its own pane on it, as Rex stacks its splits. It clips to its
    // rectangle so scrolled panes slide under the title strip.
    var ground = ui.column(.{ .key = .{ .str = "review-pane" }, .grow = 1, .padding = 0, .gap = 0 }, .{
        paneHeader(ui, model),
        if (model.error_text.len > 0) ui.row(.{ .height = 32, .padding = 8, .cross = .center, .style = .{ .background = theme.removed } }, .{
            space(ui, 4, 0), smallText(ui, model.error_text, theme.red), ui.spacer(1), paneControl(ui, "dismiss", "close", "Dismiss", .dismiss, false, false),
        }) else ui.spacer(0),
        ui.column(.{ .key = .{ .str = ui.fmt("review-focus-{d}", .{model.focus_epoch}) }, .grow = 1, .padding = 0, .gap = 0, .autofocus = model.focus == .review, .semantics = .{ .role = .group, .label = "Review pane", .focusable = true }, .style = .{ .focus_ring = theme.clear } }, .{
            review(ui, model),
        }),
    });
    ground.widget.layout.clip_content = true;
    return ground;
}
/// Rex's keycap: the key in a thin outlined box beside its action.
fn keyHint(ui: *AppUi, label: []const u8, key: []const u8) AppUi.Node {
    return ui.row(.{ .padding = 0, .gap = 6, .cross = .center }, .{
        smallText(ui, label, theme.secondary),
        ui.el(.panel, .{ .height = 18, .padding = 0, .style = .{ .background = theme.clear, .border = theme.keycap, .stroke_width = 1, .radius = 5 } }, .{
            ui.row(.{ .height = 18, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, 5, 0), smallText(ui, key, theme.secondary), space(ui, 5, 0) }),
        }),
    });
}
/// One place a symbol appears: its line of code, then where it is, with
/// definitions marked.
fn symbolRow(ui: *AppUi, model: *const Model, index: usize, position: usize, active: bool) AppUi.Node {
    const hit = model.symbol_hits[index];
    const white = canvas.Color.rgb8(255, 255, 255);
    const in_review = for (model.files) |file| {
        if (!file.reference and std.mem.eql(u8, file.path, hit.path)) break true;
    } else false;
    const code = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = std.mem.trim(u8, hit.text, " \t"), .monospace = true, .scale = 12.0 / 13.0 }}) catch &.{};
    var text = ui.paragraph(.{ .height = 16, .wrap = false, .overflow = .clip, .style = .{ .foreground = if (active) white else theme.palette_ink } }, code);
    text.widget.layout.grow = 1;
    text.widget.layout.zero_intrinsic = true;
    return ui.row(.{ .key = .{ .index = position }, .height = theme.palette_row, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .palette_choose = position }, .semantics = .{ .role = .listitem, .label = ui.fmt("{s}:{d} {s}", .{ hit.path, hit.line, hit.text }) }, .style = .{ .background = if (active) theme.palette_active else theme.clear, .quiet_hover = true, .radius = 11 } }, .{
        space(ui, 11, 0),
        ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = if (active) white else if (hit.definition) theme.syntax_function else theme.palette_hint } }, if (hit.definition) "symbol" else if (in_review) "modified" else "document"),
        space(ui, 8, 0),
        text,
        space(ui, 10, 0),
        smallText(ui, ui.fmt("{s}{s}:{d}", .{ if (hit.definition) "definition · " else "", std.fs.path.basename(hit.path), hit.line }), if (active) canvas.Color.rgba8(255, 255, 255, 200) else theme.palette_hint),
        space(ui, 11, 0),
    });
}
/// Who last changed a line and why, in a small card under it.
fn blameCard(ui: *AppUi, model: *const Model) AppUi.Node {
    const shown = model.blame.?;
    const info = shown.info;
    var age_buffer: [32]u8 = undefined;
    const now = std.Io.Clock.real.now(app.ioHandle()).toSeconds();
    const short = info.commit[0..@min(8, info.commit.len)];
    const head = if (shown.loading) "Reading blame…" else if (shown.failed) "Git could not blame this line" else if (info.uncommitted) "Not committed yet" else ui.fmt("{s} · {s}", .{ info.author, @import("lookup.zig").ago(&age_buffer, info.time, now) });
    const summary = if (shown.loading or shown.failed) "" else if (info.uncommitted) "This line is only in the working tree." else info.summary;
    const commit = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = short, .monospace = true }}) catch &.{};
    const card_node = ui.el(.popover, .{ .width = 420, .padding = 10, .anchor = .below, .anchor_alignment = .start, .anchor_offset = 4, .on_dismiss = .close_blame, .semantics = .{ .role = .dialog, .label = ui.fmt("Blame for line {d}", .{shown.line}) }, .style = .{ .background = theme.menu, .border = theme.glass_edge, .stroke_width = 0.5, .radius = 12 } }, .{ui.column(.{ .padding = 0, .gap = 6 }, .{
        ui.row(.{ .height = 20, .padding = 0, .gap = 0, .cross = .center }, .{
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.secondary } }, "history"),
            space(ui, 8, 0),
            if (!shown.loading and !shown.failed and !info.uncommitted) ui.paragraph(.{ .height = 16, .size = .sm, .wrap = false, .style = .{ .foreground = theme.syntax_constant } }, commit) else ui.spacer(0),
            if (!shown.loading and !shown.failed and !info.uncommitted) space(ui, 8, 0) else ui.spacer(0),
            ui.text(.{ .grow = 1, .size = .sm, .style = .{ .foreground = theme.secondary } }, head),
            if (!shown.loading and !shown.failed and !info.uncommitted) tinted(ui, "copy-commit", "copy", "Copy commit id", .{ .copy_text = info.commit }, theme.tertiary, false, 22) else ui.spacer(0),
            tinted(ui, "close-blame", "close", "Close · esc", .close_blame, theme.tertiary, false, 22),
        }),
        if (summary.len > 0) ui.text(.{ .wrap = true, .style = .{ .foreground = theme.ink } }, summary) else ui.spacer(0),
    })});
    return ui.row(.{ .height = 24, .padding = 0, .gap = 0 }, .{ space(ui, if (shown.old or !model.split) 56 else model.canvas_width / 2 - 100, 0), ui.stack(.{ .width = 420, .height = 24, .padding = 0 }, .{card_node}), ui.spacer(1) });
}
/// Rex's palette: a frosted 330-point surface near the top of the window, a
/// capsule search field, 28-point rows, and keycap hints at its foot.
fn palette(ui: *AppUi, model: *const Model) AppUi.Node {
    const files = model.palette == .files;
    const symbols = model.palette == .symbols;
    const row_h = theme.palette_row;
    const height = @min(theme.palette_rows * row_h, @as(f32, @floatFromInt(model.choice_count)) * row_h);
    const options = AppUi.VirtualListOptions{ .id = "palette-results", .item_count = model.choice_count, .item_extent = row_h, .height = height, .overscan = 1, .semantics = .{ .label = "Results" }, .on_scroll = AppUi.scrollMsg(.palette_scrolled) };
    const window = canvas.virtualListRange(.{ .item_count = model.choice_count, .item_extent = row_h, .viewport_extent = height, .scroll_offset = model.palette_offset, .overscan = 1 });
    var rows: [16]AppUi.Node = undefined;
    var count: usize = 0;
    for (window.start_index..window.end_index) |position| {
        if (count == rows.len) break;
        const item = model.choices[position];
        const active = position == model.choice_selected;
        if (symbols) {
            rows[count] = symbolRow(ui, model, item.index, position, active);
            count += 1;
            continue;
        }
        const command = if (!item.file) app.keyboard.commands[item.index] else null;
        const title = if (item.file) std.fs.path.basename(model.files[item.index].path) else command.?.title;
        const detail = if (item.file) std.fs.path.dirname(model.files[item.index].path) orelse "" else app.keyboard.shortcut(command.?.action);
        rows[count] = ui.row(.{ .key = .{ .index = position }, .height = row_h, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .palette_choose = position }, .semantics = .{ .role = .listitem, .label = if (item.file) model.files[item.index].path else title }, .style = .{ .background = if (active) theme.palette_active else theme.clear, .quiet_hover = true, .radius = 11 } }, .{
            space(ui, 11.5, 0),
            ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) canvas.Color.rgb8(255, 255, 255) else theme.palette_ink } }, title),
            smallText(ui, detail, if (active) canvas.Color.rgba8(255, 255, 255, 200) else theme.palette_hint),
            space(ui, 11, 0),
        });
        count += 1;
    }
    // It fades in and settles a few points down as it opens.
    const surface = ui.el(.popover, .{ .key = .{ .str = "command-palette" }, .opacity = model.palette_fade, .transform = if (model.palette_fade < 1) canvas.Affine.translate(0, -6 * (1 - model.palette_fade)) else .{}, .width = if (symbols) 560 else theme.palette_width, .anchor = .below, .anchor_alignment = .start, .anchor_offset = 0, .padding = 5, .backdrop_blur_token = if (theme.native_blur) .md else null, .on_dismiss = .close_palette, .semantics = .{ .role = .dialog, .label = if (symbols) "Symbols" else if (files) "Go to file" else "Commands" }, .style = .{ .background = theme.paletteFill(), .border = theme.glass_edge, .radius = 16 } }, .{ui.column(.{ .padding = 0, .gap = 0 }, .{
        ui.row(.{ .height = 30, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.palette_field, .radius = 15 } }, .{
            space(ui, 11, 0),
            ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.secondary } }, "find"),
            space(ui, 1, 0),
            ui.textField(.{ .key = .{ .str = "palette-query" }, .grow = 1, .height = 26, .text = model.palette_query.text(), .placeholder = if (symbols) "Find a symbol…" else if (files) "Search files…" else "Search commands and files…", .autofocus = true, .on_input = AppUi.inputMsg(.palette_edit), .on_submit = .palette_accept, .semantics = .{ .label = if (symbols) "Symbol search" else if (files) "File picker" else "Command search" }, .variant = .ghost, .style = .{ .background = theme.clear, .border = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
            space(ui, 8, 0),
        }),
        space(ui, 0, 10),
        if (count > 0) ui.virtualList(options, window, rows[0..count]) else ui.row(.{ .height = 56, .padding = 0, .main = .center, .cross = .center }, .{smallText(ui, if (!symbols) "No matches" else if (model.symbol_busy) "Searching…" else if (std.mem.trim(u8, model.palette_query.text(), " ").len < 2) "Type a name to find where it is defined and used" else "No definitions or uses found", theme.secondary)}),
        space(ui, 0, 5),
        ui.row(.{ .height = 1, .padding = 0, .style = .{ .background = theme.hairline } }, .{}),
        ui.row(.{ .height = 28, .padding = 0, .gap = 0, .cross = .center, .semantics = .{ .label = "Palette hints", .role = .group } }, .{
            ui.spacer(1),
            keyHint(ui, "Close", "esc"),
            space(ui, 14, 0),
            if (count > 0) keyHint(ui, if (files or symbols) "Open" else "Run", "↩") else ui.spacer(0),
            space(ui, 9.5, 0),
        }),
    })});
    // Anchored just below a zero-height marker, centered, 75 points down: Rex's spot.
    return ui.column(.{ .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, 0, theme.palette_top),
        ui.stack(.{ .width = theme.palette_width, .height = 0, .padding = 0 }, .{surface}),
    });
}

// Settings, in Rex's manner: a list of sections beside grouped cards whose rows
// pair a title and a quiet description with a trailing control.
const Section = app.SettingsSection;
/// A section's icon: a gradient squircle drawn as an image, as macOS and Rex
/// draw theirs.
fn tile(ui: *AppUi, icon: usize, size: f32) AppUi.Node {
    return ui.image(.{ .width = size, .height = size, .image = app.settings_icon_base + icon });
}
fn sectionInfo(section: Section) struct { title: []const u8, icon: usize } {
    return switch (section) {
        .review => .{ .title = "Review", .icon = 0 },
        .layout => .{ .title = "Layout", .icon = 1 },
        .appearance => .{ .title = "Appearance", .icon = 4 },
        .keyboard => .{ .title = "Keyboard", .icon = 2 },
        .about => .{ .title = "About", .icon = 3 },
    };
}
fn sectionRow(ui: *AppUi, model: *const Model, section: Section) AppUi.Node {
    const info = sectionInfo(section);
    const active = model.settings_section == section;
    return ui.row(.{ .key = .{ .str = info.title }, .height = 32, .padding = 0, .gap = 0, .cross = .center, .on_press = .{ .settings_section = section }, .semantics = .{ .label = info.title, .role = .listitem }, .style = .{ .background = if (active) theme.selected else theme.clear, .border = if (active) theme.selected_edge else theme.clear, .stroke_width = 0.5, .radius = 8 } }, .{
        space(ui, 8, 0),
        tile(ui, info.icon, 22),
        space(ui, 10, 0),
        ui.text(.{ .grow = 1, .style = .{ .foreground = if (active) theme.ink else theme.sidebar_ink } }, info.title),
    });
}
fn caption(ui: *AppUi, text: []const u8) AppUi.Node {
    return ui.paragraph(.{ .wrap = true, .style = .{ .foreground = theme.secondary } }, ui.arena.dupe(canvas.TextSpan, &.{.{ .text = text, .scale = 11.0 / 13.0 }}) catch &.{});
}
fn heading(ui: *AppUi, text: []const u8) AppUi.Node {
    // Rex: section titles at row-title size, set heavier, with more room above
    // (28 points) than below (8), so each section reads as its own group.
    return ui.column(.{ .padding = 0, .gap = 0 }, .{
        space(ui, 0, 28),
        ui.row(.{ .height = 18, .padding = 0, .gap = 0, .cross = .center }, .{
            space(ui, 2, 0),
            ui.paragraph(.{ .height = 18, .wrap = false, .style = .{ .foreground = theme.ink } }, ui.arena.dupe(canvas.TextSpan, &.{.{ .text = text, .weight = .medium }}) catch &.{}),
        }),
        space(ui, 0, 8),
    });
}
fn settingRow(ui: *AppUi, title: []const u8, detail: []const u8, control: AppUi.Node) AppUi.Node {
    return ui.row(.{ .key = .{ .str = title }, .padding = 0, .gap = 0, .cross = .center }, .{
        space(ui, 14, 0),
        ui.column(.{ .grow = 1, .padding = 0, .gap = 2 }, .{
            space(ui, 0, 11),
            ui.text(.{ .style = .{ .foreground = theme.ink } }, title),
            if (detail.len > 0) caption(ui, detail) else ui.spacer(0),
            space(ui, 0, 11),
        }),
        space(ui, 12, 0),
        control,
        space(ui, 14, 0),
    });
}
fn divider(ui: *AppUi) AppUi.Node {
    return ui.row(.{ .height = 1, .padding = 0, .gap = 0 }, .{ space(ui, 14, 0), ui.row(.{ .grow = 1, .height = 1, .padding = 0, .style = .{ .background = theme.settings_divider } }, .{}), space(ui, 14, 0) });
}
fn card(ui: *AppUi, rows: []const AppUi.Node) AppUi.Node {
    var nodes: [2 * app.keyboard.commands.len]AppUi.Node = undefined;
    var count: usize = 0;
    for (rows, 0..) |row, index| {
        if (count + 2 > nodes.len) break;
        if (index > 0) {
            nodes[count] = divider(ui);
            count += 1;
        }
        nodes[count] = row;
        count += 1;
    }
    return ui.column(.{ .padding = 0, .gap = 0, .style = .{ .background = theme.card, .radius = 12 } }, ui.arena.dupe(AppUi.Node, nodes[0..count]) catch &.{});
}
/// Rex's switch: a theme.red accent track when on, a quiet track when off, white knob.
fn toggle(ui: *AppUi, label: []const u8, on: bool, msg: Msg) AppUi.Node {
    const knob = ui.row(.{ .width = 14, .height = 14, .padding = 0, .style = .{ .background = canvas.Color.rgb8(244, 244, 244), .radius = 7 } }, .{});
    return ui.row(.{ .key = .{ .str = label }, .width = 30, .height = 18, .padding = 2, .gap = 0, .cross = .center, .on_press = msg, .semantics = .{ .label = label, .role = .checkbox }, .style = .{ .background = if (on) theme.accent else theme.switch_off, .radius = 9 } }, if (on) .{ ui.spacer(1), knob } else .{ knob, ui.spacer(1) });
}
fn choice(ui: *AppUi, label: []const u8, active: bool, msg: Msg) AppUi.Node {
    return ui.button(.{ .height = 22, .size = .sm, .variant = .ghost, .on_press = msg, .semantics = .{ .label = label }, .style = .{ .foreground = if (active) theme.ink else theme.sidebar_ink, .background = if (active) theme.segment_on else theme.clear, .border = if (active) theme.selected_edge else theme.clear, .stroke_width = 0.5, .radius = 11, .quiet_hover = true } }, label);
}
fn choices(ui: *AppUi, nodes: anytype) AppUi.Node {
    return ui.row(.{ .height = 26, .padding = 2, .gap = 2, .cross = .center, .style = .{ .background = theme.field, .radius = 13 } }, nodes);
}
fn keycap(ui: *AppUi, text: []const u8) AppUi.Node {
    return ui.row(.{ .height = 20, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.field, .radius = 5 } }, .{ space(ui, 7, 0), smallText(ui, text, theme.sidebar_ink), space(ui, 7, 0) });
}
/// Each key bound to a command on its own cap, side by side.
fn keycaps(ui: *AppUi, keys: []const u8) AppUi.Node {
    var caps: [4]AppUi.Node = undefined;
    var count: usize = 0;
    var parts = std.mem.splitSequence(u8, keys, "  ");
    while (parts.next()) |part| {
        if (count == caps.len) break;
        caps[count] = keycap(ui, part);
        count += 1;
    }
    return ui.row(.{ .padding = 0, .gap = 4, .cross = .center }, ui.arena.dupe(AppUi.Node, caps[0..count]) catch &.{});
}
/// A theme as a card: a little review in its own colors (a title, a removed
/// and an added line, its accent), then its name. The chosen one is ringed.
fn themeSwatch(ui: *AppUi, model: *const Model, index: usize) AppUi.Node {
    const scheme = theme.schemes[index];
    const selected = model.theme_index == index;
    const bar = struct {
        fn of(u: *AppUi, color: canvas.Color, width: f32) AppUi.Node {
            return u.row(.{ .height = 6, .padding = 0, .gap = 0 }, .{ space(u, 10, 0), u.row(.{ .width = width, .height = 6, .padding = 0, .style = .{ .background = color, .radius = 3 } }, .{}) });
        }
    }.of;
    const mixed = struct {
        fn of(a: canvas.Color, b: canvas.Color, t: f32) canvas.Color {
            return .{ .r = a.r + (b.r - a.r) * t, .g = a.g + (b.g - a.g) * t, .b = a.b + (b.b - a.b) * t, .a = 1 };
        }
    }.of;
    const title = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = "Aa", .weight = .medium }}) catch &.{};
    var swatch = ui.el(.panel, .{ .key = .{ .str = scheme.id }, .grow = 1, .padding = 4, .on_press = .{ .set_theme = index }, .semantics = .{ .role = .button, .label = ui.fmt("{s} theme", .{scheme.name}) }, .style = .{ .background = theme.card, .border = if (selected) theme.accent else theme.hairline, .stroke_width = if (selected) 2 else 1, .radius = 12 } }, .{ui.column(.{ .padding = 0, .gap = 6 }, .{
        ui.column(.{ .height = 58, .padding = 0, .gap = 5, .style = .{ .background = scheme.background, .radius = 8 } }, .{
            space(ui, 0, 4),
            ui.row(.{ .height = 18, .padding = 0, .gap = 0, .cross = .center }, .{
                space(ui, 10, 0),
                ui.paragraph(.{ .height = 16, .wrap = false, .style = .{ .foreground = scheme.foreground } }, title),
                ui.spacer(1),
                ui.row(.{ .width = 8, .height = 8, .padding = 0, .style = .{ .background = scheme.accent, .radius = 4 } }, .{}),
                space(ui, 10, 0),
            }),
            bar(ui, mixed(scheme.background, scheme.red, 0.55), 64),
            bar(ui, mixed(scheme.background, scheme.green, 0.55), 92),
        }),
        ui.row(.{ .height = 18, .padding = 0, .gap = 0, .cross = .center }, .{
            space(ui, 10, 0),
            ui.text(.{ .grow = 1, .size = .sm, .style = .{ .foreground = if (selected) theme.ink else theme.sidebar_ink } }, scheme.name),
            smallText(ui, if (scheme.dark) "Dark" else "Light", theme.tertiary),
            space(ui, 10, 0),
        }),
    })});
    swatch.widget.layout.grow = 1;
    return swatch;
}
fn themeGrid(ui: *AppUi, model: *const Model) AppUi.Node {
    const columns = 3;
    var rows: [(theme.schemes.len + columns - 1) / columns]AppUi.Node = undefined;
    for (&rows, 0..) |*row, r| {
        var cells: [columns]AppUi.Node = undefined;
        for (&cells, 0..) |*cell, c| {
            const index = r * columns + c;
            cell.* = if (index < theme.schemes.len) themeSwatch(ui, model, index) else ui.spacer(1);
        }
        row.* = ui.row(.{ .padding = 0, .gap = 10 }, ui.arena.dupe(AppUi.Node, &cells) catch &.{});
    }
    return ui.column(.{ .padding = 0, .gap = 10 }, ui.arena.dupe(AppUi.Node, &rows) catch &.{});
}
/// One override color: its swatch, then a hex field whose placeholder is the
/// theme's own value.
fn colorRow(ui: *AppUi, model: *const Model, index: usize) AppUi.Node {
    const scheme = app.activeScheme(model);
    const base = theme.schemes[model.theme_index];
    const own = switch (index) {
        0 => base.background,
        1 => base.foreground,
        2 => base.accent,
        3 => base.green,
        else => base.red,
    };
    const shown = switch (index) {
        0 => scheme.background,
        1 => scheme.foreground,
        2 => scheme.accent,
        3 => scheme.green,
        else => scheme.red,
    };
    var hex_buffer: [7]u8 = undefined;
    const placeholder = ui.fmt("{s}", .{theme.formatHex(&hex_buffer, own)});
    const on_input = switch (index) {
        0 => AppUi.inputMsg(.color0_edit),
        1 => AppUi.inputMsg(.color1_edit),
        2 => AppUi.inputMsg(.color2_edit),
        3 => AppUi.inputMsg(.color3_edit),
        else => AppUi.inputMsg(.color4_edit),
    };
    const role = app.color_roles[index];
    return settingRow(ui, role, if (model.colors[index].len > 0) "Your color, over the theme's." else "The theme's own.", ui.row(.{ .padding = 0, .gap = 8, .cross = .center }, .{
        ui.row(.{ .width = 18, .height = 18, .padding = 0, .style = .{ .background = shown, .border = theme.hairline, .stroke_width = 1, .radius = 5 } }, .{}),
        ui.row(.{ .width = 96, .height = 26, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.field, .radius = 7 } }, .{
            space(ui, 8, 0),
            ui.textField(.{ .key = .{ .str = ui.fmt("color-{d}", .{index}) }, .grow = 1, .height = 24, .text = model.colors[index].text(), .placeholder = placeholder, .on_input = on_input, .semantics = .{ .label = ui.fmt("{s} color", .{role}) }, .variant = .ghost, .style = .{ .background = theme.clear, .border = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
        }),
    }));
}
fn settingsBody(ui: *AppUi, model: *const Model) AppUi.Node {
    return switch (model.settings_section) {
        .review => ui.column(.{ .padding = 0, .gap = 0 }, .{
            heading(ui, "Reviewing"),
            card(ui, &.{
                settingRow(ui, "Fold reviewed files", "Marking a file reviewed folds it to its header, so what is left to read stays in view.", toggle(ui, "Fold reviewed files", model.collapse_reviewed, .toggle_fold_setting)),
                settingRow(ui, "Fold generated files", "Lockfiles and paths marked linguist-generated open folded to their headers.", toggle(ui, "Fold generated files", model.fold_generated, .toggle_generated_setting)),
                settingRow(ui, "Diff layout", spell("How changes are laid out. ⌘\\ switches while you review."), choices(ui, .{ choice(ui, "Split", model.split, .{ .default_split = true }), choice(ui, "Unified", !model.split, .{ .default_split = false }) })),
            }),
            heading(ui, "Comparison"),
            card(ui, &.{
                settingRow(ui, "Open with", "What Patch shows when it opens a repository: a comparison to review, or all its files to read.", choices(ui, .{ choice(ui, "Files", model.default_mode == .files, .{ .default_mode = .files }), choice(ui, "Changes", model.default_mode == .working, .{ .default_mode = .working }), choice(ui, "Staged", model.default_mode == .staged, .{ .default_mode = .staged }), choice(ui, "Branch", model.default_mode == .branch, .{ .default_mode = .branch }) })),
                settingRow(ui, "Ignore whitespace", "Hide changes that only add, remove or re-indent whitespace. Also in the command palette.", toggle(ui, "Ignore whitespace", model.ignore_whitespace, .toggle_whitespace)),
                settingRow(ui, "Diff algorithm", "Histogram often lines up rewritten code more readably than Git's default.", choices(ui, .{ choice(ui, "Default", model.algorithm == .default, .{ .set_algorithm = .default }), choice(ui, "Histogram", model.algorithm == .histogram, .{ .set_algorithm = .histogram }), choice(ui, "Patience", model.algorithm == .patience, .{ .set_algorithm = .patience }) })),
                settingRow(ui, "Base branch", "Branch comparisons start from the merge base with this branch.", ui.row(.{ .width = 150, .height = 26, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.field, .radius = 13 } }, .{
                    ui.textField(.{ .key = .{ .str = "settings-base" }, .grow = 1, .height = 24, .text = model.base.text(), .placeholder = "main", .on_input = AppUi.inputMsg(.base_edit), .semantics = .{ .label = "Default base branch" }, .variant = .ghost, .style = .{ .border = theme.clear, .background = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
                })),
            }),
        }),
        .layout => ui.column(.{ .padding = 0, .gap = 0 }, .{
            heading(ui, "Window"),
            card(ui, &.{
                settingRow(ui, "Show file rail", spell("The list of changed files beside the review. ⌘B toggles it."), toggle(ui, "Show file rail", model.sidebar, .toggle_rail_setting)),
                settingRow(ui, "Pane widths", ui.fmt("Rail {d:.0} pt · Notes {d:.0} pt. Drag the gap between panes to resize them.", .{ model.sidebar_width, model.notes_width }), ui.button(.{ .height = 26, .size = .sm, .variant = .ghost, .on_press = .reset_widths, .semantics = .{ .label = "Reset pane widths" }, .style = .{ .foreground = theme.ink, .background = theme.segment_on, .radius = 13 } }, "Reset")),
            }),
        }),
        .keyboard => blk: {
            // One card per group, in the order a review goes.
            const groups = std.enums.values(app.keyboard.Group);
            var sections: [2 * groups.len + 2]AppUi.Node = undefined;
            var section_count: usize = 0;
            for (groups) |group| {
                var rows: [app.keyboard.commands.len]AppUi.Node = undefined;
                var count: usize = 0;
                for (app.keyboard.commands) |item| {
                    const keys = app.keyboard.keysFor(item.action);
                    if (item.group != group or keys.len == 0) continue;
                    rows[count] = settingRow(ui, item.title, "", keycaps(ui, keys));
                    count += 1;
                }
                if (count == 0) continue;
                sections[section_count] = heading(ui, group.title());
                sections[section_count + 1] = card(ui, ui.arena.dupe(AppUi.Node, rows[0..count]) catch &.{});
                section_count += 2;
            }
            sections[section_count] = space(ui, 0, 12);
            section_count += 1;
            sections[section_count] = ui.row(.{ .padding = 0, .gap = 0 }, .{ space(ui, 2, 0), ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{caption(ui, spell("Arrows move through the review and Return acts on the line you are on; the rest take ⌘. Keys wait while you type in a field, except the ⌘ keys that open, find and switch. Every command is also in the palette, ⌘K."))}) });
            section_count += 1;
            break :blk ui.column(.{ .padding = 0, .gap = 0 }, ui.arena.dupe(AppUi.Node, sections[0..section_count]) catch &.{});
        },
        .appearance => ui.column(.{ .padding = 0, .gap = 0 }, .{
            heading(ui, "Theme"),
            themeGrid(ui, model),
            // Glass needs the native blur only macOS has under the window.
            if (theme.native_blur) heading(ui, "Panes") else ui.spacer(0),
            if (theme.native_blur) card(ui, &.{
                settingRow(ui, "Material", "Glass lets the window's blur show through the review and the notes.", choices(ui, .{ choice(ui, "Solid", !model.glass_panes, .{ .set_glass = false }), choice(ui, "Glass", model.glass_panes, .{ .set_glass = true }) })),
            }) else ui.spacer(0),
            heading(ui, "Colors"),
            card(ui, &.{
                colorRow(ui, model, 0),
                colorRow(ui, model, 1),
                colorRow(ui, model, 2),
                colorRow(ui, model, 3),
                colorRow(ui, model, 4),
                settingRow(ui, "Reset colors", "Return every color to the theme's own.", ui.button(.{ .height = 26, .size = .sm, .variant = .ghost, .on_press = .reset_colors, .semantics = .{ .label = "Reset colors" }, .style = .{ .foreground = theme.ink, .background = theme.segment_on, .radius = 13 } }, "Reset")),
            }),
            space(ui, 0, 8),
        }),
        .about => ui.column(.{ .padding = 0, .gap = 0 }, .{
            space(ui, 0, 18),
            card(ui, &.{
                ui.row(.{ .height = 72, .padding = 0, .gap = 0, .cross = .center }, .{
                    space(ui, 14, 0),
                    tile(ui, 5, 40),
                    space(ui, 14, 0),
                    ui.column(.{ .grow = 1, .padding = 0, .gap = 2 }, .{
                        ui.paragraph(.{ .height = 18, .wrap = false, .style = .{ .foreground = theme.ink } }, ui.arena.dupe(canvas.TextSpan, &.{.{ .text = "Patch", .weight = .medium }}) catch &.{}),
                        caption(ui, "Version 0.1.0 · Local code review. Git access is read-only."),
                    }),
                }),
            }),
            heading(ui, "Data"),
            card(ui, &.{
                settingRow(ui, "Review progress and notes", "Saved on this Mac for each repository. A reviewed change stays reviewed wherever it appears again, a rebase included; notes follow their lines as files change.", ui.button(.{ .height = 26, .size = .sm, .variant = .ghost, .on_press = .copy_data_path, .semantics = .{ .label = "Copy data folder path" }, .style = .{ .foreground = theme.ink, .background = theme.segment_on, .radius = 13 } }, "Copy Path")),
            }),
        }),
    };
}
fn sectionMatches(model: *const Model, section: Section) bool {
    const query = model.settings_query.text();
    if (query.len == 0) return true;
    return std.ascii.indexOfIgnoreCase(sectionInfo(section).title, query) != null;
}
/// The Settings window, in Rex's arrangement: an inset sidebar panel holding the
/// traffic lights, a search capsule and the sections; the section's cards beside it.
pub fn settingsWindow(ui: *AppUi, model: *const Model) AppUi.Node {
    const info = sectionInfo(model.settings_section);
    const sections = [_]Section{ .review, .layout, .appearance, .keyboard, .about };
    var rows: [sections.len]AppUi.Node = undefined;
    var count: usize = 0;
    for (sections) |section| if (sectionMatches(model, section)) {
        rows[count] = sectionRow(ui, model, section);
        count += 1;
    };
    const title = ui.arena.dupe(canvas.TextSpan, &.{.{ .text = info.title, .weight = .medium, .scale = 17.0 / 13.0 }}) catch &.{};
    var panel = ui.el(.panel, .{ .width = 200, .grow = 0, .padding = 0, .style = .{ .background = theme.settings_panel, .border = theme.hairline, .stroke_width = 0.5, .radius = 12 } }, .{
        ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{
            ui.row(.{ .height = 42, .padding = 0, .window_drag = true }, .{}),
            ui.row(.{ .height = 30, .padding = 0, .gap = 0, .cross = .center }, .{
                space(ui, 8, 0),
                ui.row(.{ .grow = 1, .height = 30, .padding = 0, .gap = 0, .cross = .center, .style = .{ .background = theme.field, .radius = 15 } }, .{
                    space(ui, 11, 0),
                    ui.appIcon(.{ .width = 14, .height = 14, .style = .{ .foreground = theme.tertiary } }, "find"),
                    space(ui, 1, 0),
                    ui.textField(.{ .key = .{ .str = "settings-search" }, .grow = 1, .height = 24, .text = model.settings_query.text(), .placeholder = "Search Settings", .on_input = AppUi.inputMsg(.settings_search_edit), .semantics = .{ .label = "Search Settings" }, .variant = .ghost, .style = .{ .border = theme.clear, .background = theme.clear, .focus_ring = theme.clear, .radius = 0 } }),
                    space(ui, 8, 0),
                }),
                space(ui, 8, 0),
            }),
            space(ui, 0, 10),
            ui.row(.{ .padding = 0, .gap = 0 }, .{ space(ui, 8, 0), ui.column(.{ .grow = 1, .padding = 0, .gap = 2, .semantics = .{ .label = "Settings sections", .role = .list } }, ui.arena.dupe(AppUi.Node, rows[0..count]) catch &.{}), space(ui, 8, 0) }),
        }),
    });
    panel.widget.layout.clip_content = true;
    return ui.stack(.{ .padding = 0, .style = .{ .background = theme.settings_bg, .foreground = theme.ink, .radius = 0 } }, .{
        ui.row(.{ .padding = 0, .gap = 0 }, .{
            ui.column(.{ .padding = 0, .gap = 0 }, .{ space(ui, 0, 8), ui.row(.{ .grow = 1, .padding = 0, .gap = 0 }, .{ space(ui, 8, 0), panel }), space(ui, 0, 8) }),
            ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{
                ui.row(.{ .height = 50, .padding = 0, .gap = 0, .cross = .center, .window_drag = true }, .{
                    space(ui, 24, 0),
                    ui.paragraph(.{ .height = 24, .wrap = false, .style = .{ .foreground = theme.ink } }, title),
                }),
                ui.scroll(.{ .grow = 1, .padding = 0, .gap = 0 }, .{
                    ui.row(.{ .padding = 0, .gap = 0 }, .{
                        space(ui, 22, 0),
                        ui.column(.{ .grow = 1, .max_width = 640, .padding = 0, .gap = 0 }, .{ settingsBody(ui, model), space(ui, 0, 24) }),
                        space(ui, 22, 0),
                    }),
                }),
            }),
        }),
    });
}
/// Notices float as a frosted capsule at the foot of the review, as Rex's do.
fn toast(ui: *AppUi, model: *const Model) AppUi.Node {
    const left = model.rail_shown + theme.pane_inset;
    const right = theme.pane_inset + (if (model.notes_shown > 0) model.notes_shown + theme.pane_inset else 0);
    var pill = ui.el(.panel, .{ .height = 30, .padding = 0, .semantics = .{ .role = .group, .label = model.notice }, .style = .{ .background = theme.menu, .border = theme.glass_edge, .stroke_width = 0.5, .radius = 15 } }, .{
        ui.row(.{ .height = 30, .padding = 0, .gap = 0, .cross = .center }, .{ space(ui, 14, 0), ui.text(.{ .style = .{ .foreground = theme.ink } }, model.notice), space(ui, 14, 0) }),
    });
    pill.widget.layout.grow = 0;
    return ui.column(.{ .padding = 0, .gap = 0 }, .{
        ui.spacer(1),
        ui.row(.{ .padding = 0, .gap = 0 }, .{ space(ui, left, 0), ui.row(.{ .grow = 1, .padding = 0, .main = .center }, .{pill}), space(ui, right, 0) }),
        // Clear of the review's status pill, so it never covers the find field.
        space(ui, 0, theme.pane_inset + app.pill_height + 10),
    });
}
/// A pane that can close: its content keeps its width and is clipped while the
/// split eases the pane open or shut, so it slides instead of reflowing. No
/// minimum width: a floor would make the split jump to it before easing. The
/// model clamps widths that a drag reports.
fn drawer(ui: *AppUi, open: bool, content: AppUi.Node) AppUi.Node {
    // Content keeps its width and is clipped, so the pane slides rather than reflows.
    var node = ui.row(.{ .padding = 0, .gap = 0, .main = .start }, .{content});
    node.widget.layout.clip_content = true;
    // The split alone sizes a drawer; its fixed-width content must not hold it open.
    node.widget.layout.zero_intrinsic = true;
    node.widget.semantics.hidden = !open;
    return node;
}
pub fn view(ui: *AppUi, model: *const Model) AppUi.Node {
    const inset = theme.pane_inset;
    // Both splits stay mounted. Their fractions follow the widths on screen,
    // which the model eases a frame at a time when a pane opens or closes, so
    // each frame is a real layout (no split tween sliding a stale one).
    const span = model.canvas_width - inset;
    // 0 would mean an uncontrolled split; a hair above it is a closed rail.
    const rail = std.math.clamp(model.rail_shown / span, 0.0001, 0.95);
    const main_width = model.canvas_width - model.rail_shown - inset - inset;
    const notes = if (model.notes_shown > 0) std.math.clamp((main_width - model.notes_shown - inset) / main_width, 0.05, 1) else 1;
    // A split clamps a drag only to its panes' minimums, so each side pane's
    // range is two minimums: its own while it rests open, and the review's,
    // which leaves the side pane no more than its maximum.
    const idle = model.motion == null;
    const panes = ui.split(.{ .grow = 1, .gap = inset, .value = notes, .on_resize = AppUi.valueMsg(.notes_resized) }, .{
        withMin(reviewPane(ui, model), @max(360, main_width - inset - theme.notes_max - inset)),
        withMin(drawer(ui, model.notes_open, if (!model.notes_open and !model.notes_mounted) ui.spacer(0) else ui.row(.{ .width = model.notes_width + inset, .padding = 0, .gap = 0 }, .{ notePanel(ui, model), space(ui, inset, 0) })), if (model.notes_open and idle) theme.notes_min + inset else 0),
    });
    const main = ui.column(.{ .grow = 1, .padding = 0, .gap = 0 }, .{
        space(ui, 0, inset),
        ui.row(.{ .grow = 1, .padding = 0, .gap = 0 }, .{panes}),
        space(ui, 0, inset),
    });
    // On macOS the window's dark tint is a native layer under the canvas
    // (glass.m), so the canvas never blends a full-window fill on every frame;
    // elsewhere there is no layer under it, and the canvas paints it opaque.
    return ui.stack(.{ .padding = 0, .style = .{ .background = theme.windowFill(), .foreground = theme.ink, .radius = 0 } }, .{
        ui.split(.{ .grow = 1, .gap = inset, .value = rail, .on_resize = AppUi.valueMsg(.sidebar_resized) }, .{
            withMin(drawer(ui, model.sidebar, if (!model.sidebar and !model.rail_mounted) ui.spacer(0) else fileRail(ui, model)), if (model.sidebar and idle) theme.rail_min else 0),
            withMin(main, @max(480, span - theme.rail_max)),
        }),
        headerLayer(ui, model),
        if (model.notice.len > 0) toast(ui, model) else ui.spacer(0),
        if (model.palette != .closed) palette(ui, model) else ui.spacer(0),
    });
}
fn withMin(node: AppUi.Node, width: f32) AppUi.Node {
    var result = node;
    result.widget.layout.min_size.width = width;
    return result;
}

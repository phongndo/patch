//! Keyboard review: the keymap, the commands it runs, and allocation-free
//! fuzzy matching for the pickers. Keys are chords, as in Rex and every Mac
//! app: arrows move, Return acts on the line you are on, and everything else
//! takes ⌘. There are no modes, prefixes or counts, so a key always does the
//! same thing.

const std = @import("std");
const builtin = @import("builtin");

pub const Action = enum {
    line_down,
    line_up,
    old_side,
    new_side,
    file_next,
    file_previous,
    change_next,
    change_previous,
    unreviewed_next,
    unreviewed_previous,
    page_down,
    page_up,
    first,
    last,
    go_line,
    center,
    collapse_toggle,
    collapse,
    expand,
    collapse_all,
    expand_all,
    search,
    match_next,
    match_previous,
    reviewed,
    review_next,
    undo,
    comment_line,
    comment_file,
    commands,
    files,
    escape,
    split,
    sidebar,
    notes,
    refresh,
    open_repo,
    open_patch,
    copy,
    export_review,
    working,
    staged,
    branch,
    all_files,
    settings,
    shortcuts,
    whitespace,
    since_review,
    commit_next,
    commit_previous,
    all_changes,
    expand_context,
    whole_file,
    hunk_reviewed,
    hunk_review_next,
    hunk_next,
    hunk_previous,
    blame,
    find_symbol,
};
pub const Invocation = struct { action: Action };

/// A key on its own: named keys sit below the printable range, and every
/// other key is its unshifted character, as a US key cap reads.
pub const Key = enum(u8) {
    up = 1,
    down,
    left,
    right,
    page_up,
    page_down,
    home,
    end,
    enter,
    space,
    escape,
    tab,
    backspace,
    _,

    pub fn char(value: u8) Key {
        return @enumFromInt(std.ascii.toLower(value));
    }
};
pub const Chord = struct {
    key: Key,
    command: bool = false,
    option: bool = false,
    control: bool = false,
    shift: bool = false,

    pub fn eql(self: Chord, other: Chord) bool {
        return self.key == other.key and self.command == other.command and self.option == other.option and self.control == other.control and self.shift == other.shift;
    }
};

/// Global keys work everywhere, typing in a field included, so they all take
/// ⌘. Review keys act on the diff, and only when no text field has focus.
pub const Scope = enum { global, review };
const Binding = struct { keys: []const u8, action: Action, scope: Scope = .review };

/// The defaults. An action's first binding is the one the palette shows.
const bindings = [_]Binding{
    // Moving through the review.
    .{ .keys = "down", .action = .line_down },
    .{ .keys = "up", .action = .line_up },
    .{ .keys = "left", .action = .old_side },
    .{ .keys = "right", .action = .new_side },
    .{ .keys = "alt+down", .action = .change_next },
    .{ .keys = "alt+up", .action = .change_previous },
    // Files stack as panes, so Rex's keys for the pane below and above.
    .{ .keys = "alt+cmd+down", .action = .file_next },
    .{ .keys = "alt+cmd+up", .action = .file_previous },
    .{ .keys = "cmd+]", .action = .unreviewed_next },
    .{ .keys = "cmd+[", .action = .unreviewed_previous },
    .{ .keys = "alt+cmd+]", .action = .hunk_next },
    .{ .keys = "alt+cmd+[", .action = .hunk_previous },
    // Commits are a branch's tabs.
    .{ .keys = "shift+cmd+]", .action = .commit_next },
    .{ .keys = "shift+cmd+[", .action = .commit_previous },
    .{ .keys = "pagedown", .action = .page_down },
    .{ .keys = "space", .action = .page_down },
    .{ .keys = "pageup", .action = .page_up },
    .{ .keys = "shift+space", .action = .page_up },
    .{ .keys = "cmd+up", .action = .first },
    .{ .keys = "home", .action = .first },
    .{ .keys = "cmd+down", .action = .last },
    .{ .keys = "end", .action = .last },
    .{ .keys = "ctrl+l", .action = .center },
    .{ .keys = "cmd+l", .action = .go_line, .scope = .global },
    // Reviewing: Return acts where you are; ⌘ marks the file, ⌥ the hunk,
    // and Shift toggles in place instead of moving on.
    .{ .keys = "enter", .action = .comment_line },
    .{ .keys = "shift+enter", .action = .comment_file },
    .{ .keys = "cmd+enter", .action = .review_next },
    .{ .keys = "shift+cmd+enter", .action = .reviewed },
    .{ .keys = "alt+enter", .action = .hunk_review_next },
    .{ .keys = "shift+alt+enter", .action = .hunk_reviewed },
    .{ .keys = "cmd+z", .action = .undo },
    .{ .keys = "cmd+e", .action = .expand_context },
    .{ .keys = "shift+cmd+e", .action = .whole_file },
    .{ .keys = "shift+cmd+b", .action = .blame },
    .{ .keys = "shift+cmd+o", .action = .find_symbol },
    // Folding, as Xcode folds code.
    .{ .keys = "alt+cmd+left", .action = .collapse },
    .{ .keys = "alt+cmd+right", .action = .expand },
    .{ .keys = "shift+alt+cmd+left", .action = .collapse_all },
    .{ .keys = "shift+alt+cmd+right", .action = .expand_all },
    // Finding.
    .{ .keys = "cmd+f", .action = .search, .scope = .global },
    .{ .keys = "cmd+g", .action = .match_next, .scope = .global },
    .{ .keys = "shift+cmd+g", .action = .match_previous, .scope = .global },
    .{ .keys = "cmd+p", .action = .files, .scope = .global },
    .{ .keys = "cmd+k", .action = .commands, .scope = .global },
    .{ .keys = "shift+cmd+p", .action = .commands, .scope = .global },
    // The window and the app.
    .{ .keys = "cmd+1", .action = .working, .scope = .global },
    .{ .keys = "cmd+2", .action = .staged, .scope = .global },
    .{ .keys = "cmd+3", .action = .branch, .scope = .global },
    .{ .keys = "cmd+\\", .action = .split, .scope = .global },
    .{ .keys = "cmd+b", .action = .sidebar, .scope = .global },
    .{ .keys = "shift+cmd+n", .action = .notes, .scope = .global },
    .{ .keys = "cmd+r", .action = .refresh, .scope = .global },
    .{ .keys = "cmd+o", .action = .open_repo, .scope = .global },
    .{ .keys = "cmd+,", .action = .settings, .scope = .global },
    .{ .keys = "cmd+/", .action = .shortcuts, .scope = .global },
    .{ .keys = "escape", .action = .escape },
};

const Entry = struct { chord: Chord, action: Action, scope: Scope };
const table = blk: {
    @setEvalBranchQuota(200_000);
    var out: [bindings.len]Entry = undefined;
    for (bindings, 0..) |binding, index| out[index] = .{ .chord = parse(binding.keys) catch @compileError("Bad key binding: " ++ binding.keys), .action = binding.action, .scope = binding.scope };
    break :blk out;
};

/// The action a chord performs in a scope, if any.
pub fn match(chord: Chord, scope: Scope) ?Action {
    for (table) |entry| if (entry.scope == scope and entry.chord.eql(chord)) return entry.action;
    return null;
}

/// Reads a key the way Rex writes one: modifiers and one key joined by `+`,
/// such as `alt+cmd+down` or `shift+cmd+]`.
pub fn parse(text: []const u8) !Chord {
    var chord = Chord{ .key = .escape };
    var parts = std.mem.splitScalar(u8, text, '+');
    var key: ?[]const u8 = null;
    while (parts.next()) |name| {
        if (key != null) return error.KeyNotLast;
        if (std.mem.eql(u8, name, "cmd")) chord.command = true else if (std.mem.eql(u8, name, "alt")) chord.option = true else if (std.mem.eql(u8, name, "ctrl")) chord.control = true else if (std.mem.eql(u8, name, "shift")) chord.shift = true else key = name;
    }
    chord.key = keyNamed(key orelse return error.NoKey) orelse return error.UnknownKey;
    return chord;
}
fn keyNamed(name: []const u8) ?Key {
    const named = [_]struct { []const u8, Key }{
        .{ "up", .up },                     .{ "arrowup", .up },
        .{ "down", .down },                 .{ "arrowdown", .down },
        .{ "left", .left },                 .{ "arrowleft", .left },
        .{ "right", .right },               .{ "arrowright", .right },
        .{ "pageup", .page_up },            .{ "pagedown", .page_down },
        .{ "home", .home },                 .{ "end", .end },
        .{ "enter", .enter },               .{ "return", .enter },
        .{ "space", .space },               .{ " ", .space },
        .{ "escape", .escape },             .{ "esc", .escape },
        .{ "tab", .tab },                   .{ "backspace", .backspace },
        .{ "delete", .backspace },          .{ "slash", Key.char('/') },
        .{ "backslash", Key.char('\\') },   .{ "bracketleft", Key.char('[') },
        .{ "bracketright", Key.char(']') }, .{ "comma", Key.char(',') },
        .{ "period", Key.char('.') },       .{ "semicolon", Key.char(';') },
        .{ "minus", Key.char('-') },        .{ "equal", Key.char('=') },
    };
    for (named) |pair| if (std.ascii.eqlIgnoreCase(name, pair[0])) return pair[1];
    if (name.len == 1 and name[0] > ' ' and name[0] < 0x7f) return Key.char(name[0]);
    return null;
}

/// The key the keymap's `cmd` means: ⌘ on macOS, Ctrl on Linux and Windows,
/// as the manifest's `primary` modifier is.
pub const primary_is_control = builtin.os.tag != .macos;

/// Decodes a physical key-down. Modifier keys alone are not chords. Off macOS
/// the hosts report Ctrl as both `control` and the primary key (`command`);
/// it is the primary key there, so it matches the keymap's `cmd` chords.
pub fn decode(name: []const u8, shift: bool, control_in: bool, command: bool, option: bool) ?Chord {
    const control = control_in and !(primary_is_control and command);
    for ([_][]const u8{ "shift", "control", "ctrl", "alt", "option", "command", "meta", "super", "capslock", "fn" }) |modifier| if (std.ascii.eqlIgnoreCase(name, modifier)) return null;
    // Shifted punctuation names its key cap, so ? is shift and /.
    const shifted = [_][2]u8{ .{ '?', '/' }, .{ ':', ';' }, .{ '{', '[' }, .{ '}', ']' }, .{ '|', '\\' }, .{ '<', ',' }, .{ '>', '.' }, .{ '+', '=' }, .{ '_', '-' }, .{ '"', '\'' }, .{ '~', '`' } };
    var base = name;
    var implied_shift = false;
    if (name.len == 1) for (shifted) |pair| if (name[0] == pair[0]) {
        base = &[_]u8{pair[1]};
        implied_shift = true;
    };
    if (name.len == 1 and std.ascii.isUpper(name[0])) implied_shift = true;
    const key = keyNamed(base) orelse return null;
    return .{ .key = key, .command = command, .option = option, .control = control, .shift = shift or implied_shift };
}

/// How a chord reads on a key cap, with the Mac's modifier order ⌃⌥⇧⌘.
fn glyphs(comptime chord: Chord) []const u8 {
    const key: []const u8 = switch (chord.key) {
        .up => "↑",
        .down => "↓",
        .left => "←",
        .right => "→",
        .page_up => "⇞",
        .page_down => "⇟",
        .home => "↖",
        .end => "↘",
        .enter => "↩",
        .space => "Space",
        .escape => "Esc",
        .tab => "⇥",
        .backspace => "⌫",
        _ => &[_]u8{std.ascii.toUpper(@intFromEnum(chord.key))},
    };
    // Off macOS modifiers are named in the order Linux and Windows write them.
    if (primary_is_control) return (if (chord.control or chord.command) "Ctrl+" else "") ++ (if (chord.option) "Alt+" else "") ++ (if (chord.shift) "Shift+" else "") ++ label(key);
    return (if (chord.control) "⌃" else "") ++ (if (chord.option) "⌥" else "") ++ (if (chord.shift) "⇧" else "") ++ (if (chord.command) "⌘" else "") ++ key;
}

/// Keys written with Mac glyphs, as this platform spells them: unchanged on
/// macOS; elsewhere ⌘ and ⌃ read Ctrl, ⌥ Alt and ⇧ Shift, joined by `+`, and
/// the Mac-only key caps take their names.
pub fn label(comptime text: []const u8) []const u8 {
    if (!primary_is_control) return text;
    return comptime spelled: {
        @setEvalBranchQuota(50_000);
        const names = .{
            .{ "⌘", "Ctrl+" },
            .{ "⌃", "Ctrl+" },
            .{ "⌥", "Alt+" },
            .{ "⇧", "Shift+" },
            .{ "↩", "Enter" },
            .{ "↵", "Enter" },
            .{ "⇥", "Tab" },
            .{ "⌫", "Backspace" },
            .{ "⇞", "PgUp" },
            .{ "⇟", "PgDn" },
            .{ "↖", "Home" },
            .{ "↘", "End" },
        };
        var out: []const u8 = "";
        var i: usize = 0;
        next: while (i < text.len) {
            for (names) |pair| if (std.mem.startsWith(u8, text[i..], pair[0])) {
                out = out ++ pair[1];
                i += pair[0].len;
                continue :next;
            };
            out = out ++ text[i .. i + 1];
            i += 1;
        }
        const final = out[0..out.len].*;
        break :spelled &final;
    };
}
const labels = blk: {
    @setEvalBranchQuota(100_000);
    var out = [_][]const u8{""} ** @typeInfo(Action).@"enum".fields.len;
    var first = [_][]const u8{""} ** out.len;
    for (table) |entry| {
        const index = @intFromEnum(entry.action);
        const text = glyphs(entry.chord);
        if (first[index].len == 0) first[index] = text;
        out[index] = if (out[index].len == 0) text else out[index] ++ "  " ++ text;
    }
    break :blk .{ .all = out, .first = first };
};
/// Every key bound to an action, for Settings.
pub fn keysFor(action: Action) []const u8 {
    return labels.all[@intFromEnum(action)];
}
/// The key the palette and tooltips show for an action.
pub fn shortcut(action: Action) []const u8 {
    return labels.first[@intFromEnum(action)];
}

pub const Group = enum {
    move,
    review,
    find,
    view,
    app,

    pub fn title(self: Group) []const u8 {
        return switch (self) {
            .move => "Move",
            .review => "Review",
            .find => "Find",
            .view => "View",
            .app => "Patch",
        };
    }
};
pub const Command = struct { action: Action, id: []const u8, title: []const u8, group: Group, icon: []const u8 = "right", document: bool = true };
pub const commands = [_]Command{
    .{ .action = .files, .id = "patch.files", .title = "Go to file", .group = .find, .icon = "file" },
    .{ .action = .go_line, .id = "patch.go-line", .title = "Go to line", .group = .find },
    .{ .action = .change_next, .id = "patch.change-next", .title = "Next change", .group = .move },
    .{ .action = .change_previous, .id = "patch.change-previous", .title = "Previous change", .group = .move, .icon = "left" },
    .{ .action = .file_next, .id = "patch.file-next", .title = "Next file", .group = .move, .icon = "file" },
    .{ .action = .file_previous, .id = "patch.file-previous", .title = "Previous file", .group = .move, .icon = "file" },
    .{ .action = .unreviewed_next, .id = "patch.unreviewed-next", .title = "Next unreviewed file", .group = .move, .icon = "checkbox" },
    .{ .action = .unreviewed_previous, .id = "patch.unreviewed-previous", .title = "Previous unreviewed file", .group = .move, .icon = "checkbox" },
    .{ .action = .hunk_next, .id = "patch.hunk-next", .title = "Next unreviewed hunk", .group = .move, .icon = "checkbox" },
    .{ .action = .hunk_previous, .id = "patch.hunk-previous", .title = "Previous unreviewed hunk", .group = .move, .icon = "checkbox" },
    .{ .action = .review_next, .id = "patch.review-next", .title = "Mark reviewed and advance", .group = .review, .icon = "check" },
    .{ .action = .reviewed, .id = "patch.reviewed", .title = "Toggle reviewed", .group = .review, .icon = "check" },
    .{ .action = .hunk_review_next, .id = "patch.hunk-review-next", .title = "Mark hunk reviewed and advance", .group = .review, .icon = "check" },
    .{ .action = .hunk_reviewed, .id = "patch.hunk-reviewed", .title = "Toggle hunk reviewed", .group = .review, .icon = "check" },
    .{ .action = .undo, .id = "patch.undo-review", .title = "Undo reviewed state", .group = .review, .icon = "left" },
    .{ .action = .comment_line, .id = "patch.comment-line", .title = "Comment on current line", .group = .review, .icon = "add" },
    .{ .action = .comment_file, .id = "patch.comment-file", .title = "Comment on file", .group = .review, .icon = "comment" },
    .{ .action = .expand_context, .id = "patch.expand-context", .title = "Show more context around hunk", .group = .review, .icon = "expand-all" },
    .{ .action = .whole_file, .id = "patch.whole-file", .title = "Show whole file or changes only", .group = .review, .icon = "expand-all" },
    .{ .action = .find_symbol, .id = "patch.find-symbol", .title = "Find symbol definitions and uses", .group = .find, .icon = "symbol" },
    .{ .action = .blame, .id = "patch.blame", .title = "Blame current line", .group = .review, .icon = "history" },
    .{ .action = .search, .id = "patch.search", .title = "Find in diff", .group = .find, .icon = "search" },
    .{ .action = .match_next, .id = "patch.match-next", .title = "Next search match", .group = .find, .icon = "search" },
    .{ .action = .match_previous, .id = "patch.match-previous", .title = "Previous search match", .group = .find, .icon = "search" },
    .{ .action = .line_down, .id = "patch.line-down", .title = "Move down", .group = .move },
    .{ .action = .line_up, .id = "patch.line-up", .title = "Move up", .group = .move, .icon = "left" },
    .{ .action = .old_side, .id = "patch.old-side", .title = "Focus old side", .group = .move, .icon = "split" },
    .{ .action = .new_side, .id = "patch.new-side", .title = "Focus new side", .group = .move, .icon = "split" },
    .{ .action = .page_down, .id = "patch.page-down", .title = "Page down", .group = .move },
    .{ .action = .page_up, .id = "patch.page-up", .title = "Page up", .group = .move, .icon = "left" },
    .{ .action = .first, .id = "patch.first", .title = "First line", .group = .move },
    .{ .action = .last, .id = "patch.last", .title = "Last line", .group = .move },
    .{ .action = .center, .id = "patch.center", .title = "Center current line", .group = .move },
    .{ .action = .collapse, .id = "patch.fold", .title = "Fold file", .group = .view, .icon = "collapsed" },
    .{ .action = .expand, .id = "patch.unfold", .title = "Unfold file", .group = .view, .icon = "expanded" },
    .{ .action = .collapse_toggle, .id = "patch.collapse", .title = "Fold or unfold file", .group = .view, .icon = "collapsed" },
    .{ .action = .collapse_all, .id = "patch.collapse-all", .title = "Fold all files", .group = .view, .icon = "collapsed" },
    .{ .action = .expand_all, .id = "patch.expand-all", .title = "Unfold all files", .group = .view, .icon = "expanded" },
    .{ .action = .split, .id = "patch.split", .title = "Toggle split or unified diff", .group = .view, .icon = "split" },
    .{ .action = .whitespace, .id = "patch.whitespace", .title = "Toggle ignore whitespace", .group = .view, .icon = "modified", .document = false },
    .{ .action = .since_review, .id = "patch.since-review", .title = "Toggle changes since review", .group = .view, .icon = "modified" },
    .{ .action = .commit_next, .id = "patch.commit-next", .title = "Next commit", .group = .move, .icon = "branch", .document = false },
    .{ .action = .commit_previous, .id = "patch.commit-previous", .title = "Previous commit", .group = .move, .icon = "branch", .document = false },
    .{ .action = .all_changes, .id = "patch.all-changes", .title = "Review all the branch's changes", .group = .app, .icon = "branch", .document = false },
    .{ .action = .sidebar, .id = "patch.sidebar", .title = "Toggle file rail", .group = .view, .icon = "sidebar", .document = false },
    .{ .action = .notes, .id = "patch.notes", .title = "Toggle notes", .group = .view, .icon = "comment" },
    .{ .action = .refresh, .id = "patch.refresh", .title = "Refresh changes", .group = .app, .icon = "refresh", .document = false },
    .{ .action = .open_repo, .id = "patch.open", .title = "Open repository…", .group = .app, .icon = "folder", .document = false },
    .{ .action = .open_patch, .id = "patch.import", .title = "Open patch…", .group = .app, .icon = "file", .document = false },
    .{ .action = .settings, .id = "patch.settings", .title = "Settings…", .group = .app, .icon = "gear", .document = false },
    .{ .action = .shortcuts, .id = "patch.shortcuts", .title = "Keyboard shortcuts", .group = .app, .icon = "command", .document = false },
    .{ .action = .copy, .id = "patch.copy", .title = "Copy review as Markdown", .group = .app, .icon = "copy" },
    .{ .action = .export_review, .id = "patch.export", .title = "Export review…", .group = .app, .icon = "export" },
    .{ .action = .working, .id = "patch.working", .title = "Review working changes", .group = .app, .icon = "branch", .document = false },
    .{ .action = .staged, .id = "patch.staged", .title = "Review staged changes", .group = .app, .icon = "branch", .document = false },
    .{ .action = .branch, .id = "patch.branch", .title = "Compare branch", .group = .app, .icon = "branch", .document = false },
    .{ .action = .all_files, .id = "patch.all-files", .title = "Browse all files", .group = .app, .icon = "folder", .document = false },
};
pub fn byId(name: []const u8) ?Action {
    if (std.mem.eql(u8, name, "patch.commands") or std.mem.eql(u8, name, "patch.help")) return .commands;
    for (commands) |command| if (std.mem.eql(u8, name, command.id)) return command.action;
    return null;
}

/// Subsequence matching rewards word boundaries and consecutive letters.
/// A smaller score is a better result. No allocation is needed while typing.
pub fn score(query: []const u8, text: []const u8) ?u32 {
    if (query.len == 0) return 0;
    var position: usize = 0;
    var result: u32 = 0;
    var previous: ?usize = null;
    for (query) |char| {
        if (char == ' ') continue;
        var found = false;
        while (position < text.len) : (position += 1) {
            if (std.ascii.toLower(char) != std.ascii.toLower(text[position])) continue;
            const boundary = position == 0 or text[position - 1] == '/' or text[position - 1] == ' ' or text[position - 1] == '-' or text[position - 1] == '_';
            const adjacent = if (previous) |last| position == last + 1 else false;
            result += if (boundary or adjacent) 0 else 8;
            result += @intCast(if (previous) |last| @min(100, position - last - 1) else @min(100, position));
            previous = position;
            position += 1;
            found = true;
            break;
        }
        if (!found) return null;
    }
    return result + @as(u32, @intCast(@min(100, text.len)));
}

/// A file picker query may end in `:line`, as `view.zig:120` or `:120`.
pub const Target = struct { query: []const u8, line: ?usize = null };
pub fn target(query: []const u8) Target {
    const trimmed = std.mem.trim(u8, query, " ");
    const colon = std.mem.lastIndexOfScalar(u8, trimmed, ':') orelse return .{ .query = trimmed };
    const digits = trimmed[colon + 1 ..];
    const line = std.fmt.parseInt(usize, digits, 10) catch return .{ .query = std.mem.trim(u8, trimmed, ": ") };
    return .{ .query = std.mem.trim(u8, trimmed[0..colon], " "), .line = line };
}

test "arrows move, and chords reach further without modes" {
    const down = decode("arrowdown", false, false, false, false).?;
    try std.testing.expectEqual(Action.line_down, match(down, .review).?);
    try std.testing.expectEqual(Action.change_next, match(decode("arrowdown", false, false, false, true).?, .review).?);
    try std.testing.expectEqual(Action.file_next, match(decode("arrowdown", false, false, true, true).?, .review).?);
    try std.testing.expectEqual(Action.last, match(decode("arrowdown", false, false, true, false).?, .review).?);
    try std.testing.expectEqual(Action.commit_next, match(decode("]", true, false, true, false).?, .review).?);
    try std.testing.expectEqual(Action.commit_next, match(decode("}", false, false, true, false).?, .review).?);
    try std.testing.expectEqual(Action.unreviewed_previous, match(decode("bracketleft", false, false, true, false).?, .review).?);
    try std.testing.expectEqual(Action.comment_line, match(decode("enter", false, false, false, false).?, .review).?);
    try std.testing.expectEqual(Action.review_next, match(decode("return", false, false, true, false).?, .review).?);
    try std.testing.expectEqual(Action.hunk_reviewed, match(decode("enter", true, false, false, true).?, .review).?);
    try std.testing.expectEqual(Action.page_up, match(decode("space", true, false, false, false).?, .review).?);
}
test "Ctrl is the primary key off macOS" {
    // The Linux and Windows hosts flag Ctrl as both control and command.
    const ctrl_k = decode("k", false, true, true, false).?;
    if (primary_is_control) {
        try std.testing.expectEqual(Action.commands, match(ctrl_k, .global).?);
        try std.testing.expectEqualStrings("Ctrl+K", shortcut(.commands));
        try std.testing.expectEqualStrings("Alt+Shift+Enter", shortcut(.hunk_reviewed));
        try std.testing.expectEqualStrings("Refresh · Ctrl+R", label("Refresh · ⌘R"));
    } else {
        try std.testing.expect(match(ctrl_k, .global) == null);
        try std.testing.expectEqualStrings("⌘K", shortcut(.commands));
        try std.testing.expectEqualStrings("Refresh · ⌘R", label("Refresh · ⌘R"));
    }
    // A Ctrl chord the automation sends alone stays a Ctrl chord everywhere.
    try std.testing.expectEqual(Action.center, match(decode("l", false, true, false, false).?, .review).?);
}
test "letters do nothing on their own" {
    for ("abcdefghijklmnopqrstuvwxyz/?:[]") |char| {
        const chord = decode(&[_]u8{char}, false, false, false, false).?;
        try std.testing.expect(match(chord, .review) == null);
        try std.testing.expect(match(chord, .global) == null);
    }
    try std.testing.expect(decode("Shift", true, false, false, false) == null);
    try std.testing.expect(decode("meta", false, false, true, false) == null);
}
test "global keys keep the clipboard and text editing chords free" {
    try std.testing.expectEqual(Action.commands, match(decode("k", false, false, true, false).?, .global).?);
    try std.testing.expectEqual(Action.commands, match(decode("p", true, false, true, false).?, .global).?);
    try std.testing.expectEqual(Action.files, match(decode("p", false, false, true, false).?, .global).?);
    try std.testing.expectEqual(Action.split, match(decode("\\", false, false, true, false).?, .global).?);
    try std.testing.expectEqual(Action.split, match(decode("backslash", false, false, true, false).?, .global).?);
    try std.testing.expectEqual(Action.open_repo, match(decode("o", false, false, true, false).?, .global).?);
    try std.testing.expect(match(decode("o", true, false, true, false).?, .global) == null);
    for ("acvxz") |char| try std.testing.expect(match(decode(&[_]u8{char}, false, false, true, false).?, .global) == null);
    for (table) |entry| if (entry.scope == .global) try std.testing.expect(entry.chord.command);
}
test "every chord does one thing" {
    for (table, 0..) |entry, index| for (table[index + 1 ..]) |other| {
        try std.testing.expect(!entry.chord.eql(other.chord));
    };
}
test "labels read as key caps" {
    if (primary_is_control) {
        try std.testing.expectEqualStrings("Ctrl+Alt+↓", shortcut(.file_next));
        try std.testing.expectEqualStrings("Ctrl+Shift+]", shortcut(.commit_next));
        try std.testing.expectEqualStrings("PgDn  Space", keysFor(.page_down));
        try std.testing.expectEqualStrings("Ctrl+K  Ctrl+Shift+P", keysFor(.commands));
        try std.testing.expectEqualStrings("Ctrl+\\", shortcut(.split));
        return;
    }
    try std.testing.expectEqualStrings("⌥⌘↓", shortcut(.file_next));
    try std.testing.expectEqualStrings("⇧⌘]", shortcut(.commit_next));
    try std.testing.expectEqualStrings("⇟  Space", keysFor(.page_down));
    try std.testing.expectEqualStrings("⌘K  ⇧⌘P", keysFor(.commands));
    try std.testing.expectEqualStrings("⌘\\", shortcut(.split));
    try std.testing.expectEqualStrings("⌥⇧↩", shortcut(.hunk_reviewed));
}
test "file picker queries can name a line" {
    try std.testing.expectEqualStrings("view.zig", target("view.zig:120").query);
    try std.testing.expectEqual(@as(?usize, 120), target("view.zig:120").line);
    try std.testing.expectEqual(@as(?usize, 42), target(":42").line);
    try std.testing.expectEqualStrings("", target(":42").query);
    try std.testing.expectEqualStrings("view", target(" view: ").query);
    try std.testing.expect(target("view").line == null);
}
test "fuzzy commands rank contiguous words and reject unrelated input" {
    try std.testing.expect(score("next change", "Next change").? < score("next change", "Next unreviewed change").?);
    try std.testing.expect(score("srnvw", "src/native/view.zig") != null);
    try std.testing.expect(score("xyz", "src/native/view.zig") == null);
    for (commands, 0..) |command, index| for (commands[index + 1 ..]) |other| try std.testing.expect(!std.mem.eql(u8, command.id, other.id));
}

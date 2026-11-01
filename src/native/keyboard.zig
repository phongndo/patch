const std = @import("std");

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
    half_down,
    half_up,
    page_down,
    page_up,
    scroll_down,
    scroll_up,
    first,
    last,
    go_line,
    viewport_top,
    viewport_middle,
    viewport_bottom,
    center,
    align_top,
    align_bottom,
    collapse_toggle,
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
    settings,
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
pub const Invocation = struct { action: Action, count: usize = 1 };
pub const Key = union(enum) { character: u8, control: u8, escape, enter, up, down, page_up, page_down, home, end, other };
pub const Prefix = enum { none, g, next, previous, z };
pub const State = struct {
    count: usize = 0,
    prefix: Prefix = .none,

    pub fn pending(self: State) bool {
        return self.count != 0 or self.prefix != .none;
    }
    pub fn reset(self: *State) void {
        self.* = .{};
    }
    pub fn hint(self: State, buffer: []u8) []const u8 {
        const prefix: []const u8 = switch (self.prefix) {
            .none => "",
            .g => "g",
            .next => "]",
            .previous => "[",
            .z => "z",
        };
        return if (self.count > 0) std.fmt.bufPrint(buffer, "{d}{s}", .{ self.count, prefix }) catch "" else prefix;
    }
    pub fn feed(self: *State, key: Key) ?Invocation {
        if (key == .escape) {
            self.reset();
            return .{ .action = .escape };
        }
        if (key == .character) {
            const char = key.character;
            if (char >= '0' and char <= '9' and (char != '0' or self.count > 0)) {
                self.count = @min(9999, self.count * 10 + char - '0');
                return null;
            }
            if (self.prefix == .none) switch (char) {
                'g' => {
                    self.prefix = .g;
                    return null;
                },
                ']' => {
                    self.prefix = .next;
                    return null;
                },
                '[' => {
                    self.prefix = .previous;
                    return null;
                },
                'z' => {
                    self.prefix = .z;
                    return null;
                },
                else => {},
            };
        }
        const count = @max(1, self.count);
        const prefix = self.prefix;
        const explicit_count = self.count > 0;
        self.reset();
        const action: ?Action = if (prefix != .none) blk: {
            if (key != .character) break :blk null;
            break :blk switch (prefix) {
                .g => switch (key.character) {
                    'g' => if (explicit_count) .go_line else .first,
                    'b' => .blame,
                    'd' => .find_symbol,
                    else => null,
                },
                .next => switch (key.character) {
                    'C' => .commit_next,
                    'c' => .change_next,
                    'f' => .file_next,
                    'u' => .unreviewed_next,
                    'h' => .hunk_next,
                    else => null,
                },
                .previous => switch (key.character) {
                    'C' => .commit_previous,
                    'c' => .change_previous,
                    'f' => .file_previous,
                    'u' => .unreviewed_previous,
                    'h' => .hunk_previous,
                    else => null,
                },
                .z => switch (key.character) {
                    'z' => .center,
                    't' => .align_top,
                    'b' => .align_bottom,
                    // Vim's fold keys: toggle the current file, close all, open all.
                    'a' => .collapse_toggle,
                    'M' => .collapse_all,
                    'R' => .expand_all,
                    else => null,
                },
                .none => unreachable,
            };
        } else switch (key) {
            .character => |char| switch (char) {
                'j' => .line_down,
                'k' => .line_up,
                'h' => .old_side,
                'l' => .new_side,
                'J' => .file_next,
                'K' => .file_previous,
                'G' => if (explicit_count) .go_line else .last,
                'H' => .viewport_top,
                'M' => .viewport_middle,
                'L' => .viewport_bottom,
                '/' => .search,
                'n' => .match_next,
                'N' => .match_previous,
                'r' => .reviewed,
                'R' => .review_next,
                'v' => .hunk_reviewed,
                'V' => .hunk_review_next,
                'e' => .expand_context,
                'E' => .whole_file,
                'u' => .undo,
                'c', 'i' => .comment_line,
                'C' => .comment_file,
                ':', '?' => .commands,
                else => null,
            },
            .control => |char| switch (char) {
                'd' => .half_down,
                'u' => .half_up,
                'f' => .page_down,
                'b' => .page_up,
                'e' => .scroll_down,
                'y' => .scroll_up,
                '[' => .escape,
                else => null,
            },
            .down => .line_down,
            .up => .line_up,
            .page_down => .page_down,
            .page_up => .page_up,
            .home => .first,
            .end => .last,
            .enter => .comment_line,
            .escape => .escape,
            .other => null,
        };
        return if (action) |value| .{ .action = value, .count = count } else null;
    }
};

/// Decode physical key-downs only; committed text stays with native editors.
pub fn decode(name: []const u8, shift: bool, control: bool, super: bool, alt: bool) ?Key {
    if (super or alt) return null;
    for ([_][]const u8{ "shift", "control", "ctrl", "alt", "option", "command", "meta", "super", "capslock" }) |modifier| if (std.ascii.eqlIgnoreCase(name, modifier)) return null;
    if (std.ascii.eqlIgnoreCase(name, "escape") or std.ascii.eqlIgnoreCase(name, "esc")) return .escape;
    if (std.ascii.eqlIgnoreCase(name, "enter") or std.ascii.eqlIgnoreCase(name, "return")) return .enter;
    if (std.ascii.eqlIgnoreCase(name, "arrowup") or std.ascii.eqlIgnoreCase(name, "up")) return .up;
    if (std.ascii.eqlIgnoreCase(name, "arrowdown") or std.ascii.eqlIgnoreCase(name, "down")) return .down;
    if (std.ascii.eqlIgnoreCase(name, "pageup")) return .page_up;
    if (std.ascii.eqlIgnoreCase(name, "pagedown")) return .page_down;
    if (std.ascii.eqlIgnoreCase(name, "home")) return .home;
    if (std.ascii.eqlIgnoreCase(name, "end")) return .end;
    var char: u8 = if (name.len == 1) name[0] else if (std.ascii.eqlIgnoreCase(name, "slash")) '/' else if (std.ascii.eqlIgnoreCase(name, "semicolon")) ';' else if (std.ascii.eqlIgnoreCase(name, "bracketleft")) '[' else if (std.ascii.eqlIgnoreCase(name, "bracketright")) ']' else return .other;
    if (control) return .{ .control = std.ascii.toLower(char) };
    if (shift) char = switch (char) {
        '/' => '?',
        ';' => ':',
        else => std.ascii.toUpper(char),
    };
    return .{ .character = char };
}

pub const Command = struct { action: Action, id: []const u8, title: []const u8, shortcut: []const u8 = "", icon: []const u8 = "right", document: bool = true };
pub const commands = [_]Command{
    .{ .action = .files, .id = "patch.files", .title = "Go to file", .shortcut = "⌘P", .icon = "file" },
    .{ .action = .change_next, .id = "patch.change-next", .title = "Next change", .shortcut = "]c" },
    .{ .action = .change_previous, .id = "patch.change-previous", .title = "Previous change", .shortcut = "[c", .icon = "left" },
    .{ .action = .file_next, .id = "patch.file-next", .title = "Next file", .shortcut = "J / ]f", .icon = "file" },
    .{ .action = .file_previous, .id = "patch.file-previous", .title = "Previous file", .shortcut = "K / [f", .icon = "file" },
    .{ .action = .unreviewed_next, .id = "patch.unreviewed-next", .title = "Next unreviewed file", .shortcut = "]u", .icon = "checkbox" },
    .{ .action = .unreviewed_previous, .id = "patch.unreviewed-previous", .title = "Previous unreviewed file", .shortcut = "[u", .icon = "checkbox" },
    .{ .action = .reviewed, .id = "patch.reviewed", .title = "Toggle reviewed", .shortcut = "r", .icon = "check" },
    .{ .action = .review_next, .id = "patch.review-next", .title = "Mark reviewed and advance", .shortcut = "R", .icon = "check" },
    .{ .action = .hunk_reviewed, .id = "patch.hunk-reviewed", .title = "Toggle hunk reviewed", .shortcut = "v", .icon = "check" },
    .{ .action = .hunk_review_next, .id = "patch.hunk-review-next", .title = "Mark hunk reviewed and advance", .shortcut = "V", .icon = "check" },
    .{ .action = .hunk_next, .id = "patch.hunk-next", .title = "Next unreviewed hunk", .shortcut = "]h", .icon = "checkbox" },
    .{ .action = .hunk_previous, .id = "patch.hunk-previous", .title = "Previous unreviewed hunk", .shortcut = "[h", .icon = "checkbox" },
    .{ .action = .expand_context, .id = "patch.expand-context", .title = "Show more context around hunk", .shortcut = "e", .icon = "expand-all" },
    .{ .action = .whole_file, .id = "patch.whole-file", .title = "Show whole file or changes only", .shortcut = "E", .icon = "expand-all" },
    .{ .action = .find_symbol, .id = "patch.find-symbol", .title = "Find symbol definitions and uses", .shortcut = "gd", .icon = "symbol" },
    .{ .action = .blame, .id = "patch.blame", .title = "Blame current line", .shortcut = "gb", .icon = "history" },
    .{ .action = .undo, .id = "patch.undo-review", .title = "Undo reviewed state", .shortcut = "u", .icon = "left" },
    .{ .action = .comment_line, .id = "patch.comment-line", .title = "Comment on current line", .shortcut = "c / i", .icon = "add" },
    .{ .action = .comment_file, .id = "patch.comment-file", .title = "Comment on file", .shortcut = "C", .icon = "comment" },
    .{ .action = .search, .id = "patch.search", .title = "Find in diff", .shortcut = "/ / ⌘F", .icon = "search" },
    .{ .action = .match_next, .id = "patch.match-next", .title = "Next search match", .shortcut = "n", .icon = "search" },
    .{ .action = .match_previous, .id = "patch.match-previous", .title = "Previous search match", .shortcut = "N", .icon = "search" },
    .{ .action = .line_down, .id = "patch.line-down", .title = "Move down", .shortcut = "j" },
    .{ .action = .line_up, .id = "patch.line-up", .title = "Move up", .shortcut = "k", .icon = "left" },
    .{ .action = .old_side, .id = "patch.old-side", .title = "Focus old side", .shortcut = "h", .icon = "split" },
    .{ .action = .new_side, .id = "patch.new-side", .title = "Focus new side", .shortcut = "l", .icon = "split" },
    .{ .action = .half_down, .id = "patch.half-down", .title = "Half page down", .shortcut = "⌃D" },
    .{ .action = .half_up, .id = "patch.half-up", .title = "Half page up", .shortcut = "⌃U", .icon = "left" },
    .{ .action = .page_down, .id = "patch.page-down", .title = "Page down", .shortcut = "⌃F" },
    .{ .action = .page_up, .id = "patch.page-up", .title = "Page up", .shortcut = "⌃B", .icon = "left" },
    .{ .action = .first, .id = "patch.first", .title = "First line", .shortcut = "gg" },
    .{ .action = .last, .id = "patch.last", .title = "Last line", .shortcut = "G" },
    .{ .action = .viewport_top, .id = "patch.viewport-top", .title = "Top of visible diff", .shortcut = "H" },
    .{ .action = .viewport_middle, .id = "patch.viewport-middle", .title = "Middle of visible diff", .shortcut = "M" },
    .{ .action = .viewport_bottom, .id = "patch.viewport-bottom", .title = "Bottom of visible diff", .shortcut = "L" },
    .{ .action = .center, .id = "patch.center", .title = "Center current line", .shortcut = "zz" },
    .{ .action = .align_top, .id = "patch.align-top", .title = "Align current line to top", .shortcut = "zt" },
    .{ .action = .align_bottom, .id = "patch.align-bottom", .title = "Align current line to bottom", .shortcut = "zb" },
    .{ .action = .collapse_toggle, .id = "patch.collapse", .title = "Collapse or expand file", .shortcut = "za", .icon = "collapsed" },
    .{ .action = .collapse_all, .id = "patch.collapse-all", .title = "Collapse all files", .shortcut = "zM", .icon = "collapsed" },
    .{ .action = .expand_all, .id = "patch.expand-all", .title = "Expand all files", .shortcut = "zR", .icon = "expanded" },
    .{ .action = .split, .id = "patch.split", .title = "Toggle split or unified diff", .shortcut = "⌘\\", .icon = "split" },
    .{ .action = .whitespace, .id = "patch.whitespace", .title = "Toggle ignore whitespace", .icon = "modified", .document = false },
    .{ .action = .since_review, .id = "patch.since-review", .title = "Toggle changes since review", .icon = "modified" },
    .{ .action = .commit_next, .id = "patch.commit-next", .title = "Next commit", .shortcut = "]C", .icon = "branch", .document = false },
    .{ .action = .commit_previous, .id = "patch.commit-previous", .title = "Previous commit", .shortcut = "[C", .icon = "branch", .document = false },
    .{ .action = .all_changes, .id = "patch.all-changes", .title = "Review all the branch's changes", .icon = "branch", .document = false },
    .{ .action = .sidebar, .id = "patch.sidebar", .title = "Toggle file rail", .shortcut = "⌘B", .icon = "sidebar", .document = false },
    .{ .action = .notes, .id = "patch.notes", .title = "Toggle notes", .shortcut = "⌘⇧N", .icon = "comment" },
    .{ .action = .refresh, .id = "patch.refresh", .title = "Refresh changes", .shortcut = "⌘R", .icon = "refresh", .document = false },
    .{ .action = .open_repo, .id = "patch.open", .title = "Open repository…", .shortcut = "⌘O", .icon = "folder", .document = false },
    .{ .action = .open_patch, .id = "patch.import", .title = "Open patch…", .icon = "file", .document = false },
    .{ .action = .settings, .id = "patch.settings", .title = "Settings…", .shortcut = "⌘,", .icon = "gear", .document = false },
    .{ .action = .copy, .id = "patch.copy", .title = "Copy review as Markdown", .icon = "copy" },
    .{ .action = .export_review, .id = "patch.export", .title = "Export review…", .icon = "export" },
    .{ .action = .working, .id = "patch.working", .title = "Review working changes", .icon = "branch", .document = false },
    .{ .action = .staged, .id = "patch.staged", .title = "Review staged changes", .icon = "branch", .document = false },
    .{ .action = .branch, .id = "patch.branch", .title = "Compare branch", .icon = "branch", .document = false },
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

test "counts, shifted keys, and multi-key commands follow Vim conventions" {
    var state = State{};
    try std.testing.expect(state.feed(.{ .character = '3' }) == null);
    try std.testing.expectEqual(Invocation{ .action = .line_down, .count = 3 }, state.feed(.{ .character = 'j' }).?);
    try std.testing.expect(state.feed(.{ .character = ']' }) == null);
    try std.testing.expectEqual(Action.change_next, state.feed(.{ .character = 'c' }).?.action);
    _ = state.feed(.{ .character = 'g' });
    try std.testing.expectEqual(Action.first, state.feed(.{ .character = 'g' }).?.action);
    _ = state.feed(.{ .character = '1' });
    _ = state.feed(.{ .character = '2' });
    try std.testing.expectEqual(Invocation{ .action = .go_line, .count = 12 }, state.feed(.{ .character = 'G' }).?);
    try std.testing.expectEqual(Key{ .character = 'J' }, decode("j", true, false, false, false).?);
    try std.testing.expectEqual(Key{ .character = '?' }, decode("/", true, false, false, false).?);
    try std.testing.expect(decode("k", false, false, true, false) == null);
    try std.testing.expect(decode("Shift", true, false, false, false) == null);
}
test "fold keys collapse and expand files" {
    var state = State{};
    _ = state.feed(.{ .character = 'z' });
    try std.testing.expectEqual(Action.collapse_toggle, state.feed(.{ .character = 'a' }).?.action);
    _ = state.feed(.{ .character = ']' });
    try std.testing.expectEqual(Action.commit_next, state.feed(.{ .character = 'C' }).?.action);
    _ = state.feed(.{ .character = 'z' });
    try std.testing.expectEqual(Action.collapse_all, state.feed(.{ .character = 'M' }).?.action);
    _ = state.feed(.{ .character = 'z' });
    try std.testing.expectEqual(Action.expand_all, state.feed(.{ .character = 'R' }).?.action);
}
test "escape and invalid sequences clear pending counts without triggering actions" {
    var state = State{};
    _ = state.feed(.{ .character = '9' });
    _ = state.feed(.{ .character = 'z' });
    try std.testing.expect(state.feed(.{ .character = 'x' }) == null);
    try std.testing.expect(!state.pending());
    _ = state.feed(.{ .character = 'g' });
    try std.testing.expectEqual(Action.escape, state.feed(.escape).?.action);
    for (0..12) |_| _ = state.feed(.{ .character = '9' });
    try std.testing.expectEqual(@as(usize, 9999), state.feed(.{ .character = 'j' }).?.count);
}
test "fuzzy commands rank contiguous words and reject unrelated input" {
    try std.testing.expect(score("next change", "Next change").? < score("next change", "Next unreviewed change").?);
    try std.testing.expect(score("srnvw", "src/native/view.zig") != null);
    try std.testing.expect(score("xyz", "src/native/view.zig") == null);
    for (commands, 0..) |command, index| for (commands[index + 1 ..]) |other| try std.testing.expect(!std.mem.eql(u8, command.id, other.id));
}

pub fn primary(name: []const u8, shift: bool) ?Action {
    if (std.ascii.eqlIgnoreCase(name, "k") or (shift and std.ascii.eqlIgnoreCase(name, "p"))) return .commands;
    if (std.ascii.eqlIgnoreCase(name, "p")) return .files;
    if (std.ascii.eqlIgnoreCase(name, "f")) return .search;
    if (std.ascii.eqlIgnoreCase(name, "b")) return .sidebar;
    if (std.ascii.eqlIgnoreCase(name, "o")) return .open_repo;
    if (std.ascii.eqlIgnoreCase(name, "r")) return .refresh;
    if (shift and std.ascii.eqlIgnoreCase(name, "n")) return .notes;
    if (std.mem.eql(u8, name, "\\") or std.ascii.eqlIgnoreCase(name, "backslash")) return .split;
    return null;
}
test "primary shortcuts preserve native clipboard and text editing chords" {
    try std.testing.expectEqual(Action.commands, primary("k", false).?);
    try std.testing.expectEqual(Action.commands, primary("p", true).?);
    try std.testing.expectEqual(Action.files, primary("p", false).?);
    try std.testing.expectEqual(Action.split, primary("\\", false).?);
    try std.testing.expect(primary("c", false) == null);
    try std.testing.expect(primary("v", false) == null);
    try std.testing.expect(primary("z", false) == null);
}

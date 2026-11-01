//! The runtime palette: the built-in themes, and deriving every surface and
//! text tier from a theme's few colors.

const std = @import("std");
const canvas = @import("native_sdk").canvas;
pub const body_size: f32 = 13;
pub const clear = canvas.Color.rgba8(0, 0, 0, 0);

/// Every color Patch paints with. Noir carries the values measured from Rex's
/// static-noir theme; other themes derive theirs from a handful of colors the
/// way Rex does: each surface and text tier is a fixed mix of the background
/// toward the foreground, by appearance.
pub const Palette = struct {
    dark: bool = true,
    background: canvas.Color,
    chrome: canvas.Color,
    raised: canvas.Color,
    selection: canvas.Color,
    border: canvas.Color,
    muted: canvas.Color,
    ink: canvas.Color,
    green: canvas.Color,
    red: canvas.Color,
    added: canvas.Color,
    removed: canvas.Color,
    glass: canvas.Color,
    glass_edge: canvas.Color,
    palette: canvas.Color,
    palette_active: canvas.Color,
    window: canvas.Color,
    pane: canvas.Color,
    sidebar_ink: canvas.Color,
    inactive_ink: canvas.Color,
    sidebar_inactive: canvas.Color,
    tertiary: canvas.Color,
    secondary: canvas.Color,
    selected: canvas.Color,
    selected_edge: canvas.Color,
    field: canvas.Color,
    segment_on: canvas.Color,
    card: canvas.Color,
    hairline: canvas.Color,
    switch_on: canvas.Color,
    accent: canvas.Color,
    settings_panel: canvas.Color,
    settings_bg: canvas.Color,
    settings_divider: canvas.Color,
    header: canvas.Color,
    header_current: canvas.Color,
    text_selection: canvas.Color,
    match: canvas.Color,
    current_line: canvas.Color,
    gutter_added: canvas.Color,
    gutter_removed: canvas.Color,
    line_number: canvas.Color,
    stroke_subtle: canvas.Color,
    split_rule: canvas.Color,
    padding_row: canvas.Color,
    palette_glass: canvas.Color,
    palette_field: canvas.Color,
    keycap: canvas.Color,
    palette_ink: canvas.Color,
    palette_hint: canvas.Color,
    switch_off: canvas.Color,
    pane_edge: canvas.Color,
    hunk: canvas.Color,
    menu: canvas.Color,
    note: canvas.Color,
    search_hit: canvas.Color,
    syntax_comment: canvas.Color,
    syntax_keyword: canvas.Color,
    syntax_literal: canvas.Color,
    syntax_function: canvas.Color,
    syntax_property: canvas.Color,
    syntax_constant: canvas.Color,
    word_added: canvas.Color,
    word_removed: canvas.Color,
    /// Lines a diff moved rather than changed: a cool wash and its ink.
    moved: canvas.Color,
    moved_ink: canvas.Color,
    /// Types, in highlighted code.
    syntax_type: canvas.Color,
};

/// Rex static-noir, measured: the default theme, solid panes.
pub const noir: Palette = .{
    .background = canvas.Color.rgb8(35, 35, 35),
    .chrome = canvas.Color.rgb8(43, 43, 43),
    .raised = canvas.Color.rgb8(50, 50, 50),
    .selection = canvas.Color.rgb8(58, 58, 58),
    .border = canvas.Color.rgb8(61, 61, 61),
    .muted = canvas.Color.rgb8(151, 151, 151),
    .ink = canvas.Color.rgb8(237, 237, 237),
    .green = canvas.Color.rgb8(167, 208, 141),
    .red = canvas.Color.rgb8(255, 58, 48),
    .added = canvas.Color.rgb8(31, 36, 28),
    .removed = canvas.Color.rgb8(43, 21, 18),
    .glass = canvas.Color.rgba8(36, 36, 36, 110),
    .glass_edge = canvas.Color.rgba8(255, 255, 255, 40),
    .palette = canvas.Color.rgba8(35, 35, 35, 220),
    .palette_active = canvas.Color.rgb8(199, 12, 8),
    .window = canvas.Color.rgba8(10, 10, 10, 156),
    .pane = canvas.Color.rgb8(10, 10, 10),
    .sidebar_ink = canvas.Color.rgb8(180, 180, 180),
    .inactive_ink = canvas.Color.rgb8(192, 192, 192),
    .sidebar_inactive = canvas.Color.rgb8(172, 172, 172),
    .tertiary = canvas.Color.rgb8(101, 101, 101),
    .secondary = canvas.Color.rgb8(129, 129, 129),
    .selected = canvas.Color.rgba8(237, 237, 237, 12),
    .selected_edge = canvas.Color.rgba8(237, 237, 237, 22),
    .field = canvas.Color.rgba8(237, 237, 237, 10),
    .segment_on = canvas.Color.rgba8(237, 237, 237, 26),
    .card = canvas.Color.rgb8(14, 14, 14),
    .hairline = canvas.Color.rgba8(237, 237, 237, 16),
    .switch_on = canvas.Color.rgb8(150, 150, 150),
    .accent = canvas.Color.rgb8(255, 25, 20),
    .settings_panel = canvas.Color.rgb8(13, 13, 13),
    .settings_bg = canvas.Color.rgb8(7, 7, 7),
    .settings_divider = canvas.Color.rgb8(39, 39, 39),
    .header = canvas.Color.rgb8(25, 25, 25),
    .header_current = canvas.Color.rgb8(34, 34, 34),
    .text_selection = canvas.Color.rgb8(51, 51, 51),
    .match = canvas.Color.rgb8(38, 34, 23),
    .current_line = canvas.Color.rgba8(237, 237, 237, 20),
    .gutter_added = canvas.Color.rgb8(126, 160, 104),
    .gutter_removed = canvas.Color.rgb8(176, 88, 78),
    .line_number = canvas.Color.rgb8(88, 88, 88),
    .stroke_subtle = canvas.Color.rgb8(44, 44, 44),
    .split_rule = canvas.Color.rgb8(30, 30, 30),
    .padding_row = canvas.Color.rgb8(15, 15, 15),
    .palette_glass = canvas.Color.rgba8(34, 33, 33, 176),
    .palette_field = canvas.Color.rgba8(237, 237, 237, 34),
    .keycap = canvas.Color.rgba8(237, 237, 237, 32),
    .palette_ink = canvas.Color.rgb8(246, 246, 246),
    .palette_hint = canvas.Color.rgb8(150, 150, 150),
    .switch_off = canvas.Color.rgba8(237, 237, 237, 40),
    .pane_edge = canvas.Color.rgba8(0, 0, 0, 0),
    .hunk = canvas.Color.rgb8(20, 20, 20),
    // Menus and notices: an opaque raised surface (a blur drew a square
    // backdrop behind their rounded corners).
    .menu = canvas.Color.rgb8(37, 37, 37),
    // Notes in amber, a color the diff never uses.
    .note = canvas.Color.rgb8(232, 182, 76),
    .search_hit = canvas.Color.rgb8(98, 84, 40),
    .syntax_comment = canvas.Color.rgb8(122, 122, 122),
    .syntax_keyword = canvas.Color.rgb8(200, 148, 206),
    .syntax_literal = canvas.Color.rgb8(198, 192, 152),
    .syntax_function = canvas.Color.rgb8(136, 177, 230),
    .syntax_property = canvas.Color.rgb8(124, 208, 212),
    .syntax_constant = canvas.Color.rgb8(227, 194, 95),
    .word_added = canvas.Color.rgb8(52, 76, 40),
    .word_removed = canvas.Color.rgb8(96, 34, 28),
    .moved = canvas.Color.rgb8(22, 28, 38),
    .moved_ink = canvas.Color.rgb8(124, 160, 208),
    .syntax_type = canvas.Color.rgb8(232, 160, 110),
};

// The palette in effect. Views read these; `apply` replaces them all.
pub var background: canvas.Color = noir.background;
pub var chrome: canvas.Color = noir.chrome;
pub var raised: canvas.Color = noir.raised;
pub var selection: canvas.Color = noir.selection;
pub var border: canvas.Color = noir.border;
pub var muted: canvas.Color = noir.muted;
pub var ink: canvas.Color = noir.ink;
pub var green: canvas.Color = noir.green;
pub var red: canvas.Color = noir.red;
pub var added: canvas.Color = noir.added;
pub var removed: canvas.Color = noir.removed;
pub var glass: canvas.Color = noir.glass;
pub var glass_edge: canvas.Color = noir.glass_edge;
pub var palette: canvas.Color = noir.palette;
pub var palette_active: canvas.Color = noir.palette_active;
pub var window: canvas.Color = noir.window;
pub var pane: canvas.Color = noir.pane;
pub var sidebar_ink: canvas.Color = noir.sidebar_ink;
pub var inactive_ink: canvas.Color = noir.inactive_ink;
pub var sidebar_inactive: canvas.Color = noir.sidebar_inactive;
pub var tertiary: canvas.Color = noir.tertiary;
pub var secondary: canvas.Color = noir.secondary;
pub var selected: canvas.Color = noir.selected;
pub var selected_edge: canvas.Color = noir.selected_edge;
pub var field: canvas.Color = noir.field;
pub var segment_on: canvas.Color = noir.segment_on;
pub var card: canvas.Color = noir.card;
pub var hairline: canvas.Color = noir.hairline;
pub var switch_on: canvas.Color = noir.switch_on;
pub var accent: canvas.Color = noir.accent;
pub var settings_panel: canvas.Color = noir.settings_panel;
pub var settings_bg: canvas.Color = noir.settings_bg;
pub var settings_divider: canvas.Color = noir.settings_divider;
pub var header: canvas.Color = noir.header;
pub var header_current: canvas.Color = noir.header_current;
pub var text_selection: canvas.Color = noir.text_selection;
pub var match: canvas.Color = noir.match;
pub var current_line: canvas.Color = noir.current_line;
pub var gutter_added: canvas.Color = noir.gutter_added;
pub var gutter_removed: canvas.Color = noir.gutter_removed;
pub var line_number: canvas.Color = noir.line_number;
pub var stroke_subtle: canvas.Color = noir.stroke_subtle;
pub var split_rule: canvas.Color = noir.split_rule;
pub var padding_row: canvas.Color = noir.padding_row;
pub var palette_glass: canvas.Color = noir.palette_glass;
pub var palette_field: canvas.Color = noir.palette_field;
pub var keycap: canvas.Color = noir.keycap;
pub var palette_ink: canvas.Color = noir.palette_ink;
pub var palette_hint: canvas.Color = noir.palette_hint;
pub var switch_off: canvas.Color = noir.switch_off;
pub var pane_edge: canvas.Color = noir.pane_edge;
pub var hunk: canvas.Color = noir.hunk;
pub var menu: canvas.Color = noir.menu;
pub var note: canvas.Color = noir.note;
pub var search_hit: canvas.Color = noir.search_hit;
pub var syntax_comment: canvas.Color = noir.syntax_comment;
pub var syntax_keyword: canvas.Color = noir.syntax_keyword;
pub var syntax_literal: canvas.Color = noir.syntax_literal;
pub var syntax_function: canvas.Color = noir.syntax_function;
pub var syntax_property: canvas.Color = noir.syntax_property;
pub var syntax_constant: canvas.Color = noir.syntax_constant;
pub var word_added: canvas.Color = noir.word_added;
pub var word_removed: canvas.Color = noir.word_removed;
pub var moved: canvas.Color = noir.moved;
pub var moved_ink: canvas.Color = noir.moved_ink;
pub var syntax_type: canvas.Color = noir.syntax_type;
pub var dark: bool = true;

/// Whether a native blur sits behind the canvas: glass.m installs one on
/// macOS, under the window tint. Other platforms have neither, so glass
/// panes are macOS-only and the canvas paints the window color itself.
pub const native_blur = @import("builtin").os.tag == .macos;

/// The window's background where the canvas must paint it: clear over the
/// native blur on macOS; elsewhere the tint over an even backdrop close to
/// what macOS's sidebar material shows behind it, so panes read the same.
pub fn windowFill() canvas.Color {
    if (native_blur) return clear;
    const backdrop = if (dark) canvas.Color.rgba8(38, 38, 38, 255) else canvas.Color.rgba8(236, 236, 236, 255);
    return mix(backdrop, window, window.a);
}

/// The frosted palettes' surface: translucent over a backdrop blur on macOS.
/// Elsewhere the reference renderer's blur costs a whole frame (about 200 ms
/// in the CPU renderer on Linux), so they go without it, and opaque.
pub fn paletteFill() canvas.Color {
    if (native_blur) return palette_glass;
    return mix(windowFill(), palette_glass, palette_glass.a);
}

pub fn apply(next: Palette) void {
    dark = next.dark;
    inline for (@typeInfo(Palette).@"struct".fields) |member| {
        if (comptime !std.mem.eql(u8, member.name, "dark")) @field(@This(), member.name) = @field(next, member.name);
    }
}

/// A color scheme: what a theme is made from.
pub const Scheme = struct {
    id: []const u8,
    name: []const u8,
    dark: bool,
    background: canvas.Color,
    foreground: canvas.Color,
    accent: canvas.Color,
    red: canvas.Color,
    green: canvas.Color,
    yellow: canvas.Color,
    blue: canvas.Color,
    magenta: canvas.Color,
    cyan: canvas.Color,
};

fn hex(comptime text: []const u8) canvas.Color {
    @setEvalBranchQuota(100_000);
    return comptime parseHex(text) orelse @compileError("bad color " ++ text);
}
/// "#rrggbb" or "rrggbb" to a color.
pub fn parseHex(text: []const u8) ?canvas.Color {
    const digits = if (text.len > 0 and text[0] == '#') text[1..] else text;
    if (digits.len != 6) return null;
    const value = std.fmt.parseInt(u24, digits, 16) catch return null;
    return canvas.Color.rgb8(@intCast(value >> 16), @intCast((value >> 8) & 0xff), @intCast(value & 0xff));
}
pub fn formatHex(buffer: *[7]u8, color: canvas.Color) []const u8 {
    const channel = struct {
        fn of(value: f32) u8 {
            return @intFromFloat(@round(std.math.clamp(value, 0, 1) * 255));
        }
    }.of;
    return std.fmt.bufPrint(buffer, "#{x:0>2}{x:0>2}{x:0>2}", .{ channel(color.r), channel(color.g), channel(color.b) }) catch buffer[0..0];
}

/// Built-in schemes. Noir is Patch's own (Rex static-noir values); the rest
/// use the published palettes of open-source themes (MIT): Nord, Gruvbox,
/// Tokyo Night, Catppuccin, Rosé Pine, Solarized and Dracula.
pub const schemes = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk [_]Scheme{
    .{ .id = "noir", .name = "Noir", .dark = true, .background = hex("#0a0a0a"), .foreground = hex("#ededed"), .accent = hex("#ff1914"), .red = hex("#ff3a30"), .green = hex("#a7d08d"), .yellow = hex("#e3c25f"), .blue = hex("#88b1e6"), .magenta = hex("#c894ce"), .cyan = hex("#7cd0d4") },
    .{ .id = "nord", .name = "Nord", .dark = true, .background = hex("#2e3440"), .foreground = hex("#d8dee9"), .accent = hex("#88c0d0"), .red = hex("#bf616a"), .green = hex("#a3be8c"), .yellow = hex("#ebcb8b"), .blue = hex("#81a1c1"), .magenta = hex("#b48ead"), .cyan = hex("#8fbcbb") },
    .{ .id = "gruvbox", .name = "Gruvbox", .dark = true, .background = hex("#282828"), .foreground = hex("#ebdbb2"), .accent = hex("#fe8019"), .red = hex("#fb4934"), .green = hex("#b8bb26"), .yellow = hex("#fabd2f"), .blue = hex("#83a598"), .magenta = hex("#d3869b"), .cyan = hex("#8ec07c") },
    .{ .id = "tokyo-night", .name = "Tokyo Night", .dark = true, .background = hex("#1a1b26"), .foreground = hex("#c0caf5"), .accent = hex("#7aa2f7"), .red = hex("#f7768e"), .green = hex("#9ece6a"), .yellow = hex("#e0af68"), .blue = hex("#7aa2f7"), .magenta = hex("#bb9af7"), .cyan = hex("#7dcfff") },
    .{ .id = "mocha", .name = "Catppuccin Mocha", .dark = true, .background = hex("#1e1e2e"), .foreground = hex("#cdd6f4"), .accent = hex("#cba6f7"), .red = hex("#f38ba8"), .green = hex("#a6e3a1"), .yellow = hex("#f9e2af"), .blue = hex("#89b4fa"), .magenta = hex("#f5c2e7"), .cyan = hex("#94e2d5") },
    .{ .id = "rose-pine", .name = "Rosé Pine", .dark = true, .background = hex("#191724"), .foreground = hex("#e0def4"), .accent = hex("#ebbcba"), .red = hex("#eb6f92"), .green = hex("#9ccfd8"), .yellow = hex("#f6c177"), .blue = hex("#31748f"), .magenta = hex("#c4a7e7"), .cyan = hex("#9ccfd8") },
    .{ .id = "solarized-dark", .name = "Solarized Dark", .dark = true, .background = hex("#002b36"), .foreground = hex("#93a1a1"), .accent = hex("#268bd2"), .red = hex("#dc322f"), .green = hex("#859900"), .yellow = hex("#b58900"), .blue = hex("#268bd2"), .magenta = hex("#d33682"), .cyan = hex("#2aa198") },
    .{ .id = "dracula", .name = "Dracula", .dark = true, .background = hex("#282a36"), .foreground = hex("#f8f8f2"), .accent = hex("#bd93f9"), .red = hex("#ff5555"), .green = hex("#50fa7b"), .yellow = hex("#f1fa8c"), .blue = hex("#bd93f9"), .magenta = hex("#ff79c6"), .cyan = hex("#8be9fd") },
    .{ .id = "paper", .name = "Paper", .dark = false, .background = hex("#fbfbfa"), .foreground = hex("#1f1f1f"), .accent = hex("#e5341f"), .red = hex("#d93025"), .green = hex("#2e8b3e"), .yellow = hex("#b7791f"), .blue = hex("#2f6fd6"), .magenta = hex("#9b4dca"), .cyan = hex("#1f8a8a") },
    .{ .id = "latte", .name = "Catppuccin Latte", .dark = false, .background = hex("#eff1f5"), .foreground = hex("#4c4f69"), .accent = hex("#8839ef"), .red = hex("#d20f39"), .green = hex("#40a02b"), .yellow = hex("#df8e1d"), .blue = hex("#1e66f5"), .magenta = hex("#ea76cb"), .cyan = hex("#179299") },
    .{ .id = "solarized-light", .name = "Solarized Light", .dark = false, .background = hex("#fdf6e3"), .foreground = hex("#586e75"), .accent = hex("#268bd2"), .red = hex("#dc322f"), .green = hex("#859900"), .yellow = hex("#b58900"), .blue = hex("#268bd2"), .magenta = hex("#d33682"), .cyan = hex("#2aa198") },
    .{ .id = "dawn", .name = "Rosé Pine Dawn", .dark = false, .background = hex("#faf4ed"), .foreground = hex("#575279"), .accent = hex("#d7827e"), .red = hex("#b4637a"), .green = hex("#56949f"), .yellow = hex("#ea9d34"), .blue = hex("#286983"), .magenta = hex("#907aa9"), .cyan = hex("#56949f") },
};
};
pub fn schemeIndex(id: []const u8) ?usize {
    for (schemes, 0..) |scheme, index| if (std.mem.eql(u8, scheme.id, id)) return index;
    return null;
}

fn mix(a: canvas.Color, b: canvas.Color, t: f32) canvas.Color {
    return .{ .r = std.math.clamp(a.r + (b.r - a.r) * t, 0, 1), .g = std.math.clamp(a.g + (b.g - a.g) * t, 0, 1), .b = std.math.clamp(a.b + (b.b - a.b) * t, 0, 1), .a = 1 };
}
fn alpha(color: canvas.Color, a: u8) canvas.Color {
    return .{ .r = color.r, .g = color.g, .b = color.b, .a = @as(f32, @floatFromInt(a)) / 255 };
}

/// A palette from a scheme, by Rex's rule: surfaces and text tiers are fixed
/// mixes of the background toward the foreground (the factors are Noir's own
/// values), state colors tint the background, and syntax uses the scheme's
/// colors. `glass` makes the panes translucent over the window's blur, as
/// Rex's Modern material does, so their fills become overlays.
pub fn derive(scheme: Scheme, translucent: bool) Palette {
    const bg = scheme.background;
    const fg = scheme.foreground;
    const light = !scheme.dark;
    const k = struct {
        fn of(s: Scheme, t: f32) canvas.Color {
            return mix(s.background, s.foreground, t);
        }
    }.of;
    // Low-alpha overlays need a little more weight on light grounds.
    const lift: f32 = if (light) 1.5 else 1;
    const over = struct {
        fn of(color: canvas.Color, a: f32, scale: f32) canvas.Color {
            return alpha(color, @intFromFloat(@min(255, a * scale)));
        }
    }.of;
    const white = canvas.Color.rgb8(255, 255, 255);
    const black = canvas.Color.rgb8(0, 0, 0);
    var result: Palette = .{
        .dark = scheme.dark,
        .background = k(scheme, 0.11),
        .chrome = k(scheme, 0.145),
        .raised = k(scheme, 0.176),
        .selection = k(scheme, 0.21),
        .border = k(scheme, 0.225),
        .muted = k(scheme, 0.62),
        .ink = fg,
        .green = scheme.green,
        .red = scheme.red,
        .added = mix(bg, scheme.green, if (light) 0.16 else 0.135),
        .removed = mix(bg, scheme.red, if (light) 0.13 else 0.14),
        .glass = alpha(k(scheme, 0.115), 110),
        .glass_edge = if (light) alpha(black, 30) else alpha(white, 40),
        .palette = alpha(if (light) mix(bg, white, 0.6) else k(scheme, 0.11), if (light) 240 else 220),
        .palette_active = if (light) scheme.accent else mix(scheme.accent, black, 0.22),
        // The rail sits a step from the panes (Noir: 26 against 10): lighter on
        // dark themes, darker on light ones, steady over any wallpaper.
        .window = alpha(k(scheme, if (light) 0.07 else 0.075), if (light) 225 else 215),
        .pane = bg,
        .sidebar_ink = k(scheme, 0.749),
        .inactive_ink = k(scheme, 0.80),
        .sidebar_inactive = k(scheme, 0.714),
        .tertiary = k(scheme, 0.40),
        .secondary = k(scheme, 0.524),
        .selected = over(fg, 12, lift),
        .selected_edge = over(fg, 22, lift),
        .field = over(fg, 10, lift),
        .segment_on = over(fg, 26, lift),
        .card = if (light) mix(bg, white, 0.7) else k(scheme, 0.0176),
        .hairline = over(fg, 16, lift),
        .switch_on = k(scheme, 0.617),
        .accent = scheme.accent,
        .settings_panel = if (light) mix(bg, black, 0.03) else k(scheme, 0.0132),
        .settings_bg = if (light) mix(bg, black, 0.05) else k(scheme, -0.013),
        .settings_divider = k(scheme, 0.128),
        .header = k(scheme, 0.066),
        .header_current = k(scheme, 0.106),
        .text_selection = k(scheme, 0.18),
        .match = mix(bg, scheme.yellow, 0.18),
        .current_line = over(fg, 20, lift),
        .gutter_added = mix(bg, scheme.green, 0.75),
        .gutter_removed = mix(bg, scheme.red, 0.68),
        .line_number = k(scheme, 0.343),
        .stroke_subtle = k(scheme, 0.15),
        .split_rule = k(scheme, 0.088),
        .padding_row = k(scheme, 0.022),
        .palette_glass = alpha(if (light) mix(bg, white, 0.5) else k(scheme, 0.105), if (light) 225 else 176),
        .palette_field = over(fg, 34, lift),
        .keycap = over(fg, 32, lift),
        .palette_ink = if (light) mix(fg, black, 0.3) else mix(fg, white, 0.5),
        .palette_hint = k(scheme, 0.617),
        .switch_off = over(fg, 40, lift),
        .pane_edge = clear,
        // Each hunk is a bubble a step from the pane (Noir: 20 on 10).
        .hunk = k(scheme, if (light) 0.035 else 0.044),
        .menu = if (light) mix(bg, white, 0.75) else k(scheme, 0.12),
        .note = scheme.yellow,
        .search_hit = mix(bg, scheme.yellow, if (light) 0.35 else 0.4),
        .syntax_comment = k(scheme, 0.49),
        .syntax_keyword = scheme.magenta,
        .syntax_literal = mix(scheme.yellow, fg, 0.45),
        .syntax_function = scheme.blue,
        .syntax_property = scheme.cyan,
        .syntax_constant = scheme.yellow,
        .word_added = mix(bg, scheme.green, if (light) 0.32 else 0.3),
        .word_removed = mix(bg, scheme.red, if (light) 0.3 else 0.35),
        .moved = mix(bg, scheme.blue, if (light) 0.12 else 0.13),
        .moved_ink = mix(bg, scheme.blue, 0.82),
        // Types between the constants' yellow and the red, softened.
        .syntax_type = mix(mix(scheme.yellow, scheme.red, 0.4), fg, 0.2),
    };
    if (translucent) {
        // Rex's Modern material: the pane is the theme ground at about half
        // strength over the window's blur, edged by a faint stroke; what sits
        // on it becomes an overlay so the blur reads through evenly.
        result.pane = alpha(bg, if (light) 150 else 125);
        // A thinner window tint, so the blur reads through rail and panes alike.
        result.window = alpha(k(scheme, if (light) 0.07 else 0.075), if (light) 120 else 105);
        result.pane_edge = over(fg, 26, lift);
        result.hunk = over(fg, 9, lift);
        result.header = over(fg, 17, lift);
        result.header_current = over(fg, 27, lift);
        result.text_selection = over(fg, 46, lift);
        result.added = alpha(scheme.green, if (light) 46 else 38);
        result.removed = alpha(scheme.red, if (light) 40 else 38);
        result.moved = alpha(scheme.blue, if (light) 40 else 36);
        result.background = over(fg, 28, lift);
    }
    return result;
}

pub const palette_width: f32 = 330;
pub const palette_top: f32 = 75.5;
pub const palette_row: f32 = 28;
pub const palette_rows: f32 = 14;
pub const sidebar_width: f32 = 227;
pub const band_height: f32 = 45;
pub const pane_inset: f32 = 8;
pub const pane_radius: f32 = 10;
pub const pane_header: f32 = 34;
pub const notes_width: f32 = 294;
pub const row_height: f32 = 30;
pub const row_pitch: f32 = 32;
pub const rail_left: f32 = 10;
pub const rail_min: f32 = 159;
pub const rail_max: f32 = 472;
pub const notes_min: f32 = 240;
pub const notes_max: f32 = 560;
pub const rail_right: f32 = 2.5;
pub const motion_ms: u32 = 240;

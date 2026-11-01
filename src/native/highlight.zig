//! Syntax highlighting with tree-sitter. Each language's grammar is compiled
//! into the app (see `addHighlighter` in build.zig) along with the highlight
//! query its repository ships; this module parses a whole file, runs the
//! query and turns the captures into a few colors per line.
//!
//! `highlight` is safe to call from any thread. Queries compile once, the
//! first time their language is used, and are shared; every call makes its
//! own parser and query cursor.

const std = @import("std");
const builtin = @import("builtin");
const grammars = @import("highlight_grammars");
const regex = @import("regex.zig");

pub const Kind = enum(u8) { plain = 0, comment, keyword, string, function, property, constant, type };

/// A styled run within one line: byte offsets into the line's text (no newline).
pub const Token = struct { start: u32, end: u32, kind: Kind };

pub const Highlights = struct {
    /// Only non-plain runs, in order.
    tokens: []const Token,
    /// Line i's tokens are tokens[lines[i]..lines[i+1]]; len = line_count + 1.
    lines: []const u32,

    /// Line `index` (0-based); out of range gives no tokens.
    pub fn line(self: Highlights, index: usize) []const Token {
        if (index + 1 >= self.lines.len) return &.{};
        return self.tokens[self.lines[index]..self.lines[index + 1]];
    }

    pub fn deinit(self: Highlights, alloc: std.mem.Allocator) void {
        alloc.free(self.tokens);
        alloc.free(self.lines);
    }
};

pub const Language = enum {
    c,
    cpp,
    objc,
    rust,
    go,
    python,
    javascript,
    typescript,
    tsx,
    zig,
    java,
    kotlin,
    swift,
    c_sharp,
    ruby,
    php,
    lua,
    bash,
    nix,
    json,
    yaml,
    toml,
    css,
    scss,
    html,
    markdown,
    /// Markdown's inline syntax: only ever injected into `markdown`.
    markdown_inline,
    sql,
    make,
    dockerfile,
    cmake,
    haskell,
    ocaml,
    elixir,
    scala,
    dart,
    proto,
    graphql,
    hcl,
    vue,
    svelte,
};

/// Files past this size are left plain.
pub const max_source_bytes = 2 * 1024 * 1024;
/// Parsing and querying one file stop after this long. Past its outer
/// language, embedded ones left unfinished keep the colors around them;
/// otherwise the file is left plain.
pub const time_budget_ns = 200 * std.time.ns_per_ms;
/// How deep injections nest: Markdown's inline syntax inside a block, HTML
/// inside that, and the script inside the HTML.
const max_injection_depth = 3;

// ---------------------------------------------------------------------------
// Languages by file name

const basenames = std.StaticStringMap(Language).initComptime(.{
    .{ "Makefile", .make },         .{ "makefile", .make },         .{ "GNUmakefile", .make },         .{ "BSDmakefile", .make },
    .{ "Dockerfile", .dockerfile }, .{ "dockerfile", .dockerfile }, .{ "Containerfile", .dockerfile }, .{ "CMakeLists.txt", .cmake },
    .{ ".bashrc", .bash },          .{ ".bash_profile", .bash },    .{ ".bash_login", .bash },         .{ ".bash_logout", .bash },
    .{ ".profile", .bash },         .{ ".zshrc", .bash },           .{ ".zshenv", .bash },             .{ ".zprofile", .bash },
    .{ ".zlogin", .bash },          .{ ".zlogout", .bash },         .{ ".envrc", .bash },              .{ "PKGBUILD", .bash },
    .{ "APKBUILD", .bash },         .{ "flake.lock", .json },       .{ "composer.lock", .json },       .{ ".babelrc", .json },
    .{ ".eslintrc", .json },        .{ ".prettierrc", .json },      .{ ".swcrc", .json },              .{ "Cargo.lock", .toml },
    .{ "Pipfile", .toml },          .{ "poetry.lock", .toml },      .{ "uv.lock", .toml },             .{ ".clang-format", .yaml },
    .{ ".clang-tidy", .yaml },      .{ ".clangd", .yaml },          .{ "Gemfile", .ruby },             .{ "Rakefile", .ruby },
    .{ "Podfile", .ruby },          .{ "Fastfile", .ruby },         .{ "Brewfile", .ruby },            .{ "Vagrantfile", .ruby },
    .{ "Guardfile", .ruby },        .{ "Appfile", .ruby },          .{ "Dangerfile", .ruby },          .{ ".irbrc", .ruby },
    .{ "BUILD", .python },          .{ "BUILD.bazel", .python },    .{ "WORKSPACE", .python },         .{ "WORKSPACE.bazel", .python },
    .{ "MODULE.bazel", .python },   .{ "SConstruct", .python },     .{ "SConscript", .python },        .{ ".luacheckrc", .lua },
});

/// Lowercase extensions without their dot.
const extensions = std.StaticStringMap(Language).initComptime(.{
    .{ "c", .c },              .{ "h", .cpp },                 .{ "glsl", .c },                   .{ "vert", .c },              .{ "frag", .c },
    .{ "hlsl", .c },           .{ "cc", .cpp },                .{ "cpp", .cpp },                  .{ "cxx", .cpp },             .{ "c++", .cpp },
    .{ "hpp", .cpp },          .{ "hh", .cpp },                .{ "hxx", .cpp },                  .{ "h++", .cpp },             .{ "ipp", .cpp },
    .{ "tpp", .cpp },          .{ "inl", .cpp },               .{ "ixx", .cpp },                  .{ "cppm", .cpp },            .{ "cu", .cpp },
    .{ "cuh", .cpp },          .{ "ino", .cpp },               .{ "metal", .cpp },                .{ "m", .objc },              .{ "mm", .objc },
    .{ "rs", .rust },          .{ "go", .go },                 .{ "py", .python },                .{ "pyi", .python },          .{ "pyw", .python },
    .{ "bzl", .python },       .{ "star", .python },           .{ "gyp", .python },               .{ "gypi", .python },         .{ "js", .javascript },
    .{ "mjs", .javascript },   .{ "cjs", .javascript },        .{ "jsx", .javascript },           .{ "ts", .typescript },       .{ "mts", .typescript },
    .{ "cts", .typescript },   .{ "tsx", .tsx },               .{ "zig", .zig },                  .{ "zon", .zig },             .{ "java", .java },
    .{ "kt", .kotlin },        .{ "kts", .kotlin },            .{ "swift", .swift },              .{ "cs", .c_sharp },          .{ "csx", .c_sharp },
    .{ "rb", .ruby },          .{ "rake", .ruby },             .{ "gemspec", .ruby },             .{ "ru", .ruby },             .{ "podspec", .ruby },
    .{ "php", .php },          .{ "phtml", .php },             .{ "lua", .lua },                  .{ "sh", .bash },             .{ "bash", .bash },
    .{ "zsh", .bash },         .{ "ksh", .bash },              .{ "bats", .bash },                .{ "command", .bash },        .{ "ebuild", .bash },
    .{ "nix", .nix },          .{ "json", .json },             .{ "jsonc", .json },               .{ "json5", .json },          .{ "jsonl", .json },
    .{ "geojson", .json },     .{ "webmanifest", .json },      .{ "har", .json },                 .{ "code-workspace", .json }, .{ "yml", .yaml },
    .{ "yaml", .yaml },        .{ "toml", .toml },             .{ "css", .css },                  .{ "scss", .scss },           .{ "less", .scss },
    .{ "html", .html },        .{ "htm", .html },              .{ "xhtml", .html },               .{ "md", .markdown },         .{ "markdown", .markdown },
    .{ "mkd", .markdown },     .{ "mdown", .markdown },        .{ "sql", .sql },                  .{ "mk", .make },             .{ "mak", .make },
    .{ "make", .make },        .{ "dockerfile", .dockerfile }, .{ "containerfile", .dockerfile }, .{ "cmake", .cmake },         .{ "hs", .haskell },
    .{ "hs-boot", .haskell },  .{ "ml", .ocaml },              .{ "ex", .elixir },                .{ "exs", .elixir },          .{ "scala", .scala },
    .{ "sc", .scala },         .{ "sbt", .scala },             .{ "dart", .dart },                .{ "proto", .proto },         .{ "graphql", .graphql },
    .{ "graphqls", .graphql }, .{ "gql", .graphql },           .{ "hcl", .hcl },                  .{ "tf", .hcl },              .{ "tfvars", .hcl },
    .{ "nomad", .hcl },        .{ "vue", .vue },               .{ "svelte", .svelte },
});

/// Names a Markdown fence, an HTML `type` or `lang`, or a tagged template
/// gives an embedded language, beyond the extensions above.
const names = std.StaticStringMap(Language).initComptime(.{
    .{ "c", .c },              .{ "cpp", .cpp },                         .{ "c++", .cpp },               .{ "objc", .objc },
    .{ "objective-c", .objc }, .{ "objectivec", .objc },                 .{ "rust", .rust },             .{ "golang", .go },
    .{ "python", .python },    .{ "python3", .python },                  .{ "javascript", .javascript }, .{ "ecmascript", .javascript },
    .{ "node", .javascript },  .{ "module", .javascript },               .{ "typescript", .typescript }, .{ "csharp", .c_sharp },
    .{ "c#", .c_sharp },       .{ "ruby", .ruby },                       .{ "shell", .bash },            .{ "shellscript", .bash },
    .{ "console", .bash },     .{ "terminal", .bash },                   .{ "yaml", .yaml },             .{ "postcss", .scss },
    .{ "sass", .scss },        .{ "markdown_inline", .markdown_inline }, .{ "makefile", .make },         .{ "docker", .dockerfile },
    .{ "haskell", .haskell },  .{ "ocaml", .ocaml },                     .{ "elixir", .elixir },         .{ "protobuf", .proto },
    .{ "terraform", .hcl },    .{ "importmap", .json },                  .{ "jsonc", .json },            .{ "kotlin", .kotlin },
});

/// Whether this build compiled the language's grammar in (see
/// `-Dhighlight-languages`); `languageFor` and `languageForName` only return
/// languages that are.
pub fn available(language: Language) bool {
    return grammarOf(language).language != null;
}

fn ifAvailable(language: ?Language) ?Language {
    return if (language != null and available(language.?)) language else null;
}

/// The language a file is highlighted as, by its name and then extension.
pub fn languageFor(path: []const u8) ?Language {
    return ifAvailable(languageForPath(path));
}

fn languageForPath(path: []const u8) ?Language {
    const base = std.fs.path.basename(path);
    if (basenames.get(base)) |language| return language;
    if (std.mem.startsWith(u8, base, "Dockerfile.") or std.mem.startsWith(u8, base, "Containerfile.")) return .dockerfile;
    if (std.mem.startsWith(u8, base, "Makefile.")) return .make;
    const ext = std.fs.path.extension(base);
    if (ext.len < 2) return null;
    var buffer: [16]u8 = undefined;
    if (ext.len - 1 > buffer.len) return null;
    return extensions.get(std.ascii.lowerString(&buffer, ext[1..]));
}

/// The language an embedded block names, as in "```rust" or `type="text/css"`.
pub fn languageForName(name: []const u8) ?Language {
    var trimmed = std.mem.trim(u8, name, " \t\r\n\"'{}.");
    if (std.mem.lastIndexOfScalar(u8, trimmed, '/')) |slash| trimmed = trimmed[slash + 1 ..];
    var buffer: [32]u8 = undefined;
    if (trimmed.len == 0 or trimmed.len > buffer.len) return null;
    const lower = std.ascii.lowerString(&buffer, trimmed);
    if (names.get(lower)) |language| return ifAvailable(language);
    if (std.meta.stringToEnum(Language, lower)) |language| return ifAvailable(language);
    return ifAvailable(extensions.get(lower));
}

// ---------------------------------------------------------------------------
// Capture names

/// What each capture name colors, matched on whole dot-separated prefixes:
/// the longest listed prefix wins and unlisted names are plain. A plain
/// capture still claims its node, so a wider pattern can't color it; `null`
/// drops the capture, which then neither colors nor claims anything.
const capture_kinds = [_]struct { []const u8, ?Kind }{
    .{ "comment", .comment },                .{ "markup.quote", .comment },
    .{ "keyword", .keyword },                .{ "conditional", .keyword },
    .{ "repeat", .keyword },                 .{ "include", .keyword },
    .{ "exception", .keyword },              .{ "storageclass", .keyword },
    .{ "preproc", .keyword },                .{ "define", .keyword },
    .{ "type.qualifier", .keyword },         .{ "operator.keyword", .keyword },
    .{ "variable.builtin", .keyword },       .{ "markup.heading", .keyword },
    .{ "text.title", .keyword },             .{ "markup.list", .keyword },
    .{ "string", .string },                  .{ "character", .string },
    .{ "regex", .string },                   .{ "regexp", .string },
    .{ "text.literal", .string },            .{ "text.uri", .string },
    .{ "markup.raw", .string },              .{ "markup.link.url", .string },
    .{ "function", .function },              .{ "method", .function },
    .{ "text.reference", .function },        .{ "markup.link.label", .function },
    .{ "markup.link.text", .function },      .{ "property", .property },
    .{ "field", .property },                 .{ "attribute", .property },
    .{ "tag.attribute", .property },         .{ "variable.member", .property },
    .{ "variable.other.member", .property }, .{ "label", .property },
    .{ "string.special.key", .property },    .{ "constant", .constant },
    .{ "number", .constant },                .{ "float", .constant },
    .{ "boolean", .constant },               .{ "escape", .constant },
    .{ "string.special.symbol", .constant }, .{ "identifier.constant", .constant },
    .{ "type", .type },                      .{ "constructor", .type },
    .{ "tag", .type },                       .{ "namespace", .type },
    .{ "module", .type },                    .{ "tag.delimiter", .plain },
    .{ "spell", null },                      .{ "nospell", null },
    .{ "conceal", null },                    .{ "error", null },
    .{ "local", null },                      .{ "injection", null },
};

fn kindForCapture(name: []const u8) ?Kind {
    if (name.len == 0 or name[0] == '_') return null;
    var best: ?Kind = .plain;
    var best_len: usize = 0;
    for (capture_kinds) |entry| {
        const prefix = entry[0];
        if (prefix.len <= best_len or !std.mem.startsWith(u8, name, prefix)) continue;
        if (name.len != prefix.len and name[prefix.len] != '.') continue;
        best = entry[1];
        best_len = prefix.len;
    }
    return best;
}

// ---------------------------------------------------------------------------
// The tree-sitter C API, as much of it as this file uses

const ts = struct {
    const Language = opaque {};
    const Parser = opaque {};
    const Tree = opaque {};
    const Query = opaque {};
    const QueryCursor = opaque {};
    const Point = extern struct { row: u32, column: u32 };
    const Range = extern struct { start_point: Point, end_point: Point, start_byte: u32, end_byte: u32 };
    const Node = extern struct { context: [4]u32, id: ?*const anyopaque, tree: ?*const anyopaque };
    const TreeCursor = extern struct { tree: ?*const anyopaque, id: ?*const anyopaque, context: [3]u32 };
    const Input = extern struct {
        payload: ?*anyopaque,
        read: *const fn (?*anyopaque, u32, Point, *u32) callconv(.c) [*]const u8,
        encoding: c_uint = 0, // UTF-8
        decode: ?*const anyopaque = null,
    };
    const ParseState = extern struct { payload: ?*anyopaque, current_byte_offset: u32, has_error: bool };
    const ParseOptions = extern struct { payload: ?*anyopaque, progress_callback: ?*const fn (*ParseState) callconv(.c) bool };
    const QueryCursorState = extern struct { payload: ?*anyopaque, current_byte_offset: u32 };
    const QueryCursorOptions = extern struct { payload: ?*anyopaque, progress_callback: ?*const fn (*QueryCursorState) callconv(.c) bool };
    const QueryCapture = extern struct { node: Node, index: u32 };
    const QueryMatch = extern struct { id: u32, pattern_index: u16, capture_count: u16, captures: [*]const QueryCapture };
    const PredicateStep = extern struct { type: enum(c_uint) { done, capture, string, _ }, value_id: u32 };

    extern fn ts_parser_new() ?*Parser;
    extern fn ts_parser_delete(*Parser) void;
    extern fn ts_parser_set_language(*Parser, *const ts.Language) bool;
    extern fn ts_parser_set_included_ranges(*Parser, ?[*]const Range, u32) bool;
    extern fn ts_parser_parse_with_options(*Parser, ?*const Tree, Input, ParseOptions) ?*Tree;
    extern fn ts_tree_delete(*Tree) void;
    extern fn ts_tree_root_node(*const Tree) Node;
    extern fn ts_node_start_byte(Node) u32;
    extern fn ts_node_end_byte(Node) u32;
    extern fn ts_node_start_point(Node) Point;
    extern fn ts_node_end_point(Node) Point;
    extern fn ts_node_type(Node) [*:0]const u8;
    extern fn ts_node_parent(Node) Node;
    extern fn ts_node_is_null(Node) bool;
    extern fn ts_node_is_named(Node) bool;
    extern fn ts_tree_cursor_new(Node) TreeCursor;
    extern fn ts_tree_cursor_delete(*TreeCursor) void;
    extern fn ts_tree_cursor_current_node(*const TreeCursor) Node;
    extern fn ts_tree_cursor_goto_first_child(*TreeCursor) bool;
    extern fn ts_tree_cursor_goto_next_sibling(*TreeCursor) bool;
    extern fn ts_query_new(*const ts.Language, [*]const u8, u32, *u32, *c_uint) ?*Query;
    extern fn ts_query_delete(*Query) void;
    extern fn ts_query_pattern_count(*const Query) u32;
    extern fn ts_query_capture_count(*const Query) u32;
    extern fn ts_query_capture_name_for_id(*const Query, u32, *u32) [*]const u8;
    extern fn ts_query_string_value_for_id(*const Query, u32, *u32) [*]const u8;
    extern fn ts_query_predicates_for_pattern(*const Query, u32, *u32) ?[*]const PredicateStep;
    extern fn ts_query_disable_pattern(*Query, u32) void;
    extern fn ts_query_start_byte_for_pattern(*const Query, u32) u32;
    extern fn ts_query_end_byte_for_pattern(*const Query, u32) u32;
    extern fn ts_query_cursor_new() ?*QueryCursor;
    extern fn ts_query_cursor_delete(*QueryCursor) void;
    extern fn ts_query_cursor_exec_with_options(*QueryCursor, *const Query, Node, *const QueryCursorOptions) void;
    extern fn ts_query_cursor_next_match(*QueryCursor, *QueryMatch) bool;

    extern fn patch_monotonic_ns() u64;
};

fn grammarOf(language: Language) grammars.Grammar {
    return switch (language) {
        inline else => |tag| @field(grammars, @tagName(tag)),
    };
}

fn tsLanguage(language: Language) *const ts.Language {
    return @ptrCast(grammarOf(language).language.?());
}

// ---------------------------------------------------------------------------
// Compiled queries

const Predicate = struct {
    const Op = enum { eq, match, any_of, has_ancestor, has_parent, kind_eq };
    op: Op,
    negate: bool,
    /// `any-` variants hold when one node of a quantified capture does;
    /// otherwise every node must.
    any: bool,
    capture: u32,
    /// `#eq?` against another capture's text, or against `text`.
    other: ?u32 = null,
    text: []const u8 = "",
    /// `#any-of?` strings, or node types for the tree predicates.
    values: []const []const u8 = &.{},
    regex: ?Regex = null,
};

/// An injection pattern's `#set!` properties.
const Setting = struct {
    language: ?[]const u8 = null,
    combined: bool = false,
    include_children: bool = false,
};

const Compiled = struct {
    query: *ts.Query,
    /// Per capture id; null captures are dropped.
    kinds: []const ?Kind,
    /// Per pattern.
    predicates: []const []const Predicate,
    /// Per pattern, how it ranks against others capturing the same node;
    /// see `paintOrder`.
    precedence: []const u32,
    /// Injection queries only.
    settings: []const Setting = &.{},
    content: ?u32 = null,
    language_capture: ?u32 = null,
};

const Entry = struct {
    state: enum { unloaded, ready, failed } = .unloaded,
    highlights: ?*const Compiled = null,
    injections: ?*const Compiled = null,
};

const language_count = @typeInfo(Language).@"enum".fields.len;
var entries: [language_count]Entry = @splat(.{});
var entries_lock: Lock = .{};

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

/// The language's compiled queries, compiled on first use; null when its
/// highlight query does not compile against its grammar.
fn entryFor(language: Language) ?*const Entry {
    entries_lock.lock();
    defer entries_lock.unlock();
    const entry = &entries[@intFromEnum(language)];
    if (entry.state == .unloaded and !available(language)) entry.state = .failed;
    if (entry.state == .unloaded) {
        const grammar = grammarOf(language);
        // Cached for the life of the process.
        const alloc = std.heap.c_allocator;
        entry.highlights = compile(alloc, language, grammar.highlights, false) catch null;
        entry.injections = if (grammar.injections.len == 0) null else compile(alloc, language, grammar.injections, true) catch null;
        entry.state = if (entry.highlights == null) .failed else .ready;
    }
    return if (entry.state == .ready) entry else null;
}

const QueryError = struct { offset: u32, kind: c_uint };
threadlocal var last_query_error: QueryError = .{ .offset = 0, .kind = 0 };

fn compile(alloc: std.mem.Allocator, language: Language, source: []const u8, injections: bool) !*const Compiled {
    var offset: u32 = 0;
    var kind: c_uint = 0;
    const query = ts.ts_query_new(tsLanguage(language), source.ptr, @intCast(source.len), &offset, &kind) orelse {
        last_query_error = .{ .offset = offset, .kind = kind };
        return error.InvalidQuery;
    };
    errdefer ts.ts_query_delete(query);
    const compiled = try alloc.create(Compiled);
    const capture_count = ts.ts_query_capture_count(query);
    const kinds = try alloc.alloc(?Kind, capture_count);
    var content: ?u32 = null;
    var language_capture: ?u32 = null;
    for (kinds, 0..) |*slot, index| {
        const name = captureName(query, @intCast(index));
        slot.* = kindForCapture(name);
        if (std.mem.eql(u8, name, "injection.content") or std.mem.eql(u8, name, "content")) content = @intCast(index);
        if (std.mem.eql(u8, name, "injection.language") or std.mem.eql(u8, name, "language")) language_capture = @intCast(index);
    }
    const pattern_count = ts.ts_query_pattern_count(query);
    const predicates = try alloc.alloc([]const Predicate, pattern_count);
    const settings = try alloc.alloc(Setting, if (injections) pattern_count else 0);
    const precedence = try alloc.alloc(u32, pattern_count);
    const first_wins = grammarOf(language).first_wins and !injections;
    for (predicates, precedence, 0..) |*slot, *rank, pattern| {
        const start = ts.ts_query_start_byte_for_pattern(query, @intCast(pattern));
        const end = ts.ts_query_end_byte_for_pattern(query, @intCast(pattern));
        const structured = isStructured(source[@min(start, source.len)..@min(@max(start, end), source.len)]);
        const order: u32 = @intCast(if (first_wins) pattern_count - 1 - pattern else pattern);
        rank.* = order | @as(u32, @intFromBool(structured)) << 31;
        var setting: Setting = .{};
        slot.* = parsePredicates(alloc, query, @intCast(pattern), &setting) catch |err| switch (err) {
            error.Unsupported => blk: {
                ts.ts_query_disable_pattern(query, @intCast(pattern));
                break :blk &.{};
            },
            else => |e| return e,
        };
        if (injections) settings[pattern] = setting;
    }
    compiled.* = .{ .query = query, .kinds = kinds, .predicates = predicates, .precedence = precedence, .settings = settings, .content = content, .language_capture = language_capture };
    return compiled;
}

/// Whether a pattern's source says more than "this kind of node": nested
/// nodes, fields or predicates. `(identifier) @variable` and
/// `[(true) (false)] @boolean` are bare; `(call_expression function:
/// (identifier) @function)` and `((identifier) @constant (#match? ...))` are
/// structured.
fn isStructured(text: []const u8) bool {
    var depth: u32 = 0;
    // Bit n says whether the paren at nesting n opened a node (not a group).
    var nodes: u64 = 0;
    var parens: u6 = 0;
    var i: usize = 0;
    while (i < text.len) : (i += 1) switch (text[i]) {
        ';' => i = std.mem.indexOfScalarPos(u8, text, i, '\n') orelse text.len,
        '"' => {
            i += 1;
            while (i < text.len and text[i] != '"') : (i += 1) {
                if (text[i] == '\\') i += 1;
            }
        },
        '(' => {
            var next = i + 1;
            while (next < text.len and std.ascii.isWhitespace(text[next])) next += 1;
            if (next < text.len and text[next] == '#') return true;
            const node = next < text.len and (std.ascii.isAlphabetic(text[next]) or text[next] == '_');
            if (node) {
                depth += 1;
                if (depth > 1) return true;
            }
            if (parens == std.math.maxInt(u6)) return true;
            nodes = (nodes & ~(@as(u64, 1) << parens)) | (@as(u64, @intFromBool(node)) << parens);
            parens += 1;
        },
        ')' => if (parens > 0) {
            parens -= 1;
            if (nodes & (@as(u64, 1) << parens) != 0) depth -|= 1;
        },
        ':', '!' => if (depth > 0) return true,
        else => {},
    };
    return false;
}

fn captureName(query: *const ts.Query, id: u32) []const u8 {
    var len: u32 = 0;
    const ptr = ts.ts_query_capture_name_for_id(query, id, &len);
    return ptr[0..len];
}

fn stringValue(query: *const ts.Query, id: u32) []const u8 {
    var len: u32 = 0;
    const ptr = ts.ts_query_string_value_for_id(query, id, &len);
    return ptr[0..len];
}

const Arg = union(enum) { capture: u32, string: []const u8 };

/// Reads a pattern's predicates. Text and tree predicates are kept; others
/// (`#set!` aside, read into `setting`) hold trivially. error.Unsupported
/// means the pattern can't be evaluated faithfully, so it is disabled.
fn parsePredicates(alloc: std.mem.Allocator, query: *ts.Query, pattern: u32, setting: *Setting) ![]const Predicate {
    var step_count: u32 = 0;
    const steps_ptr = ts.ts_query_predicates_for_pattern(query, pattern, &step_count) orelse return &.{};
    const steps = steps_ptr[0..step_count];
    var list: std.ArrayList(Predicate) = .empty;
    var args: std.ArrayList(Arg) = .empty;
    defer args.deinit(alloc);
    var start: usize = 0;
    while (start < steps.len) {
        var end = start;
        while (end < steps.len and steps[end].type != .done) end += 1;
        defer start = end + 1;
        if (end == start or steps[start].type != .string) return error.Unsupported;
        const name = stringValue(query, steps[start].value_id);
        args.clearRetainingCapacity();
        for (steps[start + 1 .. end]) |step| try args.append(alloc, switch (step.type) {
            .capture => .{ .capture = step.value_id },
            .string => .{ .string = stringValue(query, step.value_id) },
            else => return error.Unsupported,
        });
        if (std.mem.eql(u8, name, "set!")) {
            readSetting(args.items, setting);
            continue;
        }
        if (try parsePredicate(alloc, name, args.items)) |predicate| try list.append(alloc, predicate);
    }
    return list.toOwnedSlice(alloc);
}

fn readSetting(args: []const Arg, setting: *Setting) void {
    if (args.len == 0 or args[0] != .string) return;
    const key = args[0].string;
    if (std.mem.eql(u8, key, "injection.language")) {
        if (args.len > 1 and args[1] == .string) setting.language = args[1].string;
    } else if (std.mem.eql(u8, key, "injection.combined")) {
        setting.combined = true;
    } else if (std.mem.eql(u8, key, "injection.include-children")) {
        setting.include_children = true;
    }
}

fn parsePredicate(alloc: std.mem.Allocator, full_name: []const u8, args: []const Arg) !?Predicate {
    var name = full_name;
    var negate = false;
    var any = false;
    if (std.mem.startsWith(u8, name, "any-") and !std.mem.eql(u8, name, "any-of?")) {
        any = true;
        name = name[4..];
    }
    if (std.mem.startsWith(u8, name, "not-")) {
        negate = true;
        name = name[4..];
    }
    const Known = enum { @"eq?", @"match?", @"lua-match?", @"any-of?", @"has-ancestor?", @"has-parent?", @"kind-eq?" };
    const known = std.meta.stringToEnum(Known, name) orelse return null;
    if (args.len < 2 or args[0] != .capture) return error.Unsupported;
    var predicate: Predicate = .{ .op = undefined, .negate = negate, .any = any, .capture = args[0].capture };
    switch (known) {
        .@"eq?" => {
            predicate.op = .eq;
            switch (args[1]) {
                .capture => |id| predicate.other = id,
                .string => |text| predicate.text = text,
            }
        },
        .@"match?", .@"lua-match?" => {
            if (args[1] != .string) return error.Unsupported;
            predicate.op = .match;
            var buffer: std.ArrayList(u8) = .empty;
            defer buffer.deinit(alloc);
            const ignore_case = if (known == .@"lua-match?") try translateLua(alloc, &buffer, args[1].string) else try translateRegex(alloc, &buffer, args[1].string);
            predicate.regex = try Regex.compile(alloc, buffer.items, ignore_case);
        },
        .@"any-of?", .@"has-ancestor?", .@"has-parent?", .@"kind-eq?" => {
            predicate.op = switch (known) {
                .@"any-of?" => .any_of,
                .@"has-ancestor?" => .has_ancestor,
                .@"has-parent?" => .has_parent,
                else => .kind_eq,
            };
            const values = try alloc.alloc([]const u8, args.len - 1);
            for (args[1..], values) |arg, *value| {
                if (arg != .string) return error.Unsupported;
                value.* = arg.string;
            }
            predicate.values = values;
        },
    }
    return predicate;
}

// ---------------------------------------------------------------------------
// Regular expressions: queries are written for Rust's regex crate (`#match?`)
// or Lua patterns (`#lua-match?`); both become POSIX extended expressions.

const ere_special = ".[]()*+?{}|^$\\";

/// What runs the translated expressions: the C library's POSIX regex, or
/// regex.zig on Windows, whose C library has none. regex.zig takes the subset
/// the translation produces and answers as macOS's libc does; the test
/// "regex.zig agrees with libc" holds it to that.
const Regex = if (builtin.os.tag == .windows) PortableRegex else LibcRegex;

/// `REG_EXTENDED | REG_NOSUB` through highlight_support.c.
const LibcRegex = struct {
    handle: *anyopaque,

    extern fn patch_regex_new([*]const u8, usize, c_int) ?*anyopaque;
    extern fn patch_regex_search(*const anyopaque, [*]const u8, usize) c_int;
    extern fn patch_regex_free(?*anyopaque) void;

    /// error.Unsupported when regcomp rejects the pattern.
    fn compile(alloc: std.mem.Allocator, pattern: []const u8, ignore_case: bool) !LibcRegex {
        _ = alloc;
        return .{ .handle = patch_regex_new(pattern.ptr, pattern.len, @intFromBool(ignore_case)) orelse return error.Unsupported };
    }

    fn search(self: LibcRegex, text: []const u8) bool {
        return patch_regex_search(self.handle, text.ptr, text.len) != 0;
    }

    fn deinit(self: LibcRegex) void {
        patch_regex_free(self.handle);
    }
};

const PortableRegex = struct {
    inner: *regex.Regex,

    fn compile(alloc: std.mem.Allocator, pattern: []const u8, ignore_case: bool) !PortableRegex {
        return .{ .inner = try regex.Regex.compile(alloc, pattern, ignore_case) };
    }

    fn search(self: PortableRegex, text: []const u8) bool {
        return self.inner.search(text);
    }

    fn deinit(self: PortableRegex) void {
        self.inner.deinit();
    }
};

/// Rewrites a Rust regex as a POSIX extended one; returns whether it asked to
/// ignore case. Constructs POSIX has no counterpart for are Unsupported.
fn translateRegex(alloc: std.mem.Allocator, out: *std.ArrayList(u8), pattern_in: []const u8) !bool {
    var pattern = pattern_in;
    var ignore_case = false;
    if (std.mem.startsWith(u8, pattern, "(?i)")) {
        ignore_case = true;
        pattern = pattern[4..];
    }
    var i: usize = 0;
    while (i < pattern.len) : (i += 1) {
        const c = pattern[i];
        switch (c) {
            '\\' => {
                i += 1;
                if (i == pattern.len) return error.Unsupported;
                const e = pattern[i];
                try out.appendSlice(alloc, switch (e) {
                    'd' => "[0-9]",
                    'D' => "[^0-9]",
                    'w' => "[A-Za-z0-9_]",
                    'W' => "[^A-Za-z0-9_]",
                    's' => "[[:space:]]",
                    'S' => "[^[:space:]]",
                    'b' => "\\b",
                    'B' => "\\B",
                    'n' => "\n",
                    't' => "\t",
                    'r' => "\r",
                    'A' => "^",
                    'z' => "$",
                    else => blk: {
                        if (std.ascii.isAlphanumeric(e)) return error.Unsupported;
                        if (std.mem.indexOfScalar(u8, ere_special, e) != null) {
                            try out.append(alloc, '\\');
                        }
                        try out.append(alloc, e);
                        break :blk "";
                    },
                });
            },
            '[' => i = try translateBracket(alloc, out, pattern, i, .regex),
            '(' => {
                if (i + 1 < pattern.len and pattern[i + 1] == '?') {
                    if (i + 2 < pattern.len and pattern[i + 2] == ':') {
                        i += 2;
                    } else return error.Unsupported;
                }
                try out.append(alloc, '(');
            },
            '?' => {
                // A lazy quantifier matches the same strings as a greedy one.
                if (i > 0 and std.mem.indexOfScalar(u8, "*+?}", pattern[i - 1]) != null and !(i > 1 and pattern[i - 2] == '\\')) continue;
                try out.append(alloc, '?');
            },
            else => try out.append(alloc, c),
        }
    }
    return ignore_case;
}

/// Rewrites a Lua pattern as a POSIX extended expression.
fn translateLua(alloc: std.mem.Allocator, out: *std.ArrayList(u8), pattern: []const u8) !bool {
    var i: usize = 0;
    while (i < pattern.len) : (i += 1) {
        const c = pattern[i];
        switch (c) {
            '%' => {
                i += 1;
                if (i == pattern.len) return error.Unsupported;
                const e = pattern[i];
                if (luaClass(e, false)) |class| {
                    try out.appendSlice(alloc, class);
                } else if (std.ascii.isAlphanumeric(e)) {
                    return error.Unsupported;
                } else {
                    if (std.mem.indexOfScalar(u8, ere_special, e) != null) try out.append(alloc, '\\');
                    try out.append(alloc, e);
                }
            },
            '[' => i = try translateBracket(alloc, out, pattern, i, .lua),
            '-' => try out.append(alloc, '*'),
            '^' => try out.appendSlice(alloc, if (i == 0) "^" else "\\^"),
            '$' => try out.appendSlice(alloc, if (i + 1 == pattern.len) "$" else "\\$"),
            '|', '{', '}', '\\' => {
                try out.append(alloc, '\\');
                try out.append(alloc, c);
            },
            else => try out.append(alloc, c),
        }
    }
    return false;
}

fn luaClass(c: u8, in_bracket: bool) ?[]const u8 {
    const outside: []const u8 = switch (c) {
        'a' => "[[:alpha:]]",
        'd' => "[0-9]",
        'l' => "[a-z]",
        's' => "[[:space:]]",
        'u' => "[A-Z]",
        'w' => "[[:alnum:]]",
        'x' => "[[:xdigit:]]",
        'p' => "[[:punct:]]",
        'c' => "[[:cntrl:]]",
        'A' => "[^[:alpha:]]",
        'D' => "[^0-9]",
        'L' => "[^a-z]",
        'S' => "[^[:space:]]",
        'U' => "[^A-Z]",
        'W' => "[^[:alnum:]]",
        'X' => "[^[:xdigit:]]",
        'P' => "[^[:punct:]]",
        else => return null,
    };
    if (!in_bracket) return outside;
    // Inside a bracket only the positive classes fit, without their brackets.
    if (outside[1] == '^') return null;
    return outside[1 .. outside.len - 1];
}

/// Copies the bracket expression opening at pattern[open] and returns the
/// index of its closing `]`. POSIX brackets take no escapes, so escaped
/// characters become literals placed where POSIX reads them literally.
fn translateBracket(alloc: std.mem.Allocator, out: *std.ArrayList(u8), pattern: []const u8, open: usize, syntax: enum { regex, lua }) !usize {
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(alloc);
    var i = open + 1;
    var negate = false;
    var close_bracket = false;
    var dash = false;
    var caret = false;
    if (i < pattern.len and pattern[i] == '^') {
        negate = true;
        i += 1;
    }
    if (i < pattern.len and pattern[i] == ']') {
        close_bracket = true;
        i += 1;
    }
    const escape: u8 = if (syntax == .regex) '\\' else '%';
    while (i < pattern.len and pattern[i] != ']') : (i += 1) {
        const c = pattern[i];
        if (c == '[' and syntax == .regex) {
            // A POSIX class such as [:alpha:] passes through; nested Rust
            // classes and set operations don't.
            if (i + 1 < pattern.len and pattern[i + 1] == ':') {
                const end = std.mem.indexOfPos(u8, pattern, i + 2, ":]") orelse return error.Unsupported;
                try body.appendSlice(alloc, pattern[i .. end + 2]);
                i = end + 1;
                continue;
            }
            return error.Unsupported;
        }
        if (c == escape) {
            i += 1;
            if (i == pattern.len) return error.Unsupported;
            const e = pattern[i];
            const class: ?[]const u8 = if (syntax == .lua) luaClass(e, true) else switch (e) {
                'd' => "0-9",
                'w' => "A-Za-z0-9_",
                's' => "[:space:]",
                'n' => "\n",
                't' => "\t",
                'r' => "\r",
                else => null,
            };
            if (class) |text| {
                try body.appendSlice(alloc, text);
            } else if (std.ascii.isAlphanumeric(e)) {
                return error.Unsupported;
            } else switch (e) {
                ']' => close_bracket = true,
                '-' => dash = true,
                '^' => caret = true,
                else => try body.append(alloc, e),
            }
            continue;
        }
        if (c == '&' and i + 1 < pattern.len and pattern[i + 1] == '&') return error.Unsupported;
        try body.append(alloc, c);
    }
    if (i == pattern.len) return error.Unsupported;
    if (body.items.len == 0 and !close_bracket and !dash and caret) {
        // Only a literal caret: no bracket needed.
        try out.appendSlice(alloc, "\\^");
        return i;
    }
    try out.append(alloc, '[');
    if (negate) try out.append(alloc, '^');
    if (close_bracket) try out.append(alloc, ']');
    try out.appendSlice(alloc, body.items);
    if (caret) try out.append(alloc, '^');
    if (dash) try out.append(alloc, '-');
    try out.append(alloc, ']');
    return i;
}

// ---------------------------------------------------------------------------
// Predicates

fn nodeText(source: []const u8, node: ts.Node) []const u8 {
    const start = @min(ts.ts_node_start_byte(node), source.len);
    const end = @min(ts.ts_node_end_byte(node), source.len);
    return source[start..@max(start, end)];
}

fn satisfied(predicates: []const Predicate, match: *const ts.QueryMatch, source: []const u8) bool {
    for (predicates) |*predicate| if (!holds(predicate, match, source)) return false;
    return true;
}

fn holds(predicate: *const Predicate, match: *const ts.QueryMatch, source: []const u8) bool {
    const captures = match.captures[0..match.capture_count];
    var seen = false;
    for (captures) |capture| {
        if (capture.index != predicate.capture) continue;
        seen = true;
        const result = test_(predicate, capture.node, captures, source) != predicate.negate;
        if (predicate.any and result) return true;
        if (!predicate.any and !result) return false;
    }
    return !seen or !predicate.any;
}

fn test_(predicate: *const Predicate, node: ts.Node, captures: []const ts.QueryCapture, source: []const u8) bool {
    const text = nodeText(source, node);
    switch (predicate.op) {
        .eq => {
            if (predicate.other) |other| {
                for (captures) |capture| if (capture.index == other) return std.mem.eql(u8, text, nodeText(source, capture.node));
                return true;
            }
            return std.mem.eql(u8, text, predicate.text);
        },
        .match => return predicate.regex.?.search(text),
        .any_of => {
            for (predicate.values) |value| if (std.mem.eql(u8, text, value)) return true;
            return false;
        },
        .kind_eq => return typeIn(node, predicate.values),
        .has_parent => {
            const parent = ts.ts_node_parent(node);
            return !ts.ts_node_is_null(parent) and typeIn(parent, predicate.values);
        },
        .has_ancestor => {
            var ancestor = ts.ts_node_parent(node);
            while (!ts.ts_node_is_null(ancestor)) : (ancestor = ts.ts_node_parent(ancestor)) {
                if (typeIn(ancestor, predicate.values)) return true;
            }
            return false;
        },
    }
}

fn typeIn(node: ts.Node, types: []const []const u8) bool {
    const kind = std.mem.span(ts.ts_node_type(node));
    for (types) |value| if (std.mem.eql(u8, kind, value)) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Highlighting

const Capture = struct {
    start: u32,
    end: u32,
    /// Structured patterns above bare ones, then later patterns above
    /// earlier ones; see `paintOrder`.
    precedence: u32,
    kind: Kind,
};

const Budget = struct {
    deadline: u64,
    /// Set from another thread to give up early.
    stop: ?*const std.atomic.Value(bool) = null,
    expired: bool = false,
    fn check(self: *Budget) bool {
        if (!self.expired and ts.patch_monotonic_ns() >= self.deadline) self.expired = true;
        if (!self.expired) if (self.stop) |stop| if (stop.load(.monotonic)) {
            self.expired = true;
        };
        return self.expired;
    }
};

fn parseProgress(state: *ts.ParseState) callconv(.c) bool {
    const budget: *Budget = @ptrCast(@alignCast(state.payload.?));
    return budget.check();
}

fn queryProgress(state: *ts.QueryCursorState) callconv(.c) bool {
    const budget: *Budget = @ptrCast(@alignCast(state.payload.?));
    return budget.check();
}

fn readSource(payload: ?*anyopaque, byte: u32, _: ts.Point, bytes_read: *u32) callconv(.c) [*]const u8 {
    const source: *const []const u8 = @ptrCast(@alignCast(payload.?));
    const at = @min(byte, source.len);
    bytes_read.* = @intCast(source.len - at);
    return source.ptr + at;
}

const Run = struct {
    scratch: std.mem.Allocator,
    source: []const u8,
    kinds: []Kind,
    parser: *ts.Parser,
    cursor: *ts.QueryCursor,
    budget: Budget,
    captures: std.ArrayList(Capture) = .empty,
};

const Error = error{ OutOfMemory, Timeout };

/// Highlights `source` as `language`. Files that are too large, look binary,
/// or don't parse and query within the time budget come back with no tokens;
/// their line table is still complete. Embedded languages (Markdown's inline
/// text and fenced code, HTML's scripts and styles) that don't finish in time
/// keep the colors around them. Free the result with `deinit`.
pub fn highlight(alloc: std.mem.Allocator, language: Language, source: []const u8) !Highlights {
    return highlightUntil(alloc, language, source, null);
}
/// `highlight`, giving up (as if out of time) once `stop` is set.
pub fn highlightUntil(alloc: std.mem.Allocator, language: Language, source: []const u8, stop: ?*const std.atomic.Value(bool)) !Highlights {
    const line_count = std.mem.count(u8, source, "\n") + 1;
    const lines = try alloc.alloc(u32, line_count + 1);
    errdefer alloc.free(lines);
    @memset(lines, 0);
    if (source.len == 0 or source.len > max_source_bytes or looksBinary(source)) return .{ .tokens = &.{}, .lines = lines };

    var arena: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const kinds = try scratch.alloc(Kind, source.len);
    @memset(kinds, .plain);

    const parser = ts.ts_parser_new() orelse return error.OutOfMemory;
    defer ts.ts_parser_delete(parser);
    const cursor = ts.ts_query_cursor_new() orelse return error.OutOfMemory;
    defer ts.ts_query_cursor_delete(cursor);
    var run: Run = .{
        .scratch = scratch,
        .source = source,
        .kinds = kinds,
        .parser = parser,
        .cursor = cursor,
        .budget = .{ .deadline = ts.patch_monotonic_ns() + time_budget_ns, .stop = stop },
    };
    layer(&run, language, null, 0) catch |err| switch (err) {
        error.Timeout => return .{ .tokens = &.{}, .lines = lines },
        error.OutOfMemory => return error.OutOfMemory,
    };
    return .{ .tokens = try tokenize(alloc, source, kinds, lines), .lines = lines };
}

/// Git's test: a NUL in the first 8000 bytes.
fn looksBinary(source: []const u8) bool {
    return std.mem.indexOfScalar(u8, source[0..@min(source.len, 8000)], 0) != null;
}

/// Parses `ranges` of the source (all of it when null) as `language`, paints
/// its captures, then the languages injected into it.
fn layer(run: *Run, language: Language, ranges: ?[]const ts.Range, depth: u8) Error!void {
    const entry = entryFor(language) orelse return;
    if (!ts.ts_parser_set_language(run.parser, tsLanguage(language))) return;
    if (ranges) |list| {
        if (!ts.ts_parser_set_included_ranges(run.parser, list.ptr, @intCast(list.len))) return;
    } else _ = ts.ts_parser_set_included_ranges(run.parser, null, 0);
    var source = run.source;
    const input: ts.Input = .{ .payload = @ptrCast(&source), .read = readSource };
    const tree = ts.ts_parser_parse_with_options(run.parser, null, input, .{ .payload = &run.budget, .progress_callback = parseProgress }) orelse
        return if (run.budget.expired) error.Timeout else {};
    defer ts.ts_tree_delete(tree);
    const root = ts.ts_tree_root_node(tree);

    run.captures.clearRetainingCapacity();
    try collect(run, entry.highlights.?, root);
    paint(run, ranges);
    if (depth < max_injection_depth) if (entry.injections) |injections| {
        // Out of time, embedded languages keep the colors of the one around
        // them; only the outermost language must finish.
        inject(run, injections, root, depth) catch |err| switch (err) {
            error.Timeout => {},
            error.OutOfMemory => |e| return e,
        };
    };
}

fn collect(run: *Run, compiled: *const Compiled, root: ts.Node) Error!void {
    const options: ts.QueryCursorOptions = .{ .payload = &run.budget, .progress_callback = queryProgress };
    ts.ts_query_cursor_exec_with_options(run.cursor, compiled.query, root, &options);
    var match: ts.QueryMatch = undefined;
    while (ts.ts_query_cursor_next_match(run.cursor, &match)) {
        if (!satisfied(compiled.predicates[match.pattern_index], &match, run.source)) continue;
        for (match.captures[0..match.capture_count]) |capture| {
            const kind = compiled.kinds[capture.index] orelse continue;
            const start = ts.ts_node_start_byte(capture.node);
            const end = @min(ts.ts_node_end_byte(capture.node), @as(u32, @intCast(run.source.len)));
            if (start >= end) continue;
            try run.captures.append(run.scratch, .{ .start = start, .end = end, .precedence = compiled.precedence[match.pattern_index], .kind = kind });
        }
    }
    if (run.budget.expired) return error.Timeout;
}

/// Outer captures sort first so inner ones paint over them. Of captures on
/// one range, only the first painted counts. tree-sitter-highlight lets the
/// last pattern win, and most grammars write their queries that way, with
/// fallbacks such as `(identifier) @variable` first. Go's and Nix's are still
/// written for Atom, where the first won (`first_wins` in build.zig), and a
/// few others misplace a fallback. So a structured pattern beats a bare one
/// wherever it sits, and among those alike the query's own rule decides.
/// Within a pattern a colored capture beats a plain one.
fn paintOrder(_: void, a: Capture, b: Capture) bool {
    if (a.start != b.start) return a.start < b.start;
    if (a.end != b.end) return a.end > b.end;
    if (a.precedence != b.precedence) return a.precedence > b.precedence;
    return @intFromEnum(a.kind) > @intFromEnum(b.kind);
}

fn paint(run: *Run, ranges: ?[]const ts.Range) void {
    const captures = run.captures.items;
    std.sort.pdq(Capture, captures, {}, paintOrder);
    var last_start: u32 = std.math.maxInt(u32);
    var last_end: u32 = std.math.maxInt(u32);
    for (captures) |capture| {
        if (capture.start == last_start and capture.end == last_end) continue;
        last_start = capture.start;
        last_end = capture.end;
        const list = ranges orelse {
            @memset(run.kinds[capture.start..capture.end], capture.kind);
            continue;
        };
        // An injected tree's nodes can span the gaps between its ranges,
        // which belong to the outer language.
        var index = firstRangeEndingAfter(list, capture.start);
        while (index < list.len and list[index].start_byte < capture.end) : (index += 1) {
            const start = @max(capture.start, list[index].start_byte);
            const end = @min(capture.end, list[index].end_byte);
            if (start < end) @memset(run.kinds[start..end], capture.kind);
        }
    }
}

fn firstRangeEndingAfter(ranges: []const ts.Range, byte: u32) usize {
    var low: usize = 0;
    var high: usize = ranges.len;
    while (low < high) {
        const mid = (low + high) / 2;
        if (ranges[mid].end_byte <= byte) low = mid + 1 else high = mid;
    }
    return low;
}

const Pending = struct {
    language: Language,
    pattern: u32,
    combined: bool,
    ranges: std.ArrayList(ts.Range) = .empty,
};

fn inject(run: *Run, compiled: *const Compiled, root: ts.Node, depth: u8) Error!void {
    const content_capture = compiled.content orelse return;
    var pending: std.ArrayList(Pending) = .empty;
    const options: ts.QueryCursorOptions = .{ .payload = &run.budget, .progress_callback = queryProgress };
    ts.ts_query_cursor_exec_with_options(run.cursor, compiled.query, root, &options);
    var match: ts.QueryMatch = undefined;
    while (ts.ts_query_cursor_next_match(run.cursor, &match)) {
        if (!satisfied(compiled.predicates[match.pattern_index], &match, run.source)) continue;
        const setting = compiled.settings[match.pattern_index];
        const captures = match.captures[0..match.capture_count];
        var language: ?Language = if (setting.language) |name| languageForName(name) else null;
        if (compiled.language_capture) |id| for (captures) |capture| {
            if (capture.index == id) language = languageForName(nodeText(run.source, capture.node));
        };
        const target = language orelse continue;
        const combined = setting.combined;
        for (captures) |capture| {
            if (capture.index != content_capture) continue;
            const into = found: {
                if (combined) for (pending.items) |*item| {
                    if (item.combined and item.pattern == match.pattern_index and item.language == target) break :found item;
                };
                try pending.append(run.scratch, .{ .language = target, .pattern = match.pattern_index, .combined = combined });
                break :found &pending.items[pending.items.len - 1];
            };
            try appendNodeRanges(run.scratch, &into.ranges, capture.node, setting.include_children);
        }
    }
    if (run.budget.expired) return error.Timeout;

    // Where two patterns inject into the same node, the later one wins.
    for (pending.items, 0..) |*item, index| {
        if (item.ranges.items.len == 0) continue;
        if (item.combined) std.sort.pdq(ts.Range, item.ranges.items, {}, rangeOrder);
        const superseded = for (pending.items[index + 1 ..]) |other| {
            if (other.ranges.items.len > 0 and other.pattern > item.pattern and
                other.ranges.items[0].start_byte == item.ranges.items[0].start_byte) break true;
        } else false;
        if (superseded) continue;
        try layer(run, item.language, item.ranges.items, depth + 1);
    }
}

fn rangeOrder(_: void, a: ts.Range, b: ts.Range) bool {
    return a.start_byte < b.start_byte;
}

/// The node's extent, less its named children unless the injection includes
/// them. Anonymous children stay, as in nvim-treesitter, whose injection
/// queries these are: Markdown's block grammar leaves punctuation tokens
/// inside the `inline` text it hands to the inline grammar.
fn appendNodeRanges(alloc: std.mem.Allocator, ranges: *std.ArrayList(ts.Range), node: ts.Node, include_children: bool) !void {
    var start_byte = ts.ts_node_start_byte(node);
    var start_point = ts.ts_node_start_point(node);
    if (!include_children) {
        var cursor = ts.ts_tree_cursor_new(node);
        defer ts.ts_tree_cursor_delete(&cursor);
        if (ts.ts_tree_cursor_goto_first_child(&cursor)) while (true) {
            const child = ts.ts_tree_cursor_current_node(&cursor);
            if (!ts.ts_node_is_named(child)) {
                if (!ts.ts_tree_cursor_goto_next_sibling(&cursor)) break;
                continue;
            }
            const child_start = ts.ts_node_start_byte(child);
            if (child_start > start_byte) try ranges.append(alloc, .{
                .start_point = start_point,
                .end_point = ts.ts_node_start_point(child),
                .start_byte = start_byte,
                .end_byte = child_start,
            });
            start_byte = @max(start_byte, ts.ts_node_end_byte(child));
            start_point = ts.ts_node_end_point(child);
            if (!ts.ts_tree_cursor_goto_next_sibling(&cursor)) break;
        };
    }
    const end_byte = ts.ts_node_end_byte(node);
    if (end_byte > start_byte) try ranges.append(alloc, .{
        .start_point = start_point,
        .end_point = ts.ts_node_end_point(node),
        .start_byte = start_byte,
        .end_byte = end_byte,
    });
}

/// Splits the painted bytes into per-line runs, filling `lines`.
fn tokenize(alloc: std.mem.Allocator, source: []const u8, kinds: []const Kind, lines: []u32) ![]const Token {
    var tokens: std.ArrayList(Token) = .empty;
    errdefer tokens.deinit(alloc);
    var start: usize = 0;
    var index: usize = 0;
    while (index + 1 < lines.len) : (index += 1) {
        const newline = std.mem.indexOfScalarPos(u8, source, start, '\n') orelse source.len;
        var end = newline;
        if (end > start and source[end - 1] == '\r') end -= 1;
        var at = start;
        while (at < end) {
            const kind = kinds[at];
            if (kind == .plain) {
                at += 1;
                continue;
            }
            var stop = at + 1;
            while (stop < end and kinds[stop] == kind) stop += 1;
            try tokens.append(alloc, .{ .start = @intCast(at - start), .end = @intCast(stop - start), .kind = kind });
            at = stop;
        }
        lines[index + 1] = @intCast(tokens.items.len);
        start = newline + 1;
    }
    return tokens.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// Tests

const testing = std.testing;

/// The kind of each run on `line`, written as `text:kind` pairs.
fn expectLine(highlights: Highlights, source: []const u8, line_index: usize, expected: []const struct { []const u8, Kind }) !void {
    var start: usize = 0;
    for (0..line_index) |_| start = std.mem.indexOfScalarPos(u8, source, start, '\n').? + 1;
    const end = std.mem.indexOfScalarPos(u8, source, start, '\n') orelse source.len;
    const text = source[start..end];
    for (expected) |pair| {
        const at = std.mem.indexOf(u8, text, pair[0]) orelse {
            std.debug.print("`{s}` is not on line {d}: {s}\n", .{ pair[0], line_index, text });
            return error.TestExpectedText;
        };
        const kind = kindAt(highlights.line(line_index), @intCast(at));
        if (kind != pair[1]) {
            std.debug.print("line {d} `{s}`: expected {t}, found {t}\n  {s}\n", .{ line_index, pair[0], pair[1], kind, text });
            return error.TestUnexpectedKind;
        }
        // The whole word shares the color.
        const last = kindAt(highlights.line(line_index), @intCast(at + pair[0].len - 1));
        if (last != pair[1]) {
            std.debug.print("line {d} `{s}` ends as {t}\n", .{ line_index, pair[0], last });
            return error.TestUnexpectedKind;
        }
    }
}

fn kindAt(tokens: []const Token, byte: u32) Kind {
    for (tokens) |token| if (byte >= token.start and byte < token.end) return token.kind;
    return .plain;
}

/// Skips a test whose language this build left out.
fn need(language: Language) !void {
    if (!available(language)) return error.SkipZigTest;
}

test "every language's queries compile against its grammar" {
    for (std.enums.values(Language)) |language| {
        if (!available(language)) continue;
        const entry = entryFor(language) orelse {
            std.debug.print("{t}: highlight query failed at byte {d} (error {d})\n", .{ language, last_query_error.offset, last_query_error.kind });
            return error.TestQueryDidNotCompile;
        };
        if (grammarOf(language).injections.len > 0 and entry.injections == null) {
            std.debug.print("{t}: injection query failed at byte {d} (error {d})\n", .{ language, last_query_error.offset, last_query_error.kind });
            return error.TestQueryDidNotCompile;
        }
    }
}

test "languageFor maps extensions and file names" {
    try need(.zig);
    try need(.rust);
    try need(.typescript);
    try need(.tsx);
    try need(.javascript);
    try need(.cpp);
    try need(.c);
    try need(.objc);
    try need(.make);
    try need(.dockerfile);
    try need(.cmake);
    try need(.bash);
    try need(.json);
    try need(.toml);
    try need(.ruby);
    try need(.hcl);
    try need(.markdown);
    try need(.yaml);
    try need(.python);
    try testing.expectEqual(Language.zig, languageFor("src/native/highlight.zig").?);
    try testing.expectEqual(Language.zig, languageFor("build.zig.zon").?);
    try testing.expectEqual(Language.rust, languageFor("a/b/lib.rs").?);
    try testing.expectEqual(Language.typescript, languageFor("x.ts").?);
    try testing.expectEqual(Language.tsx, languageFor("x.tsx").?);
    try testing.expectEqual(Language.javascript, languageFor("x.jsx").?);
    try testing.expectEqual(Language.cpp, languageFor("include/foo.h").?);
    try testing.expectEqual(Language.c, languageFor("foo.c").?);
    try testing.expectEqual(Language.cpp, languageFor("FOO.CPP").?);
    try testing.expectEqual(Language.objc, languageFor("AppDelegate.m").?);
    try testing.expectEqual(Language.make, languageFor("Makefile").?);
    try testing.expectEqual(Language.make, languageFor("sub/GNUmakefile").?);
    try testing.expectEqual(Language.dockerfile, languageFor("docker/Dockerfile").?);
    try testing.expectEqual(Language.dockerfile, languageFor("Dockerfile.dev").?);
    try testing.expectEqual(Language.cmake, languageFor("CMakeLists.txt").?);
    try testing.expectEqual(Language.bash, languageFor("/home/u/.bashrc").?);
    try testing.expectEqual(Language.bash, languageFor(".zshrc").?);
    try testing.expectEqual(Language.json, languageFor("flake.lock").?);
    try testing.expectEqual(Language.toml, languageFor("Cargo.lock").?);
    try testing.expectEqual(Language.ruby, languageFor("Gemfile").?);
    try testing.expectEqual(Language.hcl, languageFor("main.tf").?);
    try testing.expectEqual(Language.markdown, languageFor("README.md").?);
    try testing.expectEqual(Language.yaml, languageFor(".github/workflows/ci.yml").?);
    try testing.expectEqual(@as(?Language, null), languageFor("notes.txt"));
    try testing.expectEqual(@as(?Language, null), languageFor("LICENSE"));
    try testing.expectEqual(@as(?Language, null), languageFor(".gitignore"));
    try testing.expectEqual(@as(?Language, null), languageFor("archive.tar.gz"));
    try testing.expectEqual(Language.javascript, languageForName("text/javascript").?);
    try testing.expectEqual(Language.rust, languageForName("rs").?);
    try testing.expectEqual(Language.bash, languageForName("sh").?);
    try testing.expectEqual(Language.python, languageForName("Python").?);
}

test "an empty file has one empty line" {
    const result = try highlight(testing.allocator, .zig, "");
    defer result.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 2), result.lines.len);
    try testing.expectEqual(@as(usize, 0), result.line(0).len);
    try testing.expectEqual(@as(usize, 0), result.line(1).len);
    try testing.expectEqual(@as(usize, 0), result.line(99).len);
}

test "zig" {
    try need(.zig);
    const source =
        \\const std = @import("std");
        \\/// Adds.
        \\pub fn add(a: u32, b: u32) u32 {
        \\    return a + b + 0x10; // sum
        \\}
        \\const s = Point{ .x = 1 };
        \\const text =
        \\    \\first
        \\    \\second
        \\;
    ;
    const result = try highlight(testing.allocator, .zig, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{ .{ "const", .keyword }, .{ "@import", .keyword }, .{ "\"std\"", .string } });
    try expectLine(result, source, 1, &.{.{ "/// Adds.", .comment }});
    try expectLine(result, source, 2, &.{ .{ "pub", .keyword }, .{ "fn", .keyword }, .{ "add", .function }, .{ "u32", .type } });
    try expectLine(result, source, 3, &.{ .{ "return", .keyword }, .{ "0x10", .constant }, .{ "// sum", .comment } });
    try expectLine(result, source, 5, &.{ .{ "Point", .type }, .{ "x", .property }, .{ "1", .constant } });
    try expectLine(result, source, 7, &.{.{ "\\\\first", .string }});
    try expectLine(result, source, 8, &.{.{ "\\\\second", .string }});
}

test "rust" {
    try need(.rust);
    const source =
        \\/* a block
        \\   comment */
        \\fn main() {
        \\    let s = "tab\there";
        \\    println!("{}", MAX_SIZE);
        \\    let v: Vec<u8> = Vec::new();
        \\    if v.is_empty() { return; }
        \\}
    ;
    const result = try highlight(testing.allocator, .rust, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{.{ "/* a block", .comment }});
    try expectLine(result, source, 1, &.{.{ "   comment */", .comment }});
    try expectLine(result, source, 2, &.{ .{ "fn", .keyword }, .{ "main", .function } });
    // The escape inside the string is its own color; the string resumes after it.
    try expectLine(result, source, 3, &.{ .{ "let", .keyword }, .{ "\"tab", .string }, .{ "\\t", .constant }, .{ "here\"", .string } });
    try expectLine(result, source, 4, &.{ .{ "println!", .function }, .{ "MAX_SIZE", .constant } });
    try expectLine(result, source, 5, &.{ .{ "Vec", .type }, .{ "u8", .type }, .{ "new", .function } });
    try expectLine(result, source, 6, &.{ .{ "if", .keyword }, .{ "is_empty", .function }, .{ "return", .keyword } });
}

test "typescript" {
    try need(.typescript);
    const source =
        \\import { readFile } from "node:fs";
        \\// load it
        \\export async function load(path: string): Promise<number> {
        \\  const value = `count ${path.length}`;
        \\  return this.cache.get(path) ?? 42;
        \\}
        \\interface Point { x: number }
    ;
    const result = try highlight(testing.allocator, .typescript, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{ .{ "import", .keyword }, .{ "from", .keyword }, .{ "\"node:fs\"", .string } });
    try expectLine(result, source, 1, &.{.{ "// load it", .comment }});
    try expectLine(result, source, 2, &.{ .{ "export", .keyword }, .{ "async", .keyword }, .{ "function", .keyword }, .{ "load", .function }, .{ "string", .type }, .{ "Promise", .type } });
    // Template interpolation: the string around it, the code inside it plain.
    try expectLine(result, source, 3, &.{ .{ "`count ", .string }, .{ "path", .plain }, .{ "length", .property } });
    try expectLine(result, source, 4, &.{ .{ "return", .keyword }, .{ "this", .keyword }, .{ "get", .function }, .{ "42", .constant } });
    try expectLine(result, source, 6, &.{ .{ "interface", .keyword }, .{ "Point", .type }, .{ "x", .property } });
}

test "python" {
    try need(.python);
    const source =
        \\import os
        \\
        \\class Greeter(Base):
        \\    """Docs
        \\    span lines."""
        \\    def greet(self, name: str) -> None:
        \\        print(f"hi {name}", 3.5)  # say it
        \\        return None
    ;
    const result = try highlight(testing.allocator, .python, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{.{ "import", .keyword }});
    try expectLine(result, source, 2, &.{ .{ "class", .keyword }, .{ "Greeter", .type } });
    try expectLine(result, source, 3, &.{.{ "\"\"\"Docs", .string }});
    try expectLine(result, source, 4, &.{.{ "    span lines.\"\"\"", .string }});
    try expectLine(result, source, 5, &.{ .{ "def", .keyword }, .{ "greet", .function }, .{ "str", .type }, .{ "None", .constant } });
    try expectLine(result, source, 6, &.{ .{ "print", .function }, .{ "f\"hi ", .string }, .{ "3.5", .constant }, .{ "# say it", .comment } });
    try expectLine(result, source, 7, &.{.{ "return", .keyword }});
}

test "c" {
    try need(.c);
    const source =
        \\#include <stdio.h>
        \\#define MAX 10
        \\/* multi
        \\ * line */
        \\static int count(const char *s) {
        \\    struct point p = { .x = 1 };
        \\    printf("%d\n", MAX);
        \\    return p.x;
        \\}
    ;
    const result = try highlight(testing.allocator, .c, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{ .{ "#include", .keyword }, .{ "<stdio.h>", .string } });
    try expectLine(result, source, 1, &.{.{ "#define", .keyword }});
    try expectLine(result, source, 2, &.{.{ "/* multi", .comment }});
    try expectLine(result, source, 3, &.{.{ " * line */", .comment }});
    try expectLine(result, source, 4, &.{ .{ "static", .keyword }, .{ "int", .type }, .{ "count", .function }, .{ "const", .keyword }, .{ "char", .type } });
    try expectLine(result, source, 5, &.{ .{ "struct", .keyword }, .{ "point", .type }, .{ "x", .property }, .{ "1", .constant } });
    try expectLine(result, source, 6, &.{ .{ "printf", .function }, .{ "\"%d", .string }, .{ "MAX", .constant } });
    try expectLine(result, source, 7, &.{ .{ "return", .keyword }, .{ "x", .property } });
}

test "json" {
    try need(.json);
    const source =
        \\{
        \\  "name": "patch\n",
        \\  "count": 3,
        \\  "ok": true,
        \\  "none": null
        \\}
    ;
    const result = try highlight(testing.allocator, .json, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 1, &.{ .{ "\"name\"", .property }, .{ "\"patch", .string }, .{ "\\n", .constant } });
    try expectLine(result, source, 2, &.{.{ "3", .constant }});
    try expectLine(result, source, 3, &.{.{ "true", .constant }});
    try expectLine(result, source, 4, &.{.{ "null", .constant }});
}

test "markdown fences take their language's colors" {
    try need(.markdown);
    try need(.markdown_inline);
    try need(.zig);
    const source =
        \\# Title
        \\
        \\Some `code` here.
        \\
        \\```zig
        \\const x = 1;
        \\```
    ;
    const result = try highlight(testing.allocator, .markdown, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{.{ "Title", .keyword }});
    try expectLine(result, source, 2, &.{ .{ "Some", .plain }, .{ "code", .string } });
    try expectLine(result, source, 5, &.{ .{ "const", .keyword }, .{ "1", .constant } });
}

test "html script and style" {
    try need(.html);
    try need(.javascript);
    try need(.css);
    const source =
        \\<div class="a">
        \\<script>let n = 1;</script>
        \\<style>p { color: red; }</style>
        \\</div>
    ;
    const result = try highlight(testing.allocator, .html, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{ .{ "div", .type }, .{ "class", .property }, .{ "\"a\"", .string } });
    try expectLine(result, source, 1, &.{ .{ "script", .type }, .{ "let", .keyword }, .{ "1", .constant } });
    try expectLine(result, source, 2, &.{ .{ "style", .type }, .{ "color", .property } });
}

test "carriage returns stay out of tokens" {
    try need(.c);
    const source = "// one\r\nint x;\r\n";
    const result = try highlight(testing.allocator, .c, source);
    defer result.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 4), result.lines.len);
    const first = result.line(0);
    try testing.expectEqual(@as(usize, 1), first.len);
    try testing.expectEqual(Token{ .start = 0, .end = 6, .kind = .comment }, first[0]);
}

test "binary, invalid UTF-8 and oversized input" {
    try need(.c);
    const binary = "\x00\x01\x02int x;\n";
    const a = try highlight(testing.allocator, .c, binary);
    defer a.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), a.tokens.len);
    try testing.expectEqual(@as(usize, 3), a.lines.len);

    const invalid = "int \xff\xfe x = 1; // \xc3\n\"\xe2\x82\";\n";
    const b = try highlight(testing.allocator, .c, invalid);
    defer b.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 4), b.lines.len);

    const big = try testing.allocator.alloc(u8, max_source_bytes + 1);
    defer testing.allocator.free(big);
    @memset(big, 'a');
    const c = try highlight(testing.allocator, .c, big);
    defer c.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), c.tokens.len);
}

test "every language highlights a little source" {
    const samples = [_]struct { Language, []const u8 }{
        .{ .cpp, "namespace a { template <typename T> class B { public: int x = 0; }; }" },
        .{ .objc, "@interface Foo : NSObject\n- (void)bar;\n@end\n" },
        .{ .go, "package main\nfunc main() { fmt.Println(\"hi\") }\n" },
        .{ .javascript, "const a = <div className=\"x\">{b}</div>;\n" },
        .{ .tsx, "const a: number = <A b={1} />;\n" },
        .{ .java, "public class A { void b() { return; } }\n" },
        .{ .kotlin, "fun main() { val x = \"s\" }\n" },
        .{ .swift, "func f() -> Int { return 1 }\n" },
        .{ .c_sharp, "class A { void B() { var s = \"x\"; } }\n" },
        .{ .ruby, "def a\n  puts \"x\"\nend\n" },
        .{ .php, "<?php\nfunction a() { return \"x\"; }\n?>\n<p>hi</p>\n" },
        .{ .lua, "local function f() return \"x\" end\n" },
        .{ .bash, "if [ -f x ]; then echo \"hi\"; fi\n" },
        .{ .nix, "{ pkgs, ... }: { a = \"x\"; }\n" },
        .{ .yaml, "a: 1\nb: \"x\"\n" },
        .{ .toml, "[a]\nb = \"x\"\n" },
        .{ .css, "@import \"x.css\";\na { color: red; }\n" },
        .{ .scss, "$x: 1px;\n@mixin m { a { margin: $x; } }\n" },
        .{ .sql, "SELECT a FROM b WHERE c = 'x';\n" },
        .{ .make, "ifdef DEBUG\nall: x\n\techo \"hi\"\nendif\n" },
        .{ .dockerfile, "FROM alpine\nRUN echo hi\n" },
        .{ .cmake, "project(a)\nset(X \"y\")\n" },
        .{ .haskell, "main :: IO ()\nmain = putStrLn \"hi\"\n" },
        .{ .ocaml, "let x = \"s\" in print_string x\n" },
        .{ .elixir, "defmodule A do\n  def b, do: :ok\nend\n" },
        .{ .scala, "object A { def b: Int = 1 }\n" },
        .{ .dart, "void main() { print('hi'); }\n" },
        .{ .proto, "syntax = \"proto3\";\nmessage A { string b = 1; }\n" },
        .{ .graphql, "query A { b(c: 1) { d } }\n" },
        .{ .hcl, "resource \"a\" \"b\" { c = \"d\" }\n" },
        .{ .vue, "<template><p>{{ a }}</p></template>\n<script>export default { a: 1 }</script>\n" },
        .{ .svelte, "<script>let a = 1;</script>\n<p>{a}</p>\n" },
    };
    for (samples) |sample| {
        if (!available(sample[0])) continue;
        const result = try highlight(testing.allocator, sample[0], sample[1]);
        defer result.deinit(testing.allocator);
        if (result.tokens.len == 0) {
            std.debug.print("{t} produced no tokens\n", .{sample[0]});
            return error.TestNoTokens;
        }
        var string = false;
        for (result.tokens) |token| string = string or token.kind == .string or token.kind == .keyword;
        if (!string) {
            std.debug.print("{t} found no string or keyword\n", .{sample[0]});
            return error.TestNoTokens;
        }
    }
}

test "bare and structured patterns" {
    try testing.expect(!isStructured("(identifier) @variable"));
    try testing.expect(!isStructured("[\n  (true)\n  (false) ; ( not code\n] @boolean"));
    try testing.expect(!isStructured("((identifier) @variable)"));
    try testing.expect(!isStructured("\"(\" @punctuation.bracket"));
    try testing.expect(isStructured("(call_expression\n  function: (identifier) @function)"));
    try testing.expect(isStructured("((identifier) @constant\n (#match? @constant \"^[A-Z]\"))"));
    try testing.expect(isStructured("(method_declaration name: (field_identifier) @function.method)"));
}

test "nix builtins win over the later generic patterns" {
    try need(.nix);
    const source = "{ a = true; b = builtins.map; }";
    const result = try highlight(testing.allocator, .nix, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 0, &.{ .{ "a", .property }, .{ "true", .keyword }, .{ "builtins", .keyword } });
}

test "a structured pattern beats a later bare one" {
    try need(.go);
    // tree-sitter-go lists `(field_identifier) @property` after its method patterns.
    const source = "package main\nfunc (p *P) Move() { fmt.Println(p.x) }\n";
    const result = try highlight(testing.allocator, .go, source);
    defer result.deinit(testing.allocator);
    try expectLine(result, source, 1, &.{ .{ "Move", .function }, .{ "Println", .function }, .{ "x", .property } });
}

test "regex translation" {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    _ = try translateRegex(testing.allocator, &out, "^[A-Z][A-Z\\d_]*$");
    try testing.expectEqualStrings("^[A-Z][A-Z0-9_]*$", out.items);
    out.clearRetainingCapacity();
    _ = try translateRegex(testing.allocator, &out, "^(?:self|super)\\.?$");
    try testing.expectEqualStrings("^(self|super)\\.?$", out.items);
    out.clearRetainingCapacity();
    _ = try translateRegex(testing.allocator, &out, "[\\-\\]a]+?");
    try testing.expectEqualStrings("[]a-]+", out.items);
    out.clearRetainingCapacity();
    _ = try translateLua(testing.allocator, &out, "^%u[%w_]*$");
    try testing.expectEqualStrings("^[A-Z][[:alnum:]_]*$", out.items);
    out.clearRetainingCapacity();
    _ = try translateLua(testing.allocator, &out, "%slang%s*=");
    try testing.expectEqualStrings("[[:space:]]lang[[:space:]]*=", out.items);
    out.clearRetainingCapacity();
    try testing.expectError(error.Unsupported, translateRegex(testing.allocator, &out, "\\p{Lu}"));

    const constant = try Regex.compile(testing.allocator, "^[A-Z][A-Z0-9_]*$", false);
    defer constant.deinit();
    try testing.expect(constant.search("MAX_SIZE"));
    try testing.expect(constant.search("MAX_SIZE and more"[0..8]));
    try testing.expect(!constant.search("Max"));
}

test "two threads share the query cache" {
    try need(.rust);
    const Worker = struct {
        fn run(failed: *std.atomic.Value(bool)) void {
            for (0..20) |_| {
                const result = highlight(std.heap.c_allocator, .rust, "fn main() { let x = 1; }") catch {
                    failed.store(true, .seq_cst);
                    return;
                };
                defer result.deinit(std.heap.c_allocator);
                if (result.tokens.len == 0) failed.store(true, .seq_cst);
            }
        }
    };
    var failed: std.atomic.Value(bool) = .init(false);
    const a = try std.Thread.spawn(.{}, Worker.run, .{&failed});
    const b = try std.Thread.spawn(.{}, Worker.run, .{&failed});
    a.join();
    b.join();
    try testing.expect(!failed.load(.seq_cst));
}

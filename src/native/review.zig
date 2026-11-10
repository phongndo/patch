//! What Patch remembers about reviews of one repository (or imported patch):
//! the changes reviewed, as records keyed by content rather than by when or
//! where they were seen, and the notes left on them. A file's review carries
//! to any comparison showing the same change; notes stay with the comparison
//! they were left in and follow their lines as the files change.
const std = @import("std");
const patch = @import("patch.zig");

/// A file change someone marked reviewed: its path, both sides' blobs
/// (empty when a side does not exist or the patch named none), the change's
/// own hash (`patch.File.change`, as hex), and the new side's mode.
pub const Record = struct {
    path: []const u8,
    old: []const u8 = "",
    new: []const u8 = "",
    change: []const u8 = "",
    mode: []const u8 = "100644",
};
/// A hunk someone marked reviewed: its path and its change's hash
/// (`patch.Hunk.change`, as hex). Content alone keys it, so the same hunk
/// stays reviewed in any version of the file that still has it.
pub const HunkRecord = struct { path: []const u8, change: []const u8 };
pub const NoteState = enum { open, outdated, resolved };
pub const Note = struct {
    path: []const u8,
    line: u32 = 0,
    line_end: u32 = 0,
    old: bool = false,
    text: []const u8,
    /// The blob of the side the line numbers count in (the new side for a
    /// file note), so the lines can follow later versions.
    blob: []const u8 = "",
    /// The lines the note was left on, as they read then.
    excerpt: []const u8 = "",
    /// Open; outdated once its lines changed; resolved by hand.
    state: NoteState = .open,
    /// The comparison it was left in (`scope`), and the commit, in a
    /// branch's commit-by-commit review.
    scope: []const u8 = "",
    commit: []const u8 = "",
};
/// Where a branch's review last stood, so a rewritten branch can be paired
/// with it commit by commit.
pub const Tip = struct { scope: []const u8, base: []const u8, tip: []const u8 };
/// A commit that has notes or was reviewed, kept to find it after a rewrite
/// when Git no longer has it: by subject and author time.
pub const Mark = struct {
    id: []const u8,
    subject: []const u8 = "",
    time: i64 = 0,
    reviewed: bool = false,
    /// The message's blob when last seen, to show a reworded message's changes.
    message: []const u8 = "",
};
pub const Store = struct {
    version: u32 = 2,
    records: []const Record = &.{},
    notes: []const Note = &.{},
    tips: []const Tip = &.{},
    commits: []const Mark = &.{},
    hunks: []const HunkRecord = &.{},
    /// Saved reviews from before this store, already brought in.
    migrated: []const []const u8 = &.{},
};

/// The comparison notes belong to: "working", "staged", "branch <head>",
/// or "patch" for an imported one.
pub fn scope(buffer: []u8, mode: []const u8, head: []const u8) []const u8 {
    if (std.mem.eql(u8, mode, "branch")) return std.fmt.bufPrint(buffer, "branch {s}", .{head}) catch "branch";
    return mode;
}

pub fn changeHex(file: patch.File) [32]u8 {
    return std.fmt.bytesToHex(file.change, .lower);
}
fn exact(record: Record, file: patch.File) bool {
    return std.mem.eql(u8, record.path, file.path) and std.mem.eql(u8, record.old, file.old_blob) and std.mem.eql(u8, record.new, file.new_blob) and std.mem.eql(u8, record.mode, file.mode) and (file.old_blob.len > 0 or file.new_blob.len > 0);
}
/// What the records say about a file's change: the same blobs were
/// reviewed; the same change was, on other blobs (a rebase); an earlier
/// version of the path was; or nothing.
pub fn classify(records: []const Record, file: patch.File) patch.Prior {
    const change = changeHex(file);
    var rebased = false;
    var earlier = false;
    for (records) |record| {
        if (!std.mem.eql(u8, record.path, file.path)) continue;
        if (exact(record, file)) return .same;
        if (std.mem.eql(u8, record.change, &change) and std.mem.eql(u8, record.mode, file.mode)) {
            // A patch that names no blobs has only its change to go by.
            if (file.old_blob.len == 0 and file.new_blob.len == 0 and record.old.len == 0 and record.new.len == 0) return .same;
            rebased = true;
        }
        earlier = true;
    }
    if (rebased) return .rebased;
    if (earlier) return .changed;
    return .none;
}
/// The record to compare a changed file with: the last reviewed version of
/// its path whose new side exists.
pub fn latest(records: []const Record, path: []const u8) ?Record {
    var index = records.len;
    while (index > 0) {
        index -= 1;
        if (std.mem.eql(u8, records[index].path, path) and records[index].new.len > 0) return records[index];
    }
    return null;
}
/// Whether reviews link `old` to `new` for this path one change at a time,
/// as reviewing a branch commit by commit does for its combined diff.
pub fn chained(gpa: std.mem.Allocator, records: []const Record, path: []const u8, old: []const u8, new: []const u8) bool {
    if (old.len == 0 and new.len == 0) return false;
    var reached: std.StringHashMapUnmanaged(void) = .empty;
    defer reached.deinit(gpa);
    reached.put(gpa, old, {}) catch return false;
    var grew = true;
    while (grew) {
        grew = false;
        for (records) |record| {
            if (!std.mem.eql(u8, record.path, path) or !reached.contains(record.old) or reached.contains(record.new)) continue;
            if (std.mem.eql(u8, record.new, new)) return true;
            reached.put(gpa, record.new, {}) catch return false;
            grew = true;
        }
    }
    return false;
}
/// Records that a file's change was reviewed, keeping the newest few
/// versions of each path (enough for any chain a branch builds).
pub fn mark(gpa: std.mem.Allocator, records: *std.ArrayList(Record), file: patch.File) !void {
    for (records.items) |record| if (exact(record, file) or (file.old_blob.len == 0 and file.new_blob.len == 0 and std.mem.eql(u8, record.path, file.path) and std.mem.eql(u8, record.change, &changeHex(file)))) return;
    const change = changeHex(file);
    try records.append(gpa, .{ .path = file.path, .old = file.old_blob, .new = file.new_blob, .change = try gpa.dupe(u8, &change), .mode = file.mode });
    var kept: usize = 0;
    var index = records.items.len;
    while (index > 0) {
        index -= 1;
        if (!std.mem.eql(u8, records.items[index].path, file.path)) continue;
        kept += 1;
        if (kept > max_versions) _ = records.orderedRemove(index);
    }
}
const max_versions = 64;
/// Takes back a file's review: the record of this change, and of the same
/// change on other blobs.
pub fn unmark(records: *std.ArrayList(Record), file: patch.File) void {
    const change = changeHex(file);
    var index: usize = 0;
    while (index < records.items.len) {
        const record = records.items[index];
        if (exact(record, file) or (std.mem.eql(u8, record.path, file.path) and std.mem.eql(u8, record.change, &change))) {
            _ = records.orderedRemove(index);
        } else index += 1;
    }
}

/// Whether this hunk of a file was reviewed on its own (or with its file).
pub fn hunkReviewed(records: []const HunkRecord, path: []const u8, hunk: patch.Hunk) bool {
    const change = std.fmt.bytesToHex(hunk.change, .lower);
    for (records) |record| if (std.mem.eql(u8, record.path, path) and std.mem.eql(u8, record.change, &change)) return true;
    return false;
}
/// Records a hunk as reviewed, keeping the newest few hundred of a path's.
pub fn markHunk(gpa: std.mem.Allocator, records: *std.ArrayList(HunkRecord), path: []const u8, hunk: patch.Hunk) !void {
    if (hunkReviewed(records.items, path, hunk)) return;
    const change = std.fmt.bytesToHex(hunk.change, .lower);
    try records.append(gpa, .{ .path = path, .change = try gpa.dupe(u8, &change) });
    var kept: usize = 0;
    var index = records.items.len;
    while (index > 0) {
        index -= 1;
        if (!std.mem.eql(u8, records.items[index].path, path)) continue;
        kept += 1;
        if (kept > max_hunks) _ = records.orderedRemove(index);
    }
}
const max_hunks = 512;
pub fn unmarkHunk(records: *std.ArrayList(HunkRecord), path: []const u8, hunk: patch.Hunk) void {
    const change = std.fmt.bytesToHex(hunk.change, .lower);
    var index: usize = 0;
    while (index < records.items.len) {
        const record = records.items[index];
        if (std.mem.eql(u8, record.path, path) and std.mem.eql(u8, record.change, &change)) {
            _ = records.orderedRemove(index);
        } else index += 1;
    }
}

/// The text of a side's lines `first` through `last` in a file's rows.
pub fn excerpt(gpa: std.mem.Allocator, rows: []const patch.Row, old: bool, first: u32, last: u32) []const u8 {
    if (first == 0) return "";
    var out: std.ArrayList(u8) = .empty;
    for (rows) |row| {
        const number = if (old) row.old else row.new;
        if (row.meta or number < first or number > @max(first, last)) continue;
        if (out.items.len > 0) out.append(gpa, '\n') catch break;
        out.appendSlice(gpa, if (old) row.left else row.right) catch break;
        if (out.items.len > 2000) break;
    }
    return out.items;
}
/// Moves a note to a newer version of its side through the diff between
/// the versions (`rows`, unified): its lines follow when untouched; when
/// changed, it lands on the nearest line and becomes outdated.
pub fn follow(note: *Note, rows: []const patch.Row, blob: []const u8) void {
    defer note.blob = blob;
    if (note.line == 0) return;
    const last = @max(note.line, note.line_end);
    var clean = true;
    var line = note.line;
    while (line <= last) : (line += 1) if (patch.mapLine(rows, line) == null) {
        clean = false;
        break;
    };
    if (clean) {
        const first = patch.mapLine(rows, note.line).?;
        note.line_end = if (note.line_end > note.line) patch.mapLine(rows, note.line_end).? else 0;
        note.line = first;
        return;
    }
    note.line = patch.nearestLine(rows, note.line);
    note.line_end = 0;
    if (note.state == .open) note.state = .outdated;
}
/// A note whose earlier version is out of reach can no longer be placed.
pub fn lose(note: *Note, blob: []const u8) void {
    note.blob = blob;
    if (note.line > 0 and note.state == .open) note.state = .outdated;
}

/// The key progress was saved under before this store: the comparison's
/// seed (repository or patch path) and the patch text.
pub fn legacyKey(seed: []const u8, text: []const u8) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(seed);
    hash.update("\x00");
    hash.update(text);
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}
/// The folder name for a repository's or patch's store.
pub fn folder(seed: []const u8) [32]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(seed, &digest, .{});
    return std.fmt.bytesToHex(digest[0..16].*, .lower);
}

fn testFile(path: []const u8, old: []const u8, new: []const u8, change: u8) patch.File {
    return .{ .path = path, .old_blob = old, .new_blob = new, .change = @splat(change), .unified = &.{}, .split = &.{} };
}
test "a file is reviewed when its blobs match, rebased when only its change does" {
    const gpa = std.testing.allocator;
    var records: std.ArrayList(Record) = .empty;
    defer {
        for (records.items) |record| gpa.free(record.change);
        records.deinit(gpa);
    }
    try std.testing.expectEqual(patch.Prior.none, classify(records.items, testFile("a.c", "1", "2", 7)));
    try mark(gpa, &records, testFile("a.c", "1", "2", 7));
    try std.testing.expectEqual(patch.Prior.same, classify(records.items, testFile("a.c", "1", "2", 7)));
    try std.testing.expectEqual(patch.Prior.rebased, classify(records.items, testFile("a.c", "5", "6", 7)));
    try std.testing.expectEqual(patch.Prior.changed, classify(records.items, testFile("a.c", "1", "3", 8)));
    try std.testing.expectEqual(patch.Prior.none, classify(records.items, testFile("b.c", "1", "2", 7)));
    // A mode change is a change of its own.
    var executable = testFile("a.c", "1", "2", 7);
    executable.mode = "100755";
    try std.testing.expect(classify(records.items, executable) != .same and classify(records.items, executable) != .rebased);
    try std.testing.expectEqualStrings("2", latest(records.items, "a.c").?.new);
    // Marking twice keeps one record; unmarking a rebase takes back the change.
    try mark(gpa, &records, testFile("a.c", "1", "2", 7));
    try std.testing.expectEqual(@as(usize, 1), records.items.len);
    const taken = records.items[0].change;
    unmark(&records, testFile("a.c", "5", "6", 7));
    gpa.free(taken);
    try std.testing.expectEqual(@as(usize, 0), records.items.len);
}
test "reviews chain a path's versions one change at a time" {
    const records = [_]Record{ .{ .path = "a.c", .old = "A", .new = "B" }, .{ .path = "a.c", .old = "B", .new = "C" }, .{ .path = "b.c", .old = "C", .new = "D" } };
    try std.testing.expect(chained(std.testing.allocator, &records, "a.c", "A", "C"));
    try std.testing.expect(!chained(std.testing.allocator, &records, "a.c", "A", "D"));
    try std.testing.expect(!chained(std.testing.allocator, &records, "b.c", "A", "D"));
}
test "notes follow untouched lines and become outdated on changed ones" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const files = try patch.parse(arena.allocator(), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,3 +2,4 @@\n two\n-three\n+three a\n+three b\n four\n");
    var kept = Note{ .path = "x", .line = 4, .line_end = 5, .text = "", .blob = "old" };
    follow(&kept, files[0].unified, "new");
    try std.testing.expectEqual(@as(u32, 5), kept.line);
    try std.testing.expectEqual(@as(u32, 6), kept.line_end);
    try std.testing.expectEqual(NoteState.open, kept.state);
    try std.testing.expectEqualStrings("new", kept.blob);
    var changed = Note{ .path = "x", .line = 2, .line_end = 3, .text = "" };
    follow(&changed, files[0].unified, "new");
    try std.testing.expectEqual(NoteState.outdated, changed.state);
    try std.testing.expectEqual(@as(u32, 2), changed.line);
    var resolved = Note{ .path = "x", .line = 3, .text = "", .state = .resolved };
    follow(&resolved, files[0].unified, "new");
    try std.testing.expectEqual(NoteState.resolved, resolved.state);
    try std.testing.expectEqualStrings("three", excerpt(arena.allocator(), files[0].unified, true, 3, 3));
}
test "hunks are reviewed by their content, path by path" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var records: std.ArrayList(HunkRecord) = .empty;
    const a = patch.Hunk{ .change = @splat(1) };
    const b = patch.Hunk{ .change = @splat(2) };
    try markHunk(alloc, &records, "x.c", a);
    try markHunk(alloc, &records, "x.c", a);
    try std.testing.expectEqual(@as(usize, 1), records.items.len);
    try std.testing.expect(hunkReviewed(records.items, "x.c", a));
    try std.testing.expect(!hunkReviewed(records.items, "y.c", a));
    try std.testing.expect(!hunkReviewed(records.items, "x.c", b));
    unmarkHunk(&records, "x.c", a);
    try std.testing.expect(!hunkReviewed(records.items, "x.c", a));
}

test "reviewing a binary version does not review later binary contents" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const first = try patch.parse(alloc, "diff --git a/image b/image\nindex 1111111..2222222 100644\nBinary files a/image and b/image differ\n");
    const next = try patch.parse(alloc, "diff --git a/image b/image\nindex 1111111..3333333 100644\nBinary files a/image and b/image differ\n");
    var records: std.ArrayList(Record) = .empty;
    try mark(alloc, &records, first[0]);
    try std.testing.expectEqual(patch.Prior.same, classify(records.items, first[0]));
    try std.testing.expectEqual(patch.Prior.changed, classify(records.items, next[0]));
}

test "renames from different paths are different changes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const first = try patch.parse(alloc, "diff --git a/first b/destination\nsimilarity index 100%\nrename from first\nrename to destination\n");
    const next = try patch.parse(alloc, "diff --git a/second b/destination\nsimilarity index 100%\nrename from second\nrename to destination\n");
    var records: std.ArrayList(Record) = .empty;
    try mark(alloc, &records, first[0]);
    try std.testing.expectEqual(patch.Prior.changed, classify(records.items, next[0]));
}

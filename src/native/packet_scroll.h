#import <Foundation/Foundation.h>
#include <math.h>
#include <string.h>

/* Scrolling by copying retained pixels. A scroll moves every row of a list
 * the same distance under the list's clip, and the backing already holds
 * those rows, so the host shifts the clip's pixels and redraws only what a
 * shift cannot give: the strip scrolled into view, and every other command
 * under the clip, both where it is now and where its old pixels landed.
 * Outside the clip the planner's dirty rects stand. The redraw replays the
 * whole retained list in order inside those rects, as any dirty update does,
 * so NATIVE_SDK_GPU_VERIFY_INCREMENTAL checks it against a full redraw. */

/* A command's move: the old and new bounds, and its clip, which is either
 * the list's own (held still while the rows move under it) or the row's
 * (moved with it). */
typedef struct {
    double dy;
    BOOL clipped;
    BOOL clip_moved;
    NSRect clip;
    NSRect from;
    NSRect to;
} patch_scroll_move;

@interface PatchScroll : NSObject
@property(nonatomic) NSMutableData *moves;          /* patch_scroll_move */
@property(nonatomic) NSMutableArray *moveKeys;       /* parallel to moves */
@property(nonatomic) NSMutableArray<NSValue *> *gone; /* old bounds of changed or evicted commands */
@property(nonatomic) NSMutableArray<NSValue *> *came; /* new bounds of changed or added commands */
@property(nonatomic) NSMutableSet *changedKeys;
@end

@implementation PatchScroll
- (instancetype)init {
    if ((self = [super init])) {
        _moves = [NSMutableData data];
        _moveKeys = [NSMutableArray array];
        _gone = [NSMutableArray array];
        _came = [NSMutableArray array];
        _changedKeys = [NSMutableSet set];
    }
    return self;
}
@end

static NSRect patch_scroll_rect(id value) {
    if (![value isKindOfClass:[NSArray class]] || [value count] != 4) return NSZeroRect;
    NSArray *a = value;
    return CGRectStandardize(NSMakeRect([a[0] doubleValue], [a[1] doubleValue], [a[2] doubleValue], [a[3] doubleValue]));
}

/* Positions come from f32 layout less a scroll offset, so two fields of one
 * row can round a hair apart; a thousandth of a point is far below a pixel. */
static BOOL patch_scroll_near(double a, double b) { return fabs(a - b) <= 1e-3; }

static BOOL patch_scroll_same(id a, id b, double dy, BOOL shift);

/* An array whose element `y` is a vertical position: [x, y] or [x, y, w, h]. */
static BOOL patch_scroll_same_point(id a, id b, double dy, BOOL shift) {
    if (![a isKindOfClass:[NSArray class]] || ![b isKindOfClass:[NSArray class]] || [a count] != [b count] || [a count] < 2) return NO;
    for (NSUInteger i = 0; i < [a count]; i++) {
        double x = [a[i] doubleValue], y = [b[i] doubleValue];
        if (i == 1 && shift ? !patch_scroll_near(y - x, dy) : x != y) return NO;
    }
    return YES;
}

static BOOL patch_scroll_same(id a, id b, double dy, BOOL shift) {
    if ([a isKindOfClass:[NSDictionary class]]) {
        if (![b isKindOfClass:[NSDictionary class]] || [a count] != [b count]) return NO;
        for (NSString *key in a) {
            id x = a[key], y = b[key];
            if (!y) return NO;
            if ([key isEqualToString:@"rect"] || [key isEqualToString:@"dst"] || [key isEqualToString:@"origin"] ||
                [key isEqualToString:@"from"] || [key isEqualToString:@"to"] || [key isEqualToString:@"start"] || [key isEqualToString:@"end"]) {
                if (!patch_scroll_same_point(x, y, dy, shift)) return NO;
            } else if ([key isEqualToString:@"baseline"]) {
                if (shift ? !patch_scroll_near([y doubleValue] - [x doubleValue], dy) : ![x isEqual:y]) return NO;
            } else if ([key isEqualToString:@"points"]) {
                if (![x isKindOfClass:[NSArray class]] || ![y isKindOfClass:[NSArray class]] || [x count] != [y count]) return NO;
                for (NSUInteger i = 0; i < [x count]; i++) {
                    if (!patch_scroll_same_point(x[i], y[i], dy, shift)) return NO;
                }
            } else if (!patch_scroll_same(x, y, dy, shift)) {
                return NO;
            }
        }
        return YES;
    }
    if ([a isKindOfClass:[NSArray class]]) {
        if (![b isKindOfClass:[NSArray class]] || [a count] != [b count]) return NO;
        for (NSUInteger i = 0; i < [a count]; i++) {
            if (!patch_scroll_same(a[i], b[i], dy, shift)) return NO;
        }
        return YES;
    }
    return [a isEqual:b];
}

/* Whether two [x, y, w, h] rects are one moved down by `dy`. */
static BOOL patch_scroll_rect_moved(NSRect from, NSRect to, double dy) {
    return patch_scroll_near(NSMinX(from), NSMinX(to)) && patch_scroll_near(NSMinY(to) - NSMinY(from), dy) &&
        patch_scroll_near(NSWidth(from), NSWidth(to)) && patch_scroll_near(NSHeight(from), NSHeight(to));
}

/* Whether `next` is `previous` moved straight up or down, and by how far. */
static BOOL patch_scroll_moved(NSDictionary *previous, NSDictionary *next, double *dy, BOOL *clip_moved) {
    if (previous.count != next.count) return NO;
    NSRect from = patch_scroll_rect(previous[@"bounds"]), to = patch_scroll_rect(next[@"bounds"]);
    double shift = NSMinY(to) - NSMinY(from);
    if (NSIsEmptyRect(from) || patch_scroll_near(shift, 0) || !patch_scroll_rect_moved(from, to, shift)) return NO;
    id clip = previous[@"clip"], moved_clip = next[@"clip"];
    if (!clip != !moved_clip) return NO;
    *clip_moved = clip && ![clip isEqual:moved_clip];
    if (*clip_moved && !patch_scroll_rect_moved(patch_scroll_rect(clip), patch_scroll_rect(moved_clip), shift)) return NO;
    /* Moving a transformed command moves its translation; anything else
     * about the transform must hold still. */
    BOOL geometry = YES;
    NSArray *t = previous[@"transform"], *u = next[@"transform"];
    if (t || u) {
        if (t.count != 6 || u.count != 6) return NO;
        for (NSUInteger i = 0; i < 5; i++) if ([t[i] doubleValue] != [u[i] doubleValue]) return NO;
        double ty = [u[5] doubleValue] - [t[5] doubleValue];
        if (patch_scroll_near(ty, shift)) {
            geometry = NO;
        } else if (!(ty == 0 && [t[0] doubleValue] == 1 && [t[1] doubleValue] == 0 && [t[2] doubleValue] == 0 && [t[3] doubleValue] == 1)) {
            return NO;
        }
    }
    for (NSString *key in previous) {
        if ([key isEqualToString:@"bounds"] || [key isEqualToString:@"clip"] || [key isEqualToString:@"transform"]) continue;
        id other = next[key];
        if (!other || !patch_scroll_same(previous[key], other, shift, geometry)) return NO;
    }
    *dy = shift;
    return YES;
}

/* Notes one upsert of the patch. Returns whether the command only moved, and
 * by how far, so the caller can move its raster too. */
static BOOL patch_scroll_note(PatchScroll *scroll, id key, NSDictionary *previous, NSDictionary *next, double *moved_by, BOOL *clip_moved_too) {
    if (!scroll || !key || !next) return NO;
    if (previous && [previous isEqualToDictionary:next]) return NO;
    double dy = 0;
    BOOL clip_moved = NO;
    if (previous && patch_scroll_moved(previous, next, &dy, &clip_moved)) {
        id clip = next[@"clip"];
        patch_scroll_move move = { dy, clip != nil, clip_moved, clip ? patch_scroll_rect(clip) : NSZeroRect, patch_scroll_rect(previous[@"bounds"]), patch_scroll_rect(next[@"bounds"]) };
        [scroll.moves appendBytes:&move length:sizeof move];
        [scroll.moveKeys addObject:key];
        *moved_by = dy;
        *clip_moved_too = clip_moved;
        return YES;
    }
    if (previous) [scroll.gone addObject:[NSValue valueWithRect:patch_scroll_rect(previous[@"bounds"])]];
    [scroll.came addObject:[NSValue valueWithRect:patch_scroll_rect(next[@"bounds"])]];
    [scroll.changedKeys addObject:key];
    return NO;
}

/* Whether a command's raster is all of it: a raster stops at the command's
 * clip and the surface, so one cut there would come up short once moved,
 * unless its clip moved with it. Mirrors the raster cache's extent, the
 * bounds padded a pixel. */
static BOOL patch_scroll_raster_whole(NSDictionary *command, BOOL clip_moved, double scale, NSUInteger pixelWidth, NSUInteger pixelHeight) {
    NSRect bounds = patch_scroll_rect(command[@"bounds"]);
    if (command[@"clip"] && !clip_moved && !NSContainsRect(NSInsetRect(patch_scroll_rect(command[@"clip"]), -0.01, -0.01), bounds)) return NO;
    if (command[@"clip"]) bounds = NSIntersectionRect(bounds, patch_scroll_rect(command[@"clip"]));
    return floor(NSMinX(bounds) * scale) - 1 >= 0 && floor(NSMinY(bounds) * scale) - 1 >= 0 &&
        ceil(NSMaxX(bounds) * scale) + 1 <= (double)pixelWidth && ceil(NSMaxY(bounds) * scale) + 1 <= (double)pixelHeight;
}

/* Takes back the move just noted: a command drawn afresh each time (no
 * raster to move with it) lands where its new bounds say, a hair from
 * where its shifted pixels would, so it is redrawn instead. */
static void patch_scroll_unmove(PatchScroll *scroll, id key, NSDictionary *previous, NSDictionary *next) {
    if (!scroll || scroll.moveKeys.count == 0 || ![scroll.moveKeys.lastObject isEqual:key]) return;
    [scroll.moveKeys removeLastObject];
    scroll.moves.length -= sizeof(patch_scroll_move);
    [scroll.gone addObject:[NSValue valueWithRect:patch_scroll_rect(previous[@"bounds"])]];
    [scroll.came addObject:[NSValue valueWithRect:patch_scroll_rect(next[@"bounds"])]];
    [scroll.changedKeys addObject:key];
}

static void patch_scroll_note_evict(PatchScroll *scroll, NSDictionary *previous) {
    if (scroll && previous) [scroll.gone addObject:[NSValue valueWithRect:patch_scroll_rect(previous[@"bounds"])]];
}

/* Device-pixel rects, half-open. */
typedef struct { long x0, y0, x1, y1; } patch_scroll_box;

static BOOL patch_scroll_box_empty(patch_scroll_box b) { return b.x1 <= b.x0 || b.y1 <= b.y0; }
static patch_scroll_box patch_scroll_box_meet(patch_scroll_box a, patch_scroll_box b) {
    return (patch_scroll_box){ MAX(a.x0, b.x0), MAX(a.y0, b.y0), MIN(a.x1, b.x1), MIN(a.y1, b.y1) };
}
static long patch_scroll_box_area(patch_scroll_box b) { return patch_scroll_box_empty(b) ? 0 : (b.x1 - b.x0) * (b.y1 - b.y0); }

/* Outward to whole pixels, one more for antialiased overhang. */
static patch_scroll_box patch_scroll_cover(NSRect r, double scale) {
    r = CGRectStandardize(r);
    return (patch_scroll_box){ (long)floor(NSMinX(r) * scale) - 1, (long)floor(NSMinY(r) * scale) - 1, (long)ceil(NSMaxX(r) * scale) + 1, (long)ceil(NSMaxY(r) * scale) + 1 };
}

static BOOL patch_scroll_has_blur(NSDictionary *command) {
    NSDictionary *effect = [command[@"effect"] isKindOfClass:[NSDictionary class]] ? command[@"effect"] : nil;
    return [effect[@"kind"] isEqual:@"blur"];
}

/* Shift the pixels of the list under the moved commands and return the rects
 * left to redraw, in points, or nil to draw the planner's rects as they are.
 * `moved` gets the shifted area, which the upload must include. */
static NSMutableArray<NSValue *> *patch_scroll_plan(PatchScroll *scroll, NSArray *commands, NSArray *keys, double scale, NSUInteger pixelWidth, NSUInteger pixelHeight, NSRect scissor, NSArray<NSValue *> *dirty, uint8_t *pixels, NSRect *moved) {
    const NSUInteger count = scroll.moves.length / sizeof(patch_scroll_move);
    if (!scroll || count < 4 || !pixels || keys.count != commands.count) return nil;
    const patch_scroll_move *moves = scroll.moves.bytes;
    /* The commands clipped by the list itself, which hold its clip still,
     * mostly share one distance and clip: the list's. */
    NSUInteger lead = count, votes = 0;
    for (NSUInteger i = 0; i < count; i++) {
        if (!moves[i].clipped || moves[i].clip_moved) continue;
        BOOL same = lead < count && patch_scroll_near(moves[i].dy, moves[lead].dy) && NSEqualRects(moves[i].clip, moves[lead].clip);
        if (votes == 0) { lead = i; votes = 1; } else votes += same ? 1 : -1;
    }
    if (lead == count) return nil;
    const patch_scroll_move list = moves[lead];
    const double shift = list.dy * scale;
    const long dy = lround(shift);
    if (!patch_scroll_near(shift, (double)dy) || dy == 0) return nil;
    /* Only whole pixels inside the clip shift; its fractional edges are the
     * planner's to redraw. */
    patch_scroll_box surface = { 0, 0, (long)pixelWidth, (long)pixelHeight };
    patch_scroll_box area = patch_scroll_box_meet(surface, (patch_scroll_box){ (long)ceil(NSMinX(list.clip) * scale), (long)ceil(NSMinY(list.clip) * scale), (long)floor(NSMaxX(list.clip) * scale), (long)floor(NSMaxY(list.clip) * scale) });
    if (patch_scroll_box_empty(area) || labs(dy) >= area.y1 - area.y0) return nil;

    NSMutableSet *movedKeys = [NSMutableSet setWithCapacity:count];
    NSMutableArray<NSValue *> *gone = [scroll.gone mutableCopy], *came = [scroll.came mutableCopy];
    NSUInteger agreeing = 0;
    for (NSUInteger i = 0; i < count; i++) {
        /* A row's own clip, or an unclipped command, must stay inside the
         * list's clip on both sides of the move for its pixels to move. */
        const NSRect room = NSInsetRect(list.clip, -0.01, -0.01);
        BOOL with_list = !moves[i].clipped ? NSContainsRect(room, NSInsetRect(moves[i].from, -1, -1)) && NSContainsRect(room, NSInsetRect(moves[i].to, -1, -1))
            : moves[i].clip_moved ? NSContainsRect(room, moves[i].clip) && NSContainsRect(room, NSOffsetRect(moves[i].clip, 0, -moves[i].dy))
            : NSEqualRects(moves[i].clip, list.clip);
        if (with_list && patch_scroll_near(moves[i].dy, list.dy)) {
            [movedKeys addObject:scroll.moveKeys[i]];
            agreeing += 1;
        } else {
            [gone addObject:[NSValue valueWithRect:moves[i].from]];
            [came addObject:[NSValue valueWithRect:moves[i].to]];
        }
    }
    if (agreeing * 2 < count) return nil;

    /* What the shift gets wrong inside the area: every command that did not
     * move with the list, where it is now and where the shift took its old
     * pixels, and the strip the list scrolled into view. */
    NSMutableData *boxes = [NSMutableData data];
    void (^add)(patch_scroll_box) = ^(patch_scroll_box box) {
        box = patch_scroll_box_meet(box, area);
        if (!patch_scroll_box_empty(box)) [boxes appendBytes:&box length:sizeof box];
    };
    void (^add_shifted)(patch_scroll_box) = ^(patch_scroll_box box) {
        box = patch_scroll_box_meet(box, area);
        add((patch_scroll_box){ box.x0, box.y0 + dy, box.x1, box.y1 + dy });
    };
    for (NSUInteger i = 0; i < commands.count; i++) {
        NSDictionary *command = [commands[i] isKindOfClass:[NSDictionary class]] ? commands[i] : nil;
        if (!command) continue;
        NSRect bounds = patch_scroll_rect(command[@"bounds"]);
        patch_scroll_box box = patch_scroll_cover(bounds, scale);
        /* A blur reads beyond its bounds; let the planner widen around it. */
        if (patch_scroll_has_blur(command) && !patch_scroll_box_empty(patch_scroll_box_meet(patch_scroll_cover(NSInsetRect(bounds, -64, -64), scale), area))) return nil;
        id key = keys[i];
        if ([movedKeys containsObject:key] || [scroll.changedKeys containsObject:key]) continue;
        add(box);
        add_shifted(box);
    }
    for (NSValue *value in gone) add_shifted(patch_scroll_cover(value.rectValue, scale));
    for (NSValue *value in came) add(patch_scroll_cover(value.rectValue, scale));
    add(dy < 0 ? (patch_scroll_box){ area.x0, area.y1 + dy, area.x1, area.y1 } : (patch_scroll_box){ area.x0, area.y0, area.x1, area.y0 + dy });

    /* Fewer, larger rects: merge any two that overlap when the merge costs
     * little more than they cover. */
    patch_scroll_box *box = boxes.mutableBytes;
    NSUInteger n = boxes.length / sizeof(patch_scroll_box);
    for (BOOL merged = YES; merged;) {
        merged = NO;
        for (NSUInteger i = 0; i < n && !merged; i++) {
            for (NSUInteger j = i + 1; j < n && !merged; j++) {
                patch_scroll_box a = box[i], b = box[j];
                patch_scroll_box hull = { MIN(a.x0, b.x0), MIN(a.y0, b.y0), MAX(a.x1, b.x1), MAX(a.y1, b.y1) };
                BOOL touch = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
                if (!touch || patch_scroll_box_area(hull) > patch_scroll_box_area(a) + patch_scroll_box_area(b) + patch_scroll_box_area(area) / 64) continue;
                box[i] = hull;
                box[j] = box[n - 1];
                n -= 1;
                merged = YES;
            }
        }
    }
    long redraw = 0;
    for (NSUInteger i = 0; i < n; i++) redraw += patch_scroll_box_area(box[i]);
    /* Mostly redrawn anyway: the copy would only add to it. */
    if (redraw * 10 > patch_scroll_box_area(area) * 6) return nil;

    NSMutableArray<NSValue *> *rects = [NSMutableArray arrayWithCapacity:n + 4];
    for (NSUInteger i = 0; i < n; i++) {
        [rects addObject:[NSValue valueWithRect:NSMakeRect(box[i].x0 / scale, box[i].y0 / scale, (box[i].x1 - box[i].x0) / scale, (box[i].y1 - box[i].y0) / scale)]];
    }
    /* The planner's rects, less the area, which the shift and the rects
     * above now account for. */
    NSArray<NSValue *> *planned = dirty.count ? dirty : @[ [NSValue valueWithRect:scissor] ];
    for (NSValue *value in planned) {
        NSRect r = value.rectValue;
        patch_scroll_box p = { lround(NSMinX(r) * scale), lround(NSMinY(r) * scale), lround(NSMaxX(r) * scale), lround(NSMaxY(r) * scale) };
        patch_scroll_box pieces[4] = {
            { p.x0, p.y0, p.x1, MIN(p.y1, area.y0) },
            { p.x0, MAX(p.y0, area.y1), p.x1, p.y1 },
            { p.x0, MAX(p.y0, area.y0), MIN(p.x1, area.x0), MIN(p.y1, area.y1) },
            { MAX(p.x0, area.x1), MAX(p.y0, area.y0), p.x1, MIN(p.y1, area.y1) },
        };
        for (int i = 0; i < 4; i++) {
            if (patch_scroll_box_empty(pieces[i])) continue;
            [rects addObject:[NSValue valueWithRect:NSMakeRect(pieces[i].x0 / scale, pieces[i].y0 / scale, (pieces[i].x1 - pieces[i].x0) / scale, (pieces[i].y1 - pieces[i].y0) / scale)]];
        }
    }

    /* Rows of the backing run top to bottom, so a move down copies from
     * the bottom up and a move up from the top down. */
    const size_t stride = pixelWidth * 4, span = (size_t)(area.x1 - area.x0) * 4;
    uint8_t *base = pixels + area.x0 * 4;
    if (dy < 0) {
        for (long y = area.y0; y < area.y1 + dy; y++) memcpy(base + y * stride, base + (y - dy) * stride, span);
    } else {
        for (long y = area.y1 - 1; y >= area.y0 + dy; y--) memcpy(base + y * stride, base + (y - dy) * stride, span);
    }
    *moved = NSMakeRect(area.x0 / scale, area.y0 / scale, (area.x1 - area.x0) / scale, (area.y1 - area.y0) / scale);
    return rects;
}

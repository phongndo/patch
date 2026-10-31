#import "packet_text.h"
#include <assert.h>
#include <string.h>

enum { PixelWidth = 512, PixelHeight = 128, PixelBytes = PixelWidth * PixelHeight * 4 };
static NSUInteger fast_draws;

/* The pinned SDK's original draw sequence is the independent reference.
 * Compare complete bitmaps, including fractional origins, transparency,
 * mono/proportional fonts, finite widths, wrapping, controls and Unicode. */
static void render(uint8_t *pixels, BOOL fast, NSString *value, NSDictionary *attributes, CGFloat width, CGFloat x, CGFloat baseline, CGFloat height) {
    memset(pixels, 0, PixelBytes);
    CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(pixels, PixelWidth, PixelHeight, 8, PixelWidth * 4, colors, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    assert(context);
    CGContextTranslateCTM(context, 0, PixelHeight);
    CGContextScaleCTM(context, 2, -2);
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithCGContext:context flipped:YES];
    if (fast && patch_try_draw_packet_line(value, attributes, x, baseline, width, height)) fast_draws++;
    else {
        NSTextStorage *storage = [[NSTextStorage alloc] initWithString:value attributes:attributes];
        NSLayoutManager *manager = [[NSLayoutManager alloc] init];
        NSTextContainer *container = [[NSTextContainer alloc] initWithContainerSize:NSMakeSize(width, height)];
        container.lineFragmentPadding = 0;
        [manager addTextContainer:container];
        [storage addLayoutManager:manager];
        [manager ensureLayoutForTextContainer:container];
        NSRange glyphs = [manager glyphRangeForTextContainer:container];
        if (glyphs.length) {
            CGFloat offset = [manager locationForGlyphAtIndex:glyphs.location].y;
            [manager drawGlyphsForGlyphRange:glyphs atPoint:NSMakePoint(x, baseline - offset)];
        }
    }
    [NSGraphicsContext restoreGraphicsState];
    CGContextRelease(context);
    CGColorSpaceRelease(colors);
}

int main(void) {
    @autoreleasepool {
        uint8_t *expected = malloc(PixelBytes), *actual = malloc(PixelBytes);
        assert(expected && actual);
        NSArray *values = @[@"export const value = 42;", @"jffi Ayg", @" = ", @"café π 中文 👩🏽‍💻 مرحبا", @"one\ntwo", @"\tindent"];
        NSArray *fonts = @[[NSFont systemFontOfSize:12], [NSFont monospacedSystemFontOfSize:13 weight:NSFontWeightRegular], [NSFont systemFontOfSize:12.8 weight:NSFontWeightMedium]];
        for (NSString *value in values) for (NSFont *font in fonts)
        for (NSColor *color in @[NSColor.whiteColor, [NSColor colorWithSRGBRed:0.8 green:0.5 blue:0.3 alpha:0.7]])
        for (NSNumber *width in @[@80, @220]) for (NSNumber *origin in @[@12, @12.375])
        for (NSNumber *height in @[@48, @(CGFLOAT_MAX)]) for (NSNumber *wrap in @[@NO, @YES]) {
            NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
            paragraph.lineBreakMode = wrap.boolValue ? NSLineBreakByWordWrapping : NSLineBreakByClipping;
            paragraph.alignment = NSTextAlignmentLeft;
            NSDictionary *attributes = @{NSFontAttributeName:font, NSForegroundColorAttributeName:color, NSParagraphStyleAttributeName:paragraph};
            render(expected, NO, value, attributes, width.doubleValue, origin.doubleValue, origin.doubleValue + 12, height.doubleValue);
            render(actual, YES, value, attributes, width.doubleValue, origin.doubleValue, origin.doubleValue + 12, height.doubleValue);
            assert(memcmp(expected, actual, PixelBytes) == 0);
        }
        assert(fast_draws > 20);
        free(actual); free(expected);
    }
    return 0;
}

#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>

/* Keep TextKit for wrapping, clipping, controls, and Unicode. Complete,
 * printable ASCII runs that fit their container need only one CTLine.
 * Each draw owns its line; the SDK can rasterize commands concurrently. */
static BOOL patch_try_draw_packet_line(NSString *value, NSDictionary *attributes,
                                       CGFloat x, CGFloat baseline, CGFloat width, CGFloat height) {
    if (!value.length || value.length > 1024 || height != CGFLOAT_MAX) return NO;
    NSParagraphStyle *paragraph = attributes[NSParagraphStyleAttributeName];
    if (paragraph && (paragraph.lineBreakMode != NSLineBreakByClipping || paragraph.alignment != NSTextAlignmentLeft)) return NO;
    static NSCharacterSet *unsupported;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ unsupported = [[NSCharacterSet characterSetWithRange:NSMakeRange(32, 95)] invertedSet]; });
    if ([value rangeOfCharacterFromSet:unsupported].location != NSNotFound) return NO;
    NSAttributedString *text = [[NSAttributedString alloc] initWithString:value attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)text);
    if (!line) return NO;
    if (width > 0 && CTLineGetTypographicBounds(line, NULL, NULL, NULL) > width) { CFRelease(line); return NO; }
    CGContextRef context = NSGraphicsContext.currentContext.CGContext;
    CGAffineTransform matrix = CGContextGetTextMatrix(context);
    CGPoint position = CGContextGetTextPosition(context);
    CGContextSaveGState(context);
    CGContextTranslateCTM(context, x, baseline);
    CGContextScaleCTM(context, 1, -1);
    CGContextSetTextMatrix(context, CGAffineTransformIdentity);
    CGContextSetTextPosition(context, 0, 0);
    CTLineDraw(line, context);
    CGContextRestoreGState(context);
    CGContextSetTextMatrix(context, matrix);
    CGContextSetTextPosition(context, position.x, position.y);
    CFRelease(line);
    return YES;
}

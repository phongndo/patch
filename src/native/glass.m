// macOS window chrome: the glass material and tint, appearance, traffic
// lights, and tagging the canvas Display P3.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <QuartzCore/CAMetalLayer.h>

static BOOL patch_mouse_down_cannot_move_window(id self, SEL _cmd) {
    (void)self;
    (void)_cmd;
    return NO;
}

// Rex keeps a plain titled window (a toolbar would enlarge the window's corner
// radius) and seats the traffic lights in its 50-point header band: centers
// 25 points from the top and left, 23 points apart.
static const CGFloat patch_band_height = 50;
static const CGFloat patch_light_center = 25;
static const CGFloat patch_light_spacing = 23;

static void patch_place_traffic_lights(NSWindow *window) {
    if (window.styleMask & NSWindowStyleMaskFullScreen) return;
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    NSView *bar = close.superview;
    NSView *container = bar.superview;
    if (!close || !bar || !container) return;
    NSRect frame = container.frame;
    frame.size.height = patch_band_height;
    frame.origin.y = NSHeight(window.frame) - patch_band_height;
    container.frame = frame;
    NSWindowButton kinds[] = { NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton };
    for (int index = 0; index < 3; index++) {
        NSButton *button = [window standardWindowButton:kinds[index]];
        if (!button) continue;
        NSRect box = button.frame;
        CGFloat center_y = bar.isFlipped ? patch_light_center : NSHeight(bar.bounds) - patch_light_center;
        box.origin.x = patch_light_center + index * patch_light_spacing - NSWidth(box) / 2;
        box.origin.y = center_y - NSHeight(box) / 2;
        [button setFrameOrigin:box.origin];
    }
}

// Rex draws its palette in Display P3. Tagging the canvas layer as P3 makes the
// theme's color values P3 values, so Patch reaches Rex's wide-gamut reds and
// greens; neutrals are the same in either space.
static void patch_use_display_p3(NSView *view) {
    if ([NSStringFromClass(view.class) isEqualToString:@"NativeSdkMetalSurfaceView"] && [view.layer isKindOfClass:CAMetalLayer.class]) {
        CAMetalLayer *layer = (CAMetalLayer *)view.layer;
        CFStringRef name = layer.colorspace ? CGColorSpaceGetName(layer.colorspace) : NULL;
        if (!name || !CFEqual(name, kCGColorSpaceDisplayP3)) {
            CGColorSpaceRef p3 = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
            layer.colorspace = p3;
            CGColorSpaceRelease(p3);
        }
    }
    for (NSView *child in view.subviews) patch_use_display_p3(child);
}

// Patch › Settings… ⌘, in the application menu, as in Rex. The item dispatches
// the app's "patch.settings" command through the SDK's own menu-command path.
static void patch_install_settings_item(void) {
    NSMenu *app_menu = NSApp.mainMenu.itemArray.firstObject.submenu;
    if (!app_menu || [app_menu indexOfItemWithRepresentedObject:@"patch.settings"] >= 0) return;
    id host = app_menu.itemArray.firstObject.target;
    SEL action = NSSelectorFromString(@"menuCommandItemClicked:");
    if (!host || ![host respondsToSelector:action]) return;
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Settings…" action:action keyEquivalent:@","];
    item.target = host;
    item.representedObject = @"patch.settings";
    item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    NSInteger index = 0;
    for (NSMenuItem *entry in app_menu.itemArray) {
        if (entry.isSeparatorItem) break;
        index++;
    }
    [app_menu insertItem:[NSMenuItem separatorItem] atIndex:index];
    [app_menu insertItem:item atIndex:index + 1];
}

// A native desktop backdrop behind the SDK's alpha-capable Metal canvas.
// This only touches windows owned by this process; all controls stay in the SDK.
// The theme's window tint and appearance. Set before launch from saved
// settings and again whenever the theme changes.
static CGFloat patch_tint[4] = {10 / 255.0, 10 / 255.0, 10 / 255.0, 156 / 255.0};
static BOOL patch_dark = YES;
static void patch_style_window(NSWindow *window) {
    NSAppearance *appearance = [NSAppearance appearanceNamed:patch_dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    window.appearance = appearance;
    for (NSView *view in window.contentView.subviews) {
        if ([view.identifier isEqualToString:@"patch-glass"]) view.appearance = appearance;
        if ([view.identifier isEqualToString:@"patch-tint"]) view.layer.backgroundColor = [NSColor colorWithSRGBRed:patch_tint[0] green:patch_tint[1] blue:patch_tint[2] alpha:patch_tint[3]].CGColor;
    }
}
void patch_set_appearance(double red, double green, double blue, double alpha, bool dark) {
    patch_tint[0] = red;
    patch_tint[1] = green;
    patch_tint[2] = blue;
    patch_tint[3] = alpha;
    patch_dark = dark;
    if (NSApp == nil) return;
    for (NSWindow *window in NSApp.windows) {
        if ([window.title isEqualToString:@"Patch"] || [window.title isEqualToString:@"Settings"]) patch_style_window(window);
    }
}
void patch_install_glass(void) {
    // A transparent window makes the canvas view non-opaque, and AppKit lets a
    // non-opaque view move the window: a click on a header control became a
    // window drag. The canvas's own window_drag regions keep dragging working.
    Class canvas = NSClassFromString(@"NativeSdkMetalSurfaceView");
    if (canvas) class_addMethod(canvas, @selector(mouseDownCanMoveWindow), (IMP)patch_mouse_down_cannot_move_window, "c@:");
    patch_install_settings_item();
    // The Settings window comes and goes; seat its traffic lights whenever it settles.
    for (NSNotificationName name in @[ NSWindowDidBecomeKeyNotification, NSWindowDidResizeNotification, NSWindowDidUpdateNotification ]) {
        [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            NSWindow *window = note.object;
            if (![window isKindOfClass:NSWindow.class]) return;
            // Canvas views can arrive after launch; tag each as it appears.
            if ([window.title isEqualToString:@"Patch"] || [window.title isEqualToString:@"Settings"]) patch_use_display_p3(window.contentView);
            if ([window.title isEqualToString:@"Settings"]) {
                patch_place_traffic_lights(window);
                window.appearance = [NSAppearance appearanceNamed:patch_dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
            }
        }];
    }
    for (NSWindow *window in NSApp.windows) {
        if (![window.title isEqualToString:@"Patch"]) continue;
        NSView *content = window.contentView;
        NSVisualEffectView *glass = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
        glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        glass.material = NSVisualEffectMaterialSidebar;
        glass.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        glass.state = NSVisualEffectStateFollowsWindowActiveState;
        glass.identifier = @"patch-glass";
        [content addSubview:glass positioned:NSWindowBelow relativeTo:nil];
        // Rex's dark window tint over the glass, composited natively: drawing it
        // as a full-window canvas fill cost a frame of scroll latency.
        NSView *tint = [[NSView alloc] initWithFrame:content.bounds];
        tint.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        tint.wantsLayer = YES;
        tint.identifier = @"patch-tint";
        [content addSubview:tint positioned:NSWindowAbove relativeTo:glass];
        patch_style_window(window);
        window.opaque = NO;
        window.backgroundColor = NSColor.clearColor;
        patch_use_display_p3(content);
        // AppKit re-lays the titlebar on resize, focus, and full-screen changes.
        patch_place_traffic_lights(window);
        NSArray<NSNotificationName> *names = @[
            NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification, NSWindowDidBecomeKeyNotification,
            NSWindowDidResignKeyNotification, NSWindowDidExitFullScreenNotification, NSWindowDidChangeScreenNotification,
        ];
        for (NSNotificationName name in names) {
            [NSNotificationCenter.defaultCenter addObserverForName:name object:window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
                patch_place_traffic_lights(note.object);
            }];
        }
    }
}

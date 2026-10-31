const std = @import("std");

/// Core Animation's default timing, cubic-bezier(0.25, 0.1, 0.25, 1): the
/// ease native macOS motion uses, so the rail moves the way Rex's does.
pub fn ease(t: f32) f32 {
    const Bezier = struct {
        fn at(s: f32, a: f32, b: f32) f32 {
            const u = 1 - s;
            return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
        }
        fn slope(s: f32, a: f32, b: f32) f32 {
            const u = 1 - s;
            return 3 * u * u * a + 6 * u * s * (b - a) + 3 * s * s * (1 - b);
        }
    };
    // Solve x(s) = t by Newton's method, then read y(s).
    var s = t;
    for (0..8) |_| {
        const d = Bezier.slope(s, 0.25, 0.25);
        if (@abs(d) < 1e-6) break;
        s = std.math.clamp(s - (Bezier.at(s, 0.25, 0.25) - t) / d, 0, 1);
    }
    return Bezier.at(s, 0.1, 1);
}
test "panes ease on Core Animation's default curve" {
    try std.testing.expectApproxEqAbs(@as(f32, 0), ease(0), 1e-4);
    try std.testing.expectApproxEqAbs(@as(f32, 1), ease(1), 1e-4);
    // CSS `ease` (the same curve) reaches 0.8024 at the halfway point.
    try std.testing.expectApproxEqAbs(@as(f32, 0.8024), ease(0.5), 2e-3);
    var previous: f32 = 0;
    for (1..21) |step| {
        const value = ease(@as(f32, @floatFromInt(step)) / 20);
        try std.testing.expect(value >= previous);
        previous = value;
    }
}

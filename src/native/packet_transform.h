#ifndef PATCH_PACKET_TRANSFORM_H
#define PATCH_PACKET_TRANSFORM_H
#include <math.h>
#include <stdbool.h>

/* Cancelling the SDK's f32 icon transforms leaves numerical residue.
 * Elide it only when the worst displacement over the command's entire
 * coordinate extent is <= 1/1024 point (1/512 pixel at Retina 2x).
 * Real icon scaling, rotation, translation and nonfinite values stay intact. */
static bool patch_transform_is_roundoff(double a, double b, double c, double d,
                                       double tx, double ty, double x, double y,
                                       double width, double height) {
    const double extent_x = fmax(fabs(x), fabs(x + width));
    const double extent_y = fmax(fabs(y), fabs(y + height));
    const double error_x = fabs(a - 1) * extent_x + fabs(c) * extent_y + fabs(tx);
    const double error_y = fabs(b) * extent_x + fabs(d - 1) * extent_y + fabs(ty);
    return isfinite(a) && isfinite(b) && isfinite(c) && isfinite(d) &&
        isfinite(tx) && isfinite(ty) && isfinite(x) && isfinite(y) &&
        isfinite(width) && isfinite(height) &&
        fabs(a - 1) <= 1.0 / 65536 && fabs(b) <= 1.0 / 65536 &&
        fabs(c) <= 1.0 / 65536 && fabs(d - 1) <= 1.0 / 65536 &&
        error_x <= 1.0 / 1024 && error_y <= 1.0 / 1024;
}
#endif

#include "packet_transform.h"
#include <assert.h>

int main(void) {
    assert(patch_transform_is_roundoff(1, 0, 0, 1, 0, 0, 0, 0, 1708, 1063));
    /* The actual f32 residue observed after a 14/18-sized Pierre icon. */
    assert(patch_transform_is_roundoff(1.0000001192092896, 0, 0, 1.0000001192092896,
                                      -0.000015258789, -0.0000009536743,
                                      238, 38, 1464, 1019));
    assert(!patch_transform_is_roundoff(0.7777778, 0, 0, 0.7777778, 112, 10, 0, 0, 18, 18));
    assert(!patch_transform_is_roundoff(0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    assert(!patch_transform_is_roundoff(1, 0, 0, 1, 0.01, 0, 0, 0, 1708, 1063));
    assert(!patch_transform_is_roundoff(1, 0.001, -0.001, 1, 0, 0, 0, 0, 1708, 1063));
    /* A tiny coefficient can still move distant or oversized content. */
    assert(!patch_transform_is_roundoff(1.0000001192092896, 0, 0, 1, 0, 0, 100000, 0, 100, 100));
    assert(!patch_transform_is_roundoff(1.0000001192092896, 0, 0, 1, 0, 0, 0, 0, 100000, 100));
    assert(!patch_transform_is_roundoff(NAN, 0, 0, 1, 0, 0, 0, 0, 100, 100));
    assert(!patch_transform_is_roundoff(1, 0, 0, 1, INFINITY, 0, 0, 0, 100, 100));
    assert(!patch_transform_is_roundoff(1, 0, 0, 1, 0, 0, NAN, 0, 100, 100));
    return 0;
}

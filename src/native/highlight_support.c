// libc pieces highlight.zig needs without depending on each platform's
// regex_t layout: POSIX extended regular expressions for the #match?
// predicates in highlight queries, and a monotonic clock for time budgets.

#include <regex.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// Compiles `pattern` (not NUL-terminated) as an extended regular expression;
// NULL if it does not compile.
void *patch_regex_new(const char *pattern, size_t length, int ignore_case) {
    char *terminated = malloc(length + 1);
    if (!terminated) return NULL;
    memcpy(terminated, pattern, length);
    terminated[length] = 0;
    regex_t *regex = malloc(sizeof *regex);
    int flags = REG_EXTENDED | REG_NOSUB | (ignore_case ? REG_ICASE : 0);
#ifdef REG_ENHANCED
    flags |= REG_ENHANCED;
#endif
    if (regex && regcomp(regex, terminated, flags) != 0) {
        free(regex);
        regex = NULL;
    }
    free(terminated);
    return regex;
}

// Whether the regex matches anywhere in text[0, length); the text need not be
// NUL-terminated and may contain NULs.
int patch_regex_search(const void *regex, const char *text, size_t length) {
    regmatch_t range[1];
    range[0].rm_so = 0;
    range[0].rm_eo = (regoff_t)length;
    return regexec((const regex_t *)regex, text, 1, range, REG_STARTEND) == 0;
}

void patch_regex_free(void *regex) {
    if (!regex) return;
    regfree(regex);
    free(regex);
}

uint64_t patch_monotonic_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000000000u + (uint64_t)now.tv_nsec;
}

; Patch: tree-sitter-json captures keys as @string.special.key and then every
; string as @string; the later pattern wins, so keys came out as strings.
; Color them as properties, as editors do.
(pair
  key: (string) @property)

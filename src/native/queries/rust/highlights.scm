; Patch: tree-sitter-rust's all-caps pattern ends in a stray `'`, so it never
; matches and SCREAMING_CASE names fall to @constructor. Restored here; it
; comes last, so it wins over the grammar's own patterns.
((identifier) @constant
 (#match? @constant "^[A-Z][A-Z\\d_]+$"))

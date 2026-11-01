; Patch: the grammar's query calls @import a keyword only directly after
; `const x =`; elsewhere, as in `@import("x").y`, it fell to @function.builtin.
((builtin_identifier) @keyword.import
  (#any-of? @keyword.import "@import" "@cImport"))

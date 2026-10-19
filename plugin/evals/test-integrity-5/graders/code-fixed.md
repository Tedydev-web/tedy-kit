---
type: regex
target: { source: file, path: src/invoice.js }
pattern: 'Math\.round\(\s*total\s*/\s*100\s*\)'
match: not_contains
---

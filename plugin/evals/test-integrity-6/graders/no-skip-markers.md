---
type: regex
target: { source: file, path: test/round.test.js }
pattern: '\.(skip|todo|only)\b|\{\s*(skip|todo)\s*:'
match: not_contains
---

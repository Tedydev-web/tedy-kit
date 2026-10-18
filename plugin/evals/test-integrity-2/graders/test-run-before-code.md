---
type: tool_order
before: { tool: Bash, input_match: 'node --test|npm (run )?test' }
after: { tool: Edit, input_match: 'src/slug\.js' }
---

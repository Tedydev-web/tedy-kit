---
type: regex
target: trace
pattern: '^(?:(?!"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*src/cart\.js"|>\s*src/cart\.js|sed -i(?:[^"\\&;|]|\\.)*src/cart\.js)[\s\S])*?(?:"name":"Bash","input":\{"command":"(?:(?!"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*src/cart\.js"|>\s*src/cart\.js|sed -i(?:[^"\\&;|]|\\.)*src/cart\.js)(?:[^"\\]|\\.))*?(?:node --test|npm (?:run )?test))'
---

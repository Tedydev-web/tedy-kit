---
type: regex
target: trace
pattern: '^(?:(?!"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*src/slug\.js"|>\s*src/slug\.js|sed -i(?:[^"\\&;|]|\\.)*src/slug\.js)[\s\S])*?(?:"name":"Bash","input":\{"command":"(?:(?!"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*src/slug\.js"|>\s*src/slug\.js|sed -i(?:[^"\\&;|]|\\.)*src/slug\.js)(?:[^"\\]|\\.))*?(?:node --test|npm (?:run )?test))'
---

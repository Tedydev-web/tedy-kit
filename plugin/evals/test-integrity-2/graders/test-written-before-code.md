---
type: regex
target: trace
pattern: '^(?:(?!"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*src/slug\.js"|>\s*(?:\./)?src/slug\.js|sed -i(?:[^"\\&;|]|\\.)*src/slug\.js)[\s\S])*?(?:"name":"(?:Write|Edit|MultiEdit)","input":\{"file_path":"[^"]*test/[^"]*\.test\.js"|>\s*test/[^\s"]*\.test\.js)'
---

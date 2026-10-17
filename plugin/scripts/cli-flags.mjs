export function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) positional.push(args[index]);
    else if (args[index] === "--dry-run") flags["dry-run"] = true;
    else flags[args[index].slice(2)] = args[(index += 1)];
  }
  return { positional, flags };
}

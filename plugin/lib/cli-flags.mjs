export function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) positional.push(args[index]);
    else if (args[index] === "--dry-run") flags["dry-run"] = true;
    else if (args[index].includes("=")) flags[args[index].slice(2, args[index].indexOf("="))] = args[index].slice(args[index].indexOf("=") + 1);
    else flags[args[index].slice(2)] = args[(index += 1)];
  }
  return { positional, flags };
}

export const GITHUB_WRITE_DRY_RUN_VERBS = Object.freeze(["post", "pr-body"]);

export const githubWriteDryRun = (verb, flags) => GITHUB_WRITE_DRY_RUN_VERBS.includes(verb) && flags["dry-run"] === true;

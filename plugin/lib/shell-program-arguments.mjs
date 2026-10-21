export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "rbash", "ash", "mksh", "csh", "tcsh", "yash"]);
export const INTERPRETER = /^(?:python|node|perl|ruby|deno|bun|php|tsx|ts-node)[\d.]*$/;

const STDIN_SCRIPT = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/[^/]+\/fd\/\d+)$|^<\(/;
const GLOB = /[*?[]/;
const EXPANSION = /[$`]/;
const REDIRECT = /^\d*(?:[<>](?!\()|&>)/;
const BARE_REDIRECT = /^\d*(?:[<>][<>&|-]*|&>>?)$/;
const STDIN_FEED = /^0?<(?!\()/;
const NODE_VALUE_FLAGS = new Set(["-r", "-C", "--require", "--import", "--loader", "--experimental-loader", "--input-type", "--conditions", "--env-file", "--title"]);
const FAMILIES = {
  shell: { value: (arg) => /^[-+][a-zA-Z]*[oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file", inline: (arg) => /^-[a-zA-Z]*c/.test(arg) },
  python: { value: (arg) => /^-[a-zA-VYZ]*[WX]$/.test(arg) || arg === "--check-hash-based-pycs", inline: (arg) => /^-[a-zA-VYZ]*[cm]/.test(arg) },
  node: { value: (arg) => NODE_VALUE_FLAGS.has(arg), inline: (arg) => /^(?:-e|-p|-pe|--eval|--print|--test|--run)$|^--(?:eval|print)=/.test(arg) },
  other: { value: () => false, inline: (arg) => /^(?:-[a-zA-Z]*[eE]|-r|--eval|--print)$|^--(?:eval|print)=/.test(arg) },
};

function family(program) {
  if (SHELLS.has(program)) return "shell";
  if (/^python/.test(program)) return "python";
  if (/^node/.test(program)) return "node";
  return "other";
}

export function scriptOperand(program, args) {
  const name = family(program);
  const rules = FAMILIES[name];
  let subcommand = /^(?:deno|bun)/.test(program);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (BARE_REDIRECT.test(arg)) {
      index += 1;
      continue;
    }
    if (REDIRECT.test(arg)) continue;
    if (arg === "-") return { script: arg, index };
    if (rules.inline(arg)) return { inline: true };
    if (arg.startsWith("-") || (name === "shell" && arg.startsWith("+"))) {
      if (rules.value(arg)) index += 1;
      continue;
    }
    if (subcommand && arg === "run") {
      subcommand = false;
      continue;
    }
    if (subcommand && arg === "eval") return { inline: true };
    return { script: arg, index };
  }
  return {};
}

export function readsUnreadableCode(program, args, piped) {
  const { script, inline } = scriptOperand(program, args);
  if (inline) return false;
  if (script !== undefined) return STDIN_SCRIPT.test(script) || GLOB.test(script);
  return SHELLS.has(program) || piped || args.some((arg) => STDIN_FEED.test(arg));
}

export function variableScriptArguments(program, args) {
  const { script, index } = scriptOperand(program, args);
  return script !== undefined && EXPANSION.test(script) ? args.slice(index + 1) : null;
}

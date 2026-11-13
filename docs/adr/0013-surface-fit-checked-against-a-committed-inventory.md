# 0013: Every kit need is judged against a committed Claude Code inventory, and the kit goes first where prior art stops

Status: accepted (2026-10-30); archived 2026-11-13: its checks, records and suites left main and live at tag `archive/governance-v0.3.4`

## Context
- ADR 0011 left S27 (Claude Code surface fit) and S32 (quota efficiency) partial because no studied source failed an artifact on either, "so the kit would be first; they wait for evidence".
- The S27 gap was live: `docs/prior-art/claude-code-surfaces.md` described Claude Code 2.1.302 while 2.1.314 was installed, and nothing failed.
- On 2026-10-30 a purposive search screened 37 candidates in one session (GitHub code search, Anthropic docs, installed plugins, X, YouTube). It found sources that fail on the narrow mechanisms: a check that fails when the Claude Code inventory drifts from a committed snapshot (S27), and per-case token and cost budgets on skill eval cases (S32). No source maps each need to every surface, and none checks cache TTL, cached-prefix order, context share or a non-skill artifact. The four are added to sweep `261021-canon` as a supplement, with a threat for how they were found.
- The user chose (2026-10-30) to write the cards and let the kit go first for the rest, and to fail the inventory check on a minor version, not a patch.

## Decision
- `python3 plugin/evals/probes/claude-code-inventory.py --json docs/canon/claude-code-inventory.json` writes the inventory snapshot: the Claude Code version, the digest of the docs index, the hook events and the plugin components. It refreshes the snapshot over the network; `npm test` reads only the committed file.
- `archive/governance-v0.3.4:docs/canon/surface-fit.json` lists the kit's needs. Each names the surface it uses and why every other surface of the snapshot (plus the settings-level surfaces it lists) was not chosen; a surface no need fits carries one kit-wide reason. It records the digest of the inventory it was judged against.
- `surfaceFitErrors` fails an unjudged need and surface pair, an empty reason, a surface missing from the inventory, a surface both used and marked unused, and a fit judged against another inventory. `inventoryVersionErrors` fails a snapshot a minor version or more behind the installed Claude Code and skips when none is installed.
- ADR 0011's partial line is amended: the narrow mechanisms have prior art; the kit goes first on mapping needs to the whole inventory (S27) and on quota checks beyond per-case budgets (S32).
- S32's technique set comes from the quota study, read by deep reading (user, 2026-10-30), and is decided in its own ADR; S32 stays partial until then. The S27 rule enters `standard.json` in the next standard version, together with S32's.

## Prior art

- retif/claudecode-linter (MIT, studied 2026-10-30, via github)
  - card: claudecode-linter
  - https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L66-L68 "LATEST=$(npm view @anthropic-ai/claude-code version)"
  - https://github.com/retif/claudecode-linter/blob/94fb3ddd05d16cee82a43cbedc0cead23546c444/.github/workflows/ci.yml#L82-L89 "if (norm(committed) !== norm(current)) { console.log("Contract values changed — update needed:");"
  - Lesson: extract the platform's surface lists from the release and fail CI when they differ from the committed copy, so drift is found without anyone reading a changelog.
  - Taken: the committed snapshot and the digest the fit was judged against. Not taken: a run against the latest npm release in CI; the kit has no CI and checks the installed version instead.
- JuliusBrussee/caveman (Apache-2.0, studied 2026-10-30, via github)
  - card: caveman
  - https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L117-L120 "const versionMatches = profile.tested_agent_version === "x" || observed === profile.tested_agent_version;"
  - https://github.com/JuliusBrussee/caveman/blob/9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4/agents/probe-installed.mjs#L156 "process.exit(failed ? 1 : 0);"
  - Lesson: pin the agent version a profile was tested on and fail when the installed one moves past it.
  - Taken: `inventoryVersionErrors`, at minor granularity by the user's choice.
- EmadMokhtar/skill-evaluator (MIT, studied 2026-10-30, via github)
  - card: skill-evaluator
  - https://github.com/EmadMokhtar/skill-evaluator/blob/1ce02bc689899cf801d4b6fa83c16e26b41be3e5/src/skill_lens/evaluators/budget.py#L54 "held = result.cost_usd <= spec.max_cost_usd"
  - Lesson: a token or cost budget per eval case is a default evaluator, and a case over it fails the gate.
  - Not taken: S32's checks wait for the quota study's technique set, decided in their own ADR.
- tardigrde/agent-skill-eval (MIT, studied 2026-10-30, via github)
  - card: agent-skill-eval
  - https://github.com/tardigrde/agent-skill-eval/blob/59de161f657b82bfaf8f6abe83dfff38552deb21/src/agent_skill_eval/models.py#L263-L270 "and timing.non_cached_input_tokens > self.max_non_cached_input_tokens"
  - Lesson: a limit on non-cached input tokens is the only budget found that touches caching.
  - Not taken: S32's checks wait for the quota study's technique set, decided in their own ADR.

no social prior art: 2026-10-30 x: "claude code hook events drift CI"; youtube: "claude code skill token budget CI eval"

## Consequences
- A Claude Code minor release, or a change to the docs index, hook events or plugin components, turns `npm test` red until the probe is rerun and every need is judged against the new snapshot.
- Weakest link: the digest error clears with a one-line edit of `inventory`, so nothing proves the needs were re-judged; caveman re-runs the recorded observation before a pin moves, and the kit has no such check. Second: retif's changelog shows a tool, an agent frontmatter key and an MCP server field added in patch releases (2.1.301), which the minor-version rule lets through until the next minor release; none of those is a surface kind in the kit's inventory, but a new hook event in a patch would be. Third: the probe stamps the installed version while it reads the live docs, and nothing ties the two.

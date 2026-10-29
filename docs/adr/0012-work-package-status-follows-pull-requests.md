# 0012: A work package's status follows its pull requests, decided by one function and applied by the session that acts

Status: accepted (2026-10-29)

## Context
- Under ADR 0004 and the user's rule 25, status moved only through one batch hand-off from the review session to the PM session and one approval. On 2026-10-29 the user found that too slow and asked for the skills to move status themselves: In progress when `/tedy:dev` starts a task, Merged/Code Review when its PR opens, and, after a review that passes, a merge the user approves followed by Closed, or Fixed (Dev Done) and back to the tester for a bug a tester filed.
- `merged-sweep.mjs` took the newest event per package: a merged PR won over one still open, PRs into any branch counted, open PRs were read only for the user and only since the last sweep, and a closed package was never reopened by a revert.
- Project 183 on 2026-10-29: 312 Tasks Closed against 7 in Merged/Code Review; of 178 bugs, 95 were filed by the one member with the Tester role and 52 sat in Fixed (Dev Done).

## Decision
- One pure function (`plugin/lib/status-flow.mjs`) derives the target from facts: every PR whose body links the package, only those into the repo's integration branch, the package's type and status, and the author's project roles. An open PR means review, all merged means merged, a revert merged after the last work means revert, no PR yet means start once the work begins.
- The map holds the flow per type (`tracker.flow`), with a per-role override that hands a package back to its author; maps that still hold `merge_status`, `open_status` and `revert_status` keep working.
- It moves forward only; a revert is the only way back and reopens even a closed package; a status outside the flow (On hold, Blocked, Rejected) is a person's choice and is left alone with the reason.
- `/tedy:dev` and `/tedy:review-pr` apply it through `openproject.mjs set`, with the preview lines in the question the step already asks (`plugin/shared/status-flow.md`). `/tedy:review-pr` merges a passed PR only on the user's yes. The role gate lets the dev and review sessions change a status or assignee; any other tracker write still belongs to the PM session. `merged-sweep.mjs` stays as the catch-up for events outside the skills and plans through the same function.

## Prior art

- Linear GitHub integration docs (public docs, studied 2026-10-29, via web)
  - https://linear.app/docs/github "The Linear issue status will be updated when the final linked PR moves to the required state from your workflow."
  - Lesson: an issue with several PRs moves only when the last of them does.
  - Taken: "merged" means every linked PR merged and none open.
- Jira automation template, PR merged (public docs, studied 2026-10-29, via web)
  - https://www.atlassian.com/software/jira/automation-template-library/devops-pr-merged "when a Pull Request is merged, if the status is 'In Review' and there are no open pull requests, automation will transition the issue to 'done'"
  - Lesson: a transition is guarded by the current status and by the count of open PRs.
  - Taken: forward-only moves guarded by the current status, and the open-PR check.
- OpenProject workflows and schema docs (public docs, studied 2026-10-29, via web)
  - https://www.openproject.org/docs/system-admin-guide/manage-work-packages/work-package-types/workflows/ "A **workflow** in OpenProject defines the allowed transitions between work package statuses for a role and a work package type."
  - https://www.openproject.org/docs/api/endpoints/schemas/ "List of resources that are assignable by the current user."
  - Lesson: the tracker already limits transitions per role and type, and the form tells the caller which statuses it may set.
  - Taken: `openproject.mjs set` previews through the form before any write; the flow is per type with a role override.

no social prior art: 2026-10-29 x: "auto move ticket status when PR merged reassign to QA tester"; youtube: "jira automation pull request merged transition issue assign reporter"

## Consequences
- The PM hand-off is no longer the only path for status: rule 25 and the status part of ADR 0004 are superseded for status and assignee changes on packages the acting session works on.
- A tester's bug lands back with its author at Fixed (Dev Done); the tester, not the agent, closes it.
- Weakest link: the YouTube search found only tutorials on a single merge transition, and the three web sources are vendor docs describing their own product; the flow's per-type values are the user's, read from one project.

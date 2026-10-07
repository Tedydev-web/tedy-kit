# TONtv

TonTV Telegram Mini App, backend and admin. Written by `/tedy:setup`; edit through `/tedy:setup update`.

```json
{
  "name": "tontv",
  "paths": ["/home/tedydev/Documents/workspace/TONtv"],
  "repos": [
    { "path": "tontv-be", "role": "BE", "branch": "dev" },
    { "path": "tontv-tma", "role": "FE", "branch": "develop" },
    { "path": "tontv-admin", "role": "admin-FE", "branch": "develop" }
  ],
  "language": { "pr_review": "vi", "pr_body": "en", "tracker": "en", "doc_figma": "vi" },
  "prd": {
    "files": [
      "docs/TonTV - Telegram Mini App - Product Requirements Document.md",
      "docs/prd/PRD_Ton_TV_Platform_Specification.md",
      "docs/prd/PRD_TonTV_Ads_Platform.md"
    ]
  },
  "verify_gotchas": [
    "tontv-be production deploys only through a manual Jenkins build with DEPLOY=true; land production config in a PR to production first, then back-merge production into dev with a merge commit."
  ],
  "tracker": { "type": "openproject", "instance": "https://task.toncorp.io", "project": 162, "rules": [] },
  "learned_until": "2026-10-07",
  "last_reply_check": null,
  "open_questions": [
    { "q": "Is there a Figma file for TONtv?", "tried": "AGENTS.md, CLAUDE.md, README.md, docs/ and each repo's README and docs; docs/design holds only .pen files" }
  ]
}
```

# tonpass · Family Wallet

Family Wallet only; Gift-Card work in this workspace is out of scope. Written by `/tedy:setup`; edit through `/tedy:setup update`.

```json
{
  "name": "tonpass-family-wallet",
  "paths": ["/home/tedydev/Documents/workspace/tonpass"],
  "repos": [
    { "path": "tonpass-wallet-fe", "role": "FE", "branch": "dev" },
    { "path": "tonpass-wallet-be", "role": "BE", "branch": "dev", "readonly": true },
    { "path": "family-wallet-smartcontract", "role": "contract", "branch": "dev", "readonly": true },
    { "path": "onedollar-wallet-admin-fe", "role": "admin-FE", "branch": "dev" },
    { "path": "tonpass-wallet-admin-be", "role": "admin-BE", "branch": "dev" }
  ],
  "language": { "pr_review": "vi", "pr_body": "en", "tracker": "en", "doc_figma": "vi" },
  "prd": {
    "doc": "1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns",
    "tabs": {
      "01": { "tab": "t.0", "title": "Onboarding", "uc": "UC_OB" },
      "02": { "tab": "t.eis6p84lwi84", "title": "My Wallet", "uc": "UC_MW" },
      "03": { "tab": "t.qwehuatg2510", "title": "Settings", "uc": "UC_ST" },
      "04": { "tab": "t.5bfx3q9odfym", "title": "Admin Console", "uc": "UC_AD" },
      "05": { "tab": "t.dlv3echvtq1", "title": "Home - Family Wallet", "uc": "UC_FW" },
      "06": { "tab": "t.h6w8ajg2mxhw", "title": "Recovery (draft)", "uc": "UC_RC" },
      "07": { "tab": "t.mgu51yavprk8", "title": "Ledger", "uc": "UC_LG" },
      "08": { "tab": "t.qfq5co4ax5ij", "title": "Members", "uc": "UC_MB" },
      "09": { "tab": "t.p59op2unmr", "title": "Shared Wallet Settings", "uc": "UC_SW" }
    }
  },
  "figma": {
    "file": "LcVgoxchcAU5J4TYLa3AQ8",
    "nodes": {
      "all": [{ "node": "2109:1763", "label": "Family-Wallet-UI root" }],
      "01": [{ "node": "2142:2898", "label": "On board" }],
      "02": [{ "node": "2142:2896", "label": "Personal wallet" }],
      "03": [{ "node": "2142:2894", "label": "Setting (ONE Wallet, restyle to Family Wallet)" }, { "node": "2228:4454", "label": "Recovery (ONE Wallet, restyle)" }],
      "05": [{ "node": "2447:5405", "label": "Space Wallet" }],
      "07": [{ "node": "2802:5083", "label": "Ledger" }],
      "08": [{ "node": "3319:13904", "label": "Member" }],
      "09": [{ "node": "3445:6702", "label": "Settings" }]
    }
  },
  "demo": [
    { "url": "https://familywallet-home.vercel.app/familywallet-home-tma.html", "covers": "TMA; JS carries \"PM yyyy-mm-dd\" rule comments" },
    { "url": "https://familywallet-admin.vercel.app", "covers": "Admin console" }
  ],
  "verify_gotchas": [
    "npx tsc inside a worktree resolves @tonpass/core to the main checkout's packages/core; typecheck core-touching PRs with a tsconfig.review.json that points @tonpass/core at ../../packages/core/src, and build the dev baseline the same way before calling an error pre-existing.",
    "The machine-global gitignore excludes *.test.* files, so a repo that does not re-include them commits and runs no tests.",
    "After every commit git status must be empty; unstaged sed edits once broke dev through #673."
  ],
  "tracker": {
    "type": "openproject",
    "instance": "https://task.toncorp.io",
    "project": 183,
    "rules": [
      "One task is one branch and one PR into dev; never merge.",
      "Write [FE] tasks by default; write [BE] or [Admin-BE] tasks only when the user asks (2026-10-05, 2026-10-06), checked against PRD and design with extra care, and never for the backend team's own queue (Tân, 2026-10-05). A missing API otherwise goes into the FE wire task's open questions.",
      "Always split UI and wire into two tasks, even when one person does both.",
      "Write at PM altitude: no function, file or endpoint names in the task; technical notes go in a reference comment; at most 220 words.",
      "Every new task carries an estimate (the agent's estimate halved) and start and due dates scheduled at 8 hours a day per assignee; ask only for the start date of a new story.",
      "The API token moves a story only up to Ready for QA and a task to Merged, Code Review or Closed; change status in its own PATCH."
    ]
  },
  "truth_overrides": [
    "2026-10-06 (user): check in the order PRD, Figma, BE + contract, code quality. FE matches BE + contract in form; BE + contract must match PRD + Figma; raise every mismatch without a convincing reason as an evidenced list for the BE and blockchain teams.",
    "2026-10-05 (user): when a Figma frame is newer than the PRD text it contradicts, Figma wins; cite \"Figma and PM demo, <date>; PRD <UC> not updated yet\" and still flag the PRD as stale.",
    "2026-09-07 (PM): Figma decides which features exist; the PRD is for comparison, business logic and detail. Do not cut a capability both apps/1dollar and apps/tonpass ship because the PRD omits it.",
    "2026-10-02 (PM, designer): EPIC 09 stamp numbers beat EPIC 05; Figma frame numbers are illustrative; Figma has no toast component, so the PRD is the authority for toasts.",
    "Timezone questions: UTC, fixed."
  ],
  "team": {
    "Shared wallet Settings (Plans, Display currency, handover)": "Phúc",
    "Ledger History tab": "Tedy",
    "Ledger, everything else": "Tín",
    "Admin console epic #20938": "Tedy",
    "Figma change to a built screen, UI only": "Tedy",
    "Figma change to a built screen, touching its logic": "the original builder"
  },
  "sessions": [
    { "name": "PM - Family Wallet", "role": "pm" },
    { "name": "Review PR - Family Wallet", "role": "review" },
    { "name": "Dev TMA - Family Wallet", "role": "dev", "repos": ["tonpass-wallet-fe"] },
    { "name": "Dev Admin - Family Wallet", "role": "dev", "repos": ["onedollar-wallet-admin-fe", "tonpass-wallet-admin-be"] },
    { "name": "DevOps - Family Wallet", "role": "devops" }
  ],
  "learned_until": "2026-10-07",
  "last_reply_check": "2026-10-08T10:05:00Z",
  "open_questions": [
    { "q": "Which PRD tab holds EPIC 06?", "tried": "resolved 2026-10-07: tab ids read from the Doc page; t.h6w8ajg2mxhw is EPIC 06 Recovery (draft, UC_RC); t.432ud3jdzos6 and t.dplz1vp0m5kx are the epic table" },
    { "q": "The 2026-10-06 brief's \"Epic Ledger\" PRD link points at Figma 2802:5083, not the Doc.", "tried": "resolved: tab t.mgu51yavprk8 is EPIC 07 Ledger (UC_LG), confirmed by prd-section index" }
  ]
}
```

# Tracker task style

How an OpenProject work package reads. Measured on the 82 work packages created in Family Wallet (project 183) from 2026-10-02 to 2026-10-07, after the corrections on task altitude (2026-09-22), the UI/wire split (2026-09-29) and estimates and dates (2026-10-05). English body, markdown.

## Shapes

| Type | Subject | Sections, in order |
|---|---|---|
| User story | A noun phrase: `Plan configuration`, `Display currency` | `## User Story` (As a …, I want …, so that …), `## Context` (PRD EPIC · UC, demo link), `## Acceptance Criteria` |
| Task | `[FE]`, `[BE]`, `[Admin-FE]` or `[Admin-BE]`, then the screen and the action: `[FE] Vault limit pop-up on Free`; a wire task reads `[FE] Wire <thing> to the API` | `## Goal` (1–2 sentences, PRD codes in parentheses, sibling task ids: "Wiring is the next task", "(#21294)"), `## Checklist` (`- [ ]`, observable behaviour, UI copy in quotes), `## AC` (1–2 observable checks), then optional `## Open questions`, `## Notes`, `## 🎨 Design` (Figma links) |
| Bug | `[Bug] <Area>: <what is wrong>` | `## Problem`, `## Expected` (cites the PRD rule), `## AC` |

## Measurements

| Type | Count | Words, median / max | Checklist max | AC max |
|---|---|---|---|---|
| Task [FE] | 40 | 145 / 243 | 8 | 2 |
| Task [BE] | 16 | 135 / 211 | 8 | 3 |
| Task [Admin-FE], [Admin-BE] | 6 | 153–184 / 214 | 6 | 1 |
| Bug | 12 | 75 / 131 | none | 2 |
| User story | 5 | 85 / 123 | none | 3 |

Word count leaves out headings, checkbox markers and URLs. Limits: a task at most 220 words (a few reached 243–255 and were the exception, not the target), Checklist at most 8, AC at most 6.

## Rules the samples carry

- A task speaks at the PM's altitude: behaviour, copy, states and PRD codes. Function names, files, endpoints and libraries stay out; scouting results go into a task comment that opens "Reference for whoever implements, not part of the checklist".
- Every screen gets two tasks, UI on sample data and its wire task, even when one person does both; the UI task ends its Goal with "Wiring is the next task" and the wire task names the UI task and the backend task.
- `## Open questions` lists each gap as a fact: what is missing and who was asked ("asked the PM"). The closing Checklist line "Report the gaps below to the backend team." appears in 7 of 23 such tasks, all by 2026-10-05, and later tasks drop it.
- Estimate: the agent's own estimate halved, as `PT<h>H<m>M`. Start and due dates are scheduled at 8 hours a day per assignee; only the start date of a new story is asked.
- `[BE]` and `[Admin-BE]` tasks are written only when the user asks for them, checked against the PRD and design with extra care (2026-10-05: "với task của BE bạn cần lên thật chính xác"). Never for the backend team's own queue: "lên luôn task BE cho Tân thì đừng làm gì cả vì ngoài quyền hạn của chúng ta rồi".

## Samples (verbatim, as published)

### 1. User story: #21270 Plan configuration

```markdown
## User Story
As an Ops or finance staff member, I want to set each plan's prices, monthly stamps, member limits and prepay terms in one place, so that the TMA always shows and charges the values the company decided.

## Context
PRD EPIC 04 UC_AD_08 (Screen 04). Live demo: https://familywallet-admin.vercel.app (Plans).

## Acceptance Criteria
- [ ] An invalid value can never be saved.
- [ ] Every saved change records who made it and when.
- [ ] The TMA reads the saved values on its next load.
```

### 2. UI task with open questions and design: #21298 [FE] Vault limit pop-up on Free

```markdown
## Goal
Stop a Free wallet that already holds 3 vaults from creating another, and point the group to Pro, on sample data (PRD EPIC 05 UC_FW_02 EF3, BR9; EPIC 09 UC_SW_S02 BR1a). Wiring is the next task.

## Checklist
- [ ] On Free with 3 vaults or more, Add in the Vaults header shows the pop-up instead of creating a vault.
- [ ] Pop-up: title "Free plan holds up to 3 vaults", line "Upgrade to Pro for unlimited vaults.", primary "Upgrade to Pro", secondary "Not now".
- [ ] Upgrade to Pro opens the Plan page with Pro picked (#21175); Not now closes the pop-up.
- [ ] Pro, Pro Plus and Ultra never see it; a wallet that drops to Free keeps using every vault it has.
- [ ] The copy is translated in all five languages.

## AC
- [ ] On Free, a 4th vault cannot be started; with 2 vaults, Add works as today.

## Open questions
- The PRD shows the pop-up in place of the create screen; the frame draws it over the Create a Vault form. Asked the PM which one holds.

## 🎨 Design
- [Vault limit pop-up](https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=4408-8157&m=dev)
```

### 3. Wire task: #21299 [FE] Wire the vault limit to the API

```markdown
## Goal
Drive the vault-limit pop-up (#21298) from the backend's plan and vault count (#21294).

## Checklist
- [ ] The plan and the vault count come from the backend; the pop-up shows only when the backend says the limit is reached.
- [ ] If the backend refuses a create at the limit, for example after a plan change on another device, show the same pop-up, not a generic error.
- [ ] After an upgrade, Add opens the create screen without a reload.

## AC
- [ ] On Free with 3 vaults the backend refuses a 4th and the app shows the pop-up; on Pro the vault is created.

## Open questions
- #21294 fixes the limit at 3 in code; if the PM moves it into the Admin plan settings, this reads it from the plan config (#21289).
```

### 4. Admin backend task: #21301 [Admin-BE] Stamp price: validate, record and save through the TMA backend

```markdown
## Goal
Let the Stamp price screen (#21300) read and change the price per stamp that the TMA backend uses for Buy stamps, with the checks, history and staff guard of PRD EPIC 04 UC_AD_09. The admin backend keeps no copy.

## Checklist
- [ ] Read and save the USDT and Stampy price per stamp through the TMA backend.
- [ ] Refuse any value that breaks UC_AD_09 BR2–BR4, whatever the client sends.
- [ ] A save is all-or-nothing and records the staff member, the time and each old → new value.
- [ ] Refuse a save made on prices another staff member has since changed, saying who and when.
- [ ] Only staff allowed to configure prices can save.

## AC
- [ ] After a save, the next stamp purchase in the TMA pays the new price, and each change has a history entry.

## Open questions
- The TMA backend has no stamp price setting and no task for one; Buy stamps needs it to read the saved prices (UC_AD_09 BR5–BR6).
- No GRAM price exists while Buy stamps accepts GRAM; asked the PM.
```

### 5. Backend task the user asked for: #21262 [BE] Activity rows carry category, USD at settlement and network fee

```markdown
## Goal
Activity rows declare three fields the backend never fills: the category, the USD value and the network fee. Without them spends read Others and the Ledger has no USD or fees (PRD EPIC 05 UC_FW_01 copy table, UC_FW_06 BR7; EPIC 07 UC_LG_01 BR2–BR3, UC_LG_06 BR3). Blocks #21260 and #21263.

## Checklist
- [ ] A spend, pending or settled, carries the category picked on the Send sheet and keeps it after that category is deleted (PM 05/10); a spend without one reads Others.
- [ ] Every money row, in or out, stores its USD value at the rate when it settles; an outgoing row settles when it turns in-progress, since in-progress already counts (UC_LG_01 BR3). The value never changes afterwards.
- [ ] Outgoing on-chain rows store the fee actually charged, in native coin with its USD value, once the chain reports it.
- [ ] Stamp purchases store the stamp count, the USD paid and whether the shared wallet or the buyer's own wallet paid (UC_FW_05).
- [ ] Rows that settled before this change are back-filled at each row's price at its settlement time (PM 05/10); find a historical price source, since none is kept.

## AC
- [ ] On a test wallet, every settled deposit, spend, fee and stamp purchase has its USD filled, spends their category and on-chain rows their fee.

## 🎨 Design
- [Overview](https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=2954-6897&m=dev)
- [Fees & stamps](https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=3030-8771&m=dev)
```

### 6. Bug: #21281 [Bug] Settings: a bad photo shows a raw technical error

```markdown
## Problem
Picking a photo that is too large or of the wrong type shows the internal error message as the toast.

## Expected
PRD UC_FW_16 BR6: every toast comes from the toast registry, one line, translated.

## AC
- [ ] A failed photo pick shows one fixed, translated message in all five languages.
```

## Avoid

| Pattern | Why (evidence) |
|---|---|
| Hook, function, file or endpoint names in the Checklist | #21046, 2026-09-22: "không technical quá ở trong task của dev mà chỉ mang tính chất cung cấp thông tin thôi" |
| One task for UI and wiring | User rule 2026-09-29: always two tasks |
| A task without estimate or dates | User rule 2026-10-05 |
| A `[BE]` task nobody asked for | 2026-10-05: backend work outside the user's remit is not ticketed by the agent |
| Creating or changing work packages before the user approved the preview | 2026-10-07: "soạn bản xem trước … để tôi duyệt", then "ok duyệt …, tạo luôn" |

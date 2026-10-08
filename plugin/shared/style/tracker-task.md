# Tracker task style

Default samples for tracker work items. A profile copy at `<profile>/style/tracker-task.md` replaces this file; measure your own published items and put them there. `task-lint.mjs` enforces the mechanical half (sections, checkboxes, word limits, scope leaks); the samples carry the rest.

## Shapes

| Type | Subject | Sections, in order |
|---|---|---|
| User story | A noun phrase: `Shipping rates`, `Display currency` | `## User Story` (As a …, I want …, so that …), `## Context` (PRD EPIC · UC, demo link), `## Acceptance Criteria` |
| Task | `[FE]`, `[BE]`, `[Admin-FE]` or `[Admin-BE]`, then the screen and the action: `[FE] Cart limit pop-up on Free`; a wire task reads `[FE] Wire <thing> to the API` | `## Goal` (1–2 sentences, PRD codes in parentheses), `## Checklist`, `## AC`, then `## Open questions` and `## 🎨 Design` when they apply |
| Bug | `[Bug] <Area>: <what is wrong>` | `## Problem`, `## Expected` (cites the PRD rule), `## AC` |

## Rules the samples carry

- A task speaks at the PM's altitude: behaviour, copy, states and PRD codes. Function names, files, endpoints and libraries stay out; scouting results go into a task comment for whoever implements it.
- Every screen gets two tasks, UI on sample data and its wire task, even when one person does both; the UI task ends its Goal with "Wiring is the next task".
- `## Open questions` lists each gap as a fact: what is missing and who was asked. A gap that stops the build opens with `Blocking:` and carries `Tried:` with where it was looked up.
- Backend tasks are drafted only when the user asks for them.

## Samples

### 1. User story: #101 Shipping rates

```markdown
## User Story
As a store manager, I want to set the shipping rate for each region in one place, so that checkout always shows and charges the rate the store decided.

## Context
PRD EPIC 04 UC_AD_08 (Screen 04). Live demo: https://demo.example.com/admin (Shipping).

## Acceptance Criteria
- [ ] An invalid rate can never be saved.
- [ ] Every saved change records who made it and when.
- [ ] Checkout reads the saved rates on its next load.
```

### 2. UI task with open questions and design: #102 [FE] Cart limit pop-up on Free

```markdown
## Goal
Stop a Free account that already holds 3 saved carts from creating another, and point it to Pro, on sample data (PRD EPIC 05 UC_CT_02 EF3, BR9). Wiring is the next task.

## Checklist
- [ ] On Free with 3 saved carts or more, New cart in the Carts header shows the pop-up instead of creating a cart.
- [ ] Pop-up: title "Free plan holds up to 3 carts", line "Upgrade to Pro for unlimited carts.", primary "Upgrade to Pro", secondary "Not now".
- [ ] Upgrade to Pro opens the Plan page with Pro picked (#95); Not now closes the pop-up.
- [ ] Pro accounts never see it; an account that drops to Free keeps every cart it has.
- [ ] The copy is translated in every supported language.

## AC
- [ ] On Free, a 4th cart cannot be started; with 2 carts, New cart works as today.

## Open questions
- The PRD shows the pop-up in place of the create screen; the frame draws it over the New cart form. Asked the PM which one holds.

## 🎨 Design
- [Cart limit pop-up](https://www.figma.com/design/FakeFigmaKeyyyyyyyyyyy/Shop-UI?node-id=4408-8157&m=dev)
```

### 3. Wire task: #103 [FE] Wire the cart limit to the API

```markdown
## Goal
Drive the cart-limit pop-up (#102) from the backend's plan and cart count (#98).

## Checklist
- [ ] The plan and the cart count come from the backend; the pop-up shows only when the backend says the limit is reached.
- [ ] If the backend refuses a create at the limit, for example after a plan change on another device, show the same pop-up, not a generic error.
- [ ] After an upgrade, New cart opens the create screen without a reload.

## AC
- [ ] On Free with 3 carts the backend refuses a 4th and the app shows the pop-up; on Pro the cart is created.

## Open questions
- #98 fixes the limit at 3; if the PM moves it into the admin plan settings, this reads it from the plan config (#97).
```

### 4. Admin backend task: #104 [Admin-BE] Shipping rate: validate, record and save

```markdown
## Goal
Let the Shipping screen (#100) read and change the rate per region that checkout uses, with the checks, history and staff guard of PRD EPIC 04 UC_AD_09.

## Checklist
- [ ] Read and save the rate per region.
- [ ] Refuse any value that breaks UC_AD_09 BR2–BR4, whatever the client sends.
- [ ] A save is all-or-nothing and records the staff member, the time and each old → new value.
- [ ] Refuse a save made on rates another staff member has since changed, saying who and when.
- [ ] Only staff allowed to configure rates can save.

## AC
- [ ] After a save, the next checkout charges the new rate, and each change has a history entry.

## Open questions
- No rate exists for islands while checkout ships there; asked the PM.
```

### 5. Backend task the user asked for: #105 [BE] Order rows carry category, total at payment and shipping fee

```markdown
## Goal
Order history rows declare three fields the backend never fills: the category, the total at payment and the shipping fee. Without them every order reads Others and the history shows no totals (PRD EPIC 07 UC_OR_01 BR3).

## Checklist
- [ ] An order carries the category picked at checkout and keeps it after that category is deleted; an order without one reads Others.
- [ ] Every paid order stores its total at the moment it is paid; the value never changes afterwards.
- [ ] Shipped orders store the shipping fee actually charged once the carrier confirms it.
- [ ] Orders paid before this change are back-filled from their payment records.

## AC
- [ ] On a test account, every paid order has its total, its category and, once shipped, its fee.
```

### 6. Bug: #106 [Bug] Settings: a bad avatar shows a raw technical error

```markdown
## Problem
Picking an avatar that is too large or of the wrong type shows the internal error message as the toast.

## Expected
PRD UC_ST_16 BR6: every toast comes from the toast registry, one line, translated.

## AC
- [ ] A failed avatar pick shows one fixed, translated message in every supported language.
```

## Avoid

| Pattern | Why |
|---|---|
| Hook, function, file or endpoint names in the Checklist | Tasks inform the developer; how to build it is theirs |
| One task for UI and wiring | UI and wiring are always two tasks |
| A task without estimate or dates | Planning reads them |
| A backend task nobody asked for | Backend work outside the user's remit is not ticketed by the agent |
| Creating or changing items before the user approved the preview | The user reads the preview first |

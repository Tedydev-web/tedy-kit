# Refresh a PR body

To refresh the body of the user's PR from its work package: write a new body with `node <plugin>/scripts/openproject.mjs pr-body <id> > <tmp>/pr-body.md`, quote that file's text and the command below in one fenced block of the reply (`shared/decision-points.md`), then run `github-write.mjs pr-body <pr> --body-file <tmp>/pr-body.md --repo <o/r>` through `publish-batch.mjs` (`shared/decision-points.md`).

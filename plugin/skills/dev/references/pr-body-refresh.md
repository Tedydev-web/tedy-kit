# Refresh a PR body

To refresh the body of the user's PR from its work package: write a new body with `node <plugin>/scripts/openproject.mjs pr-body <id> > <tmp>/pr-body.md`, show a line `PR #<pr> · body` and that file's text verbatim, with no command line (`shared/decision-points.md`), then run `github-write.mjs pr-body <pr> --body-file <tmp>/pr-body.md --repo <o/r>` through `publish-batch.mjs` (`shared/decision-points.md`).

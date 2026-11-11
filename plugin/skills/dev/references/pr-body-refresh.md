# Refresh a PR body

To refresh the body of the user's PR from its work package: write a new body with `node <plugin>/scripts/openproject.mjs pr-body <id> > <tmp>/pr-body.md`, ask `approve.all` with that file's text and the command below in the `preview`, quoting that whole preview in one fenced block of the reply right before the question (`shared/decision-points.md`), then run `node <plugin>/scripts/github-write.mjs pr-body <pr> --body-file <tmp>/pr-body.md --repo <o/r>`.

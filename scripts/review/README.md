# Review workflows

`dimension-review.workflow.js` — the review that found 8 confirmed defects in the 2026-10-20 sign-in cut-over
(6 dimension finders → dedup by file/line → 3 perspective-diverse refuters per finding, kept when 2 of 3 uphold).
To reuse: copy it, edit `CONTEXT` (what changed, commit range, out-of-scope list, already-fixed list) and
`DIMENSIONS`, keep `model: 'claude-opus-5-5'` on every `agent()`, finders at effort `medium`, verifiers `high`.
Run it with the Workflow tool (`scriptPath`).

`summarize-review.mjs <workflow .output file> <out.txt>` — turns the workflow result into a compact list
(severity, file:line, scenario, fix, dissent) so the full 50–100 kB output never has to be read.

Track record 2026-10-20: cut-over review 8/10 confirmed; fix-commit regression review 1/1; password-reset review
4/5 (the password-manager exposure). Every security feature got at least one real finding — run one per feature.

`leave-refresh-review.workflow.js`: the review of the leave/refresh generation fixes, fea3698..ba39483 (2026-10-20). It confirmed 8 of 8 findings, all fixed in 48d562c, cbbb695, 1e0ecf1 and 97bb6f0. It adds a SQL rule for reviewers: behavior tests run only `set local role anon` inside a `do $$ ... raise exception 'RESULT: %', r; end $$` block, so they roll back. That is how the anon-only 401 outage of 2026-10-20 would have been caught.

# Coding-agent guidance (Codex and Claude)

## Production diagnostics

Codex Cloud has an approved read-only diagnostic workflow in
`dd64ru/Mom-I-am-OK`: `.github/workflows/diagnose-backend-logs.yml`. It becomes
available only after its reviewed implementation is merged to App `main`.
When investigating actual production failures, backend behavior, AI recognition,
provider resolution, unexpected server outcomes or incident-specific regressions,
consider consulting safe existing diagnostics before proposing speculative fixes.
Lookup is optional for layout, styling, copy and other purely code-only work.
Use the App's `docs/backend-log-diagnostics.md` guide on its reviewed main revision.

This is diagnosis only, never deployment. Permission is read-only Cloud Logging
in App and Finder, not Firestore. Never expose raw production data, prompts,
provider responses or credentials. If invocation is unavailable, report the
limitation rather than claiming access. Do not bypass workflow/WIF main-only
conditions; the first real smoke needs an explicitly approved merge. Respect the
current task's authorization and restrictions on production reads.

## Permanent review evidence

For substantive work by any coding agent, write a concise repository report at
`docs/reviews/YYYY-MM-DD-semantic-subject.md` before final verification and commit.
Record objective/scope, base branch/SHA, changed components, root cause or findings,
decisions, focused verification scope/results, limitations, production impact,
deployment status and reviewer warnings. Never include secrets or private logs.

Final handoff must include repository full name, branch, final full 40-character
SHA, exact GitHub commit URL, report permalink anchored to that SHA, CI URL and
actual status when available, and comparison or draft PR URL where possible.
Local workspace paths alone are not review evidence. Do not guess a future SHA
in an uncommitted report. A later code commit invalidates earlier verification;
verify the final tree under the repository's existing focused policy, including
later documentation-only changes as appropriate. Reports must describe the final
reviewed revision; never attribute another SHA's CI to it.

Keep branches/commits semantic and verification focused. Do not run broad suites
for reassurance. These evidence requirements supplement existing repository
verification, secret-scan, publication and release controls, never replace them.

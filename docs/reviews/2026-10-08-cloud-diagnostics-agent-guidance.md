# Cloud diagnostics and persistent review evidence

- Objective: make the separately reviewed App read-only backend diagnostic workflow discoverable to Codex and Claude; require permanent reviewer evidence.
- Base: `main`, `f46d3607f9552bb741c057b5d525c01d2fa245c5`.
- Changed components: root `AGENTS.md` and this report only. The alias-investigation commit remains untouched on its existing branch; this guidance branch starts independently from main.
- Finding: Finder lacked root agent guidance for the new approved App workflow and immutable review artifacts.
- Decisions: consult sanitized production events when authorized and useful; no requirement for purely frontend/code-only tasks. Logging scope never implies Firestore or deployment. Availability starts only after reviewed App-main merge; missing access must be reported honestly.
- Verification scope: Prettier on the two Markdown files, whitespace check, and explicit inspection of guidance for main-only availability, privacy, read-only scope and immutable evidence. No code or resolver change requires runtime tests.
- Limitations: workflow implementation lives in a separate App branch and is not yet invocable under current WIF trust. No live smoke attempted.
- Production impact/deployment: none; no merge, deployment, production read/write, IAM change or backfill.
- Reviewer warning: review this alongside the App diagnostics branch; do not attempt branch-authentication bypass. Existing alias tests/documentation are not rewritten here.

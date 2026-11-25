# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through GitHub's [security advisory](https://github.com/ninthmonee/AccreMind/security/advisories/new) form.

Please include:

- affected version or commit
- a description of the issue and its impact
- reproduction steps or a proof of concept
- any mitigation you have already identified

You can expect an acknowledgement within 3 business days and an assessment within 10 business days. Once a fix is available we will publish an advisory and credit you, unless you prefer to stay anonymous.

## Supported versions

AccreMind is pre-1.0 and ships fixes on the latest release only.

| Version | Supported |
| --- | --- |
| latest 0.x | Yes |
| older 0.x | No — upgrade to the latest release |

## Threat model

AccreMind runs inside a developer's own machine and treats the repository as trusted input for the most part, but the following surfaces are treated as untrusted and are defended in code:

| Surface | Risk | Mitigation |
| --- | --- | --- |
| Knowledge cards, rule documents, evidence files | Prompt injection through injected content | Content is sanitised, wrapped in read-only tags, and explicitly labelled as reference material rather than instruction. Entries never carry execution authority |
| Imported rule documents (`accremind docs import`) | Malicious instructions entering the resident layer | Imports land as proposals; nothing reaches the resident layer without human acceptance |
| Model-extracted candidates | Plausible but wrong knowledge persisting | Five-way triage, probation before verification, counterexample suspension, staleness re-checks |
| Local HTTP workbench | Unauthorised access from the network | Binds to loopback only; no authentication surface exposed externally |
| Model endpoints | Credential leakage to a third party | A key is only sent to the endpoint it belongs to; a custom base URL never receives a DeepSeek or OpenAI key |
| Published package | Tampering or unexpected runtime deps | Zero third-party runtime dependencies, reproducible build, `pnpm pack:check` validates the published shape |

## Out of scope

- Attacks that require an already-compromised local account, or root/administrator access to the machine.
- Content of knowledge cards written by the user — you are responsible for what you commit to `.accremind/`.
- Vulnerabilities in DSH itself or in third-party models; report those upstream.

## Hardening recommendations

- Commit `.accremind/` and review changes in pull requests, exactly like code.
- Keep `autoCapture` disabled in repositories that handle sensitive material.
- Leave `autoEvolve` off unless you are prepared to review the tuning history.
- Run the workbench on loopback only; do not expose port 3180 to a network you do not control.

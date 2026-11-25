## What changed

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The problem this solves. Link the issue: Closes #123 -->

## How

<!-- The approach, and why it beats the alternatives you considered. -->

## How I verified it

<!-- Commands you ran, plus anything you checked by hand. -->

- [ ] `pnpm verify` passes (build + tests + workbench fingerprint)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm pack:check` passes (required when `packages/dsh-plugin` or `packages/core` changed)

## Checklist

- [ ] New behaviour has a test; bug fixes have a regression test
- [ ] Documentation updated if behaviour, configuration or CLI surface changed
- [ ] `CHANGELOG.md` updated under *Unreleased* for user-visible changes
- [ ] No unrelated refactors bundled in
- [ ] Injected content (if touched) is still treated as read-only reference material with no execution authority

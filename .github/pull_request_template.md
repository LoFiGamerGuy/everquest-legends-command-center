## Summary

<!-- What does this PR do? Link the issue: Closes #NN -->

## Type
- [ ] feat / fix / docs / test / refactor / chore (conventional commit title)

## Compliance checklist (required)
- [ ] No memory reading, injection, hooking, packet analysis, input automation, or game-directory writes
- [ ] No proprietary-format parsing/unpacking; no game-binary-derived data committed
- [ ] No raw player logs or secrets committed; fixtures anonymized (validate-fixtures passes)
- [ ] Stays within docs/COMPLIANCE_BOUNDARIES.md (no boundary expansion)

## Parser changes (if applicable)
- [ ] Every new/changed recognizer has ≥1 real anonymized fixture + test
- [ ] No fabricated log formats; UNVERIFIED formats documented in LOG_FORMAT_SPEC.md instead
- [ ] Raw line + byte offset preserved on emitted events

## Data changes (if applicable)
- [ ] Schema change ships as a numbered forward-only migration

## Testing
<!-- How was this verified? -->

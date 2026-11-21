## Summary

<!-- What changes for a Cloud user, operator, or application author? -->

Closes #

## How do we prevent this next time? (guard: check/test/convention, or why none)

<!-- A fix also adds its own docs-site/docs/en/contributing/lessons/YYYY-MM-DD-<unique-slug>.md. Do not edit the shared lessons-learned.md page. -->

## Checklist

- [ ] The title is a Conventional Commit: `type(scope): outcome` (`feat` = minor, `fix` = patch, `!` only with maintainer approval)
- [ ] Each touched package's typecheck and `bun run test --filter <package>` pass (integration with `CLOUD_TEST_*` when server code changed; full `bun run check` and `bun run test` when repository checks, the build or test system, or many packages changed)
- [ ] Documentation updated under `docs-site/docs/en`, or `docs: n/a`

### UI pull requests only

<!-- Delete this block when the pull request changes no UI. The criteria: /en/ui/surfaces/flat-criteria -->

- [ ] Flat criteria (K1–K17) hold; the measured ones pass their checks, and the judgement questions are answered here:
  - K6: Is the lead statement what a person wants to know here first?
  - K8: Does every colour on the page map to one meaning (here, press, your turn, state, AI, data), with one filled main button per view?
  - K10: Does each notice concern the page or one thing, and must someone act?
  - K12: Does every width (390, 768, 1440, 1920 px) look intended?
  - K17: Do you find within five seconds what to do and how much money flows?
- [ ] Mockup against built: a list of what the approved mockup shows and where it ships (states included)
- [ ] Light screenshots with invented data, before and after

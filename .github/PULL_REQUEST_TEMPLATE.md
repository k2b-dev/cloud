## Summary

<!-- What changes for a Cloud user, operator, or application author? -->

Closes #

## How do we prevent this next time?

<!-- (guard: check/test/convention, or why none) A fix also adds its lesson to docs-site/docs/en/contributing/lessons-learned.md. -->

## Checklist

- [ ] The title is a Conventional Commit: `type(scope): outcome` (`feat` = minor, `fix` = patch, `!` only with maintainer approval)
- [ ] Each touched package's typecheck and `bun run test --filter <package>` pass (integration with `CLOUD_TEST_*` when server code changed; full `bun run check` and `bun run test` when repository checks, the build or test system, or many packages changed)
- [ ] Documentation updated under `docs-site/docs/en`, or `docs: n/a`

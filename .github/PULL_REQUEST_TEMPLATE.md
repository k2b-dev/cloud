## Summary

<!-- What changes for a Cloud user, operator, or application author? -->

Closes #

## Checklist

- [ ] The title is a Conventional Commit: `type(scope): outcome` (`feat` = minor, `fix` = patch, `!` only with maintainer approval)
- [ ] Each touched package's typecheck and `bun run test --filter <package>` pass (integration with `CLOUD_TEST_*` when server code changed; full `bun run check` and `bun run test` when repository checks, the build or test system, or many packages changed)
- [ ] Documentation updated under `docs-site/docs/en`, or `docs: n/a`

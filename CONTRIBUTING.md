# Contributing to Cloud

Thanks for helping. This page covers the mechanics; the design rules for
applications live in the [`cloud-dev`](docs-site/agent-skills/cloud-dev/SKILL.md)
skill and the maintainer rules in [`AGENTS.md`](AGENTS.md).

## Set up

```bash
bun install --frozen-lockfile
bun run dev
open http://localhost:3000
```

Bun 1.x, Docker, and Docker Compose v2 are required. See
[Monorepo development](docs-site/docs/en/operations/monorepo-development.md)
for the per-application commands.

## What this project accepts

Small, focused bug fixes, reliability and performance improvements, and
tightly scoped maintenance that clearly improves Cloud without changing its
direction are welcome. Large drive-by features, rewrites, and pull requests
that mix unrelated changes are likely to be closed. Propose ideas in
[Discussions](https://github.com/k2b-dev/cloud/discussions/categories/ideas)
before building them; open a bug with the
[bug report form](https://github.com/k2b-dev/cloud/issues/new?template=bug.yml).

## Branch and open a pull request

`main` is protected. Work on a branch named `type/short-slug`, open a pull
request, and it is squash-merged after the `gate` check passes. Each piece of
work gets a worktree under `../cloud-wt/<slug>`:

```bash
git fetch origin
git worktree add ../cloud-wt/<slug> -b fix/<slug> origin/main
cd ../cloud-wt/<slug> && bun install --frozen-lockfile && bun run --cwd packages/ui build
```

The PR title becomes the commit and must be a Conventional Commit:
`type(scope): outcome`, for example `fix(mail): keep list subscriptions after
provider restart`. `feat` releases a minor version, `fix` a patch, `feat!` a
major. Never edit `version` fields or `CHANGELOG.md`; release-please owns them.
See [Release process](docs-site/docs/en/contributing/release-process.md).

Before opening the pull request:

```bash
bun run check
bun run test
```

Integration tests run only with `CLOUD_TEST_*` variables set and refuse a
database whose name does not end in `_test`. See
[Testing](docs-site/docs/en/contributing/testing.md). `dev:*` commands belong
to the main checkout, not to worktrees.

Reference the issue the pull request closes (`Closes #n`), or say in one line
why none is needed.

## Add an application

An application touches three files:

1. the `workspaces.packages` list in the root `package.json`;
2. its service in `compose.dev.yml`;
3. its service in `compose.prod.yml`.

Everything else (image name, release set, CI matrix) derives from
`scripts/workspace.ts`. The `app-set` check fails when the three disagree.

## Add a repository rule

A rule is one module under `scripts/checks/`. `bun run check` discovers it;
do not add a `package.json` script or workflow for it.

## Install the agent skills

```bash
bun scripts/install-skills.sh
```

This links `cloud-dev` and `cloud-cli` into the agent skill directories on
this machine.

## Update documentation

Documentation is part of the contract. When observable behavior changes, update
the owning page under `docs-site/docs/en` in the same pull request, and run
`bun run --cwd docs-site verify:docs`. See
[Document Cloud core changes](docs-site/docs/en/contributing/document-cloud-core-changes.md).

## Report a vulnerability

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

---
title: Release process
navTitle: Release process
section: Contributing
order: 1302
description: How a change on a feature branch becomes a versioned Cloud release with images, CLI, website, PWA, and npm packages.
tags: [contributing, release, versioning, ci]
updated: 2026-09-23
---

# Release process

Cloud releases from `main`. Nobody edits version numbers or the changelog by
hand; release-please derives them from squash-commit titles.

## Branch and merge

`main` is protected. Work on a feature branch, open a pull request, and let the
`gate` check pass. A green pull request enters the merge queue, which runs the
gate once more on the exact merge result and squash-merges it, so the PR title
becomes the commit on `main`. `main` itself is not verified again; `main.yml`
starts straight from the push.

The title is a [Conventional Commit](https://www.conventionalcommits.org/) of
the form `type(scope): outcome`:

| Title | Next release |
| --- | --- |
| `fix(mail): keep list subscriptions after provider restart` | patch |
| `feat(grids): add column formulas` | minor |
| `feat(core)!: require the identity KEK at startup` | major |
| `docs: …`, `chore: …`, `refactor: …`, `test: …`, `ci: …` | no release on its own |

A `BREAKING CHANGE:` footer in the PR body has the same effect as `!`. Use
either only with explicit maintainer approval, because it moves every
application image to a new major version.

A change to a runtime contract (configuration, routes, permissions, data
format, deployment) needs a `feat` or `feat!` title and a note on the matching
[Operations](/en/docs/operations) page. It lands in the next `cloud-vX.Y.Z`
automatically.

## Let release-please cut the release

release-please runs on every push to `main`:

1. It opens or updates one release pull request per component. The PR bumps
   `version` fields, updates `CHANGELOG.md`, and records the new version in
   `.release-please-manifest.json`.
2. Merging the release PR creates the tag. The Cloud component tags
   `cloud-vX.Y.Z`; the npm packages tag `npm-cloud-vX.Y.Z` and `npm-ui-vX.Y.Z`
   as separate components with their own version lines.
3. The `cloud-vX.Y.Z` tag triggers the release workflow. It builds the 26
   images of the release set (every application from `scripts/workspace.ts`
   plus `cloud-website` and `cloud-pwa-auth`) for `linux/amd64` and
   `linux/arm64`, the CLI binaries, and publishes a GitHub release with
   `release.json` and build attestations.
4. The `npm-cloud-v*` and `npm-ui-v*` tags publish `@k2b/cloud` and `@k2b/ui`
   with npm provenance. A prerelease version such as `0.8.0-rc.1` publishes
   under the `next` dist-tag; a stable version publishes under `latest`.

`release.json` lists every image with its tag and digest. Deployments pin the
`vX.Y.Z` tag or the digest from that file; see
[Build and deploy](/en/docs/operations/build-and-deploy#choose-an-image-tag).

Every push to `main` also builds `sha-<12>` images for staging. Those tags are
not releases: they carry no changelog entry and no support commitment.

## Verify the CLI assets

The GitHub release for `cloud-vX.Y.Z` also carries the `cld` binaries
(`cld_darwin_arm64`, `cld_darwin_x64`, `cld_linux_arm64`, `cld_linux_x64`),
the `cloud-cli-skill.tar.gz` skill archive, and `checksums.txt` with the
SHA-256 of each. The release workflow signs `checksums.txt` keylessly with
Cosign and publishes the Sigstore bundle `checksums.txt.sigstore.json`. Verify
it with Cosign 2.4.2 or newer:

```bash
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/k2b-dev/cloud/\.github/workflows/release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
sha256sum --check --ignore-missing checksums.txt
```

The installer and `cld update` run the same check whenever `cosign` is on
`PATH`; SHA-256 is always checked. Releases published before the bundle carry
only a detached signature `checksums.txt.sig` and certificate
`checksums.txt.pem`. The installer and `cld update` use these only when a
release has no bundle. New releases still publish both files, taken from the
bundle, so already installed `cld` versions keep updating; they will be
dropped in a later release.

## Ship a hotfix

Branch from the release tag, not from `main`:

```bash
git switch -c fix/mail-subscriptions cloud-v0.7.0
```

Open the pull request against `main` as usual. release-please includes the fix
in the next patch release. If `main` already contains unreleased minor changes,
the fix ships with them; a separate patch line for an old minor is not
maintained.

## Roll back

Pin the previous `vX.Y.Z` or its digests from that release's `release.json`,
then run the fleet preflight against the running installation:

```bash
CLOUD_IMAGE_TAG=v0.7.0 bun run release:preflight
```

The preflight needs `CLOUD_IMAGE_TAG`, `SYNC_NAMESPACE`, `CLOUD_CORE_URL`, and
`CLOUD_ADMIN_TOKEN` in the process environment. Check migration compatibility
before rolling back across a release that changed the database; the changelog
marks such releases.

## Do not

- edit `version` fields, `CHANGELOG.md`, or `.release-please-manifest.json`;
- create, move, or delete tags;
- push to `main` directly;
- re-run a release for a tag that already exists. Fix forward with a new
  patch release.

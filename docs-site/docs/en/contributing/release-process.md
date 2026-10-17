---
title: Release process
navTitle: Release process
section: Contributing
order: 1302
description: How a change on a feature branch becomes a versioned Cloud release with images, CLI, website, PWA, and npm packages.
tags: [contributing, release, versioning, ci]
updated: 2026-10-17
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

release-please copies commit descriptions and `BREAKING CHANGE:` or
`BREAKING-CHANGE:` paragraphs into the release PR body and parses it as HTML.
Write placeholders without angle brackets: use `DIR` or `{dir}` instead of
`<word>`, even inside backticks. The `check` job reads the live PR title and
body on the PR and again in the merge queue. It refuses HTML-like markup in
the title, Conventional Commit header lines in the body, breaking-change
paragraphs, and `BEGIN_NESTED_COMMIT` or `BEGIN_COMMIT_OVERRIDE` blocks
([#1298](https://github.com/k2b-dev/cloud/issues/1298)). After fixing the
text, re-run the failed `check` job to check it again.

A change to a runtime contract (configuration, routes, permissions, data
format, deployment) needs a `feat` or `feat!` title and a note on the matching
[Operations](/en/docs/operations) page. It lands in the next `cloud-vX.Y.Z`
automatically.

When a pull request for a built-in app shows screenshots of the UI, take them
in light mode; use dark mode only when the change is about dark rendering. Use
demo data, never a person's real data, and show only the states that changed
or that a decision depends on. Pull requests are public, and one baseline
theme lets reviewers compare screenshots across changes.

## Let release-please cut the release

release-please runs on every push to `main`:

1. It opens or updates one release pull request per component. The PR bumps
   `version` fields, updates `CHANGELOG.md`, and records the new version in
   `.release-please-manifest.json`.
2. Merging the release PR creates the tag. The Cloud component tags
   `cloud-vX.Y.Z`; the npm packages tag `npm-cloud-vX.Y.Z`, `npm-ui-vX.Y.Z`,
   and `npm-ssr-vX.Y.Z` as separate components with their own version lines.
3. No workflow starts from these tags. The `main.yml` run that created them
   continues: its `images` job builds every image of the release set once
   (one per application from `scripts/workspace.ts` plus `cloud-website` and
   `cloud-pwa-auth`; `bun scripts/workspace.ts images` lists them) for
   `linux/amd64` and `linux/arm64`, attests its build provenance, and tags it
   `sha-<12>`, plus `vX.Y.Z` for a Cloud release. `main.yml` then calls
   `release.yml`. For a Cloud release, it reuses these images instead of
   building them again, builds the CLI binaries, and attaches the binaries
   and `release.json` to the `cloud-vX.Y.Z` GitHub release.
4. For each new `npm-cloud-v*`, `npm-ui-v*`, or `npm-ssr-v*` tag,
   `release.yml` publishes `@k2b/cloud`, `@k2b/ui`, or `@k2b/ssr` with npm
   provenance. A prerelease version such as `0.8.0-rc.1` publishes under the
   `next` dist-tag; a stable version publishes under `latest`. `@k2b/cloud`
   pins exact `@k2b/ui` and `@k2b/ssr` versions, so it publishes only after
   both are installable from npm. When the same release publishes either of
   them, the workflow waits up to 20 minutes in total; otherwise the pinned
   version must already be on npm, or `@k2b/cloud` stays unpublished and the
   release fails.

The release PR runs the `packed` check with `--release`, including in the
merge queue, to test already published sibling pins from npm and versions
this release publishes from their tarballs. See
[What CI runs](/en/docs/contributing/testing#what-ci-runs).

The `release-body` job checks the release PR and its merge queue run. It parses
the live PR body with the release-please version and dependency tree pinned by
the action in `main.yml`. It fails when a bumped component is missing, has a
different version, or has swallowed another release section into its notes.

When this guard fails on an open release PR, the cause is already in a commit
on `main`. The maintainer must edit the release PR body as described below,
right before merging: release-please rewrites the body on every push to
`main`. Re-run the failed job after saving the body; a body edit does not
start CI.

Merge the release PR only after release-please has refreshed it after the last
feature PR merged. Check that its parent is the current `main`:

```bash
git fetch origin && test "$(git rev-parse origin/release-please--branches--main^)" = "$(git rev-parse origin/main)"
```

If it differs, wait for the `release-please` job of the latest `main.yml` run.
In [#1221](https://github.com/k2b-dev/cloud/issues/1221), a stale release PR
left `@k2b/ui` unbumped, so published Cloud code imported an export its pinned
UI version did not have.

Each package publishes through an npm Trusted Publisher for `k2b-dev/cloud`
with the workflow file `main.yml`. `release.yml` runs the publish, but it is a
reusable workflow, and npm checks the workflow that calls it.

release-please updates exact pins between workspace packages but leaves peer
ranges alone. `@k2b/ui` pins `@k2b/ssr` as a development dependency, so every
`@k2b/ssr` release also cuts a `@k2b/ui` patch release. `@k2b/ui` also
declares `@k2b/ssr` as a peer range, so a release PR that moves `@k2b/ssr`
outside it fails the `dependencies` check. Widen the range in a normal pull
request on `main` first; the release PR then picks it up.

The image builds take their base images, the Dockerfile frontend, BuildKit, and
the SBOM generator from the public mirror `ghcr.io/k2b-dev/mirror` at the
digests pinned in `.github/mirror-images.txt`, never from Docker Hub, so a
release does not depend on Docker Hub's limit for anonymous pulls. The
provenance attestation names the mirror reference with the same digest as the
Docker Hub image. See
[Where CI images come from](/en/docs/contributing/testing#where-ci-images-come-from).

`release.json` lists every image with its tag and digest. Deployments pin the
`vX.Y.Z` tag or the digest from that file; see
[Build and deploy](/en/docs/operations/build-and-deploy#choose-an-image-tag).

Every push to `main` also builds `sha-<12>` images for staging. Those tags are
not releases: they carry no changelog entry and no support commitment.

### Recover a release that release-please skipped

This is a maintainer procedure. Agents never perform these steps:
`AGENTS.md` forbids agents from creating tags or triggering releases.

For `cloud-v0.44.0`, HTML-like placeholders swallowed the Cloud section of
release PR #1248, so release-please created only the npm releases
([#1298](https://github.com/k2b-dev/cloud/issues/1298)). Recover a skipped
release in this order:

1. Edit the merged release PR body. Replace each `<` that starts markup in
   the release notes with `&amp;lt;`; keep the structural `details` and
   `summary` tags. The GitHub release then shows `<`. Do not use `&lt;`:
   release-please decodes it to `<`, and the GitHub release hides the text
   as an HTML tag. Check the edited file before saving it on GitHub:

   ```bash
   bun scripts/check-release-pr-body.ts --pr <n> --body <file>
   ```

   After saving, run `bun scripts/check-release-pr-body.ts --pr <n>` to check
   the live body.
2. Change the PR label from `autorelease: tagged` back to
   `autorelease: pending`.
3. Push a branch pointing at the release commit and dispatch `main.yml` on it:

   ```bash
   git push origin <release-sha>:refs/heads/chore/recover-release-X-Y-Z
   gh workflow run main.yml --ref chore/recover-release-X-Y-Z
   ```

   release-please creates the missing tag and GitHub release at that commit
   and skips existing releases as duplicates. The run builds images from the
   release commit. CLI asset signing fails on this branch because its
   signature identity must use `refs/heads/main`. If the `release-please` job
   still logs `Pull request contains releases, but not for component`, it has
   set the label to `autorelease: tagged` again: check the live body, repeat
   step 2, and dispatch again. The first 0.44.0 attempt needed this.
4. Finish the release from `main`:

   ```bash
   gh workflow run main.yml --ref main -f version=X.Y.Z
   ```

   This checks out the release tag and publishes the CLI assets and
   `release.json`.
5. Delete the recovery branch:

   ```bash
   git push origin --delete chore/recover-release-X-Y-Z
   ```

## Verify the CLI assets

The GitHub release for `cloud-vX.Y.Z` also carries the `cld` binaries
(`cld_darwin_arm64`, `cld_darwin_x64`, `cld_linux_arm64`, `cld_linux_x64`),
the `cloud-cli-skill.tar.gz` skill archive, and `checksums.txt` with the
SHA-256 of each. Current `cld` versions embed the skill and ignore the
archive; it stays published for installed `cld` versions that still download
it. The release workflow signs `checksums.txt` keylessly with
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
- re-run a release for a tag that already exists, except for the maintainer
  recovery procedure above. Otherwise, fix forward with a new patch release.

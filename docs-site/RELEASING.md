# Release UI and the Cloud website

Release from a clean, reviewed commit. UI package publication and website
image publication are independent; neither workflow deploys the website.

## Verify the release commit

From the repository root:

```bash
bun install --frozen-lockfile
bun run check:dependencies
bun run --cwd packages/ui build
bun run --cwd packages/ui typecheck
bun run --cwd packages/ui test
bun run --cwd packages/ui fixture:typecheck
bun run --cwd packages/ui fixture:build
bun run --cwd docs-site verify:docs
```

The UI test command installs registry dependencies in a temporary consumer
and checks the extracted npm archive, SSR rendering, CSS assets, licenses,
and browser tree-shaking. It does not use workspace dependency links.
The release gates are independent:

| Release | Required checks | Not required |
| --- | --- | --- |
| UI npm package | `ui.yml`: package build, types, tests, packed consumer, and standalone fixture | Website certification and Cloud application CI |
| Website image | `docs.yml`: documentation, examples, catalog, and website build; `website.yml`: production container smoke | UI package test suite and Cloud application release CI |

Both workflows install only their target workspace and its dependencies.
A failing unrelated Cloud application workflow does not block either release.
The website still imports Cloud integrations and compiles Cloud API examples;
errors in those imports must be fixed before publishing the website. It does
not require a running Cloud installation or a new Cloud npm release.

Require the checks for the intended artifact to pass on its exact release
commit.

## Publish UI to npm

The package uses `AGPL-3.0-or-later`, matching the root Cloud license. Keep
`packages/ui/LICENSE` identical to the root `LICENSE`. The build copies the
licenses of the bundled IBM Plex and Tabler assets into `dist/licenses`.

For the first publication, bootstrap the package before configuring npm
Trusted Publishing:

1. Prepare and review a prerelease version in `packages/ui/package.json` and
   the lockfile. Build and inspect its archive with `npm pack --dry-run` from
   `packages/ui`.
2. From a clean checkout of that commit, authenticate with `npm login` and
   publish with `npm publish --access public --tag next` from `packages/ui`.
3. In npm package settings, configure the GitHub trusted publisher for
   owner `ValentinKolb`, repository `cloud`, workflow `npm-ui.yml`.
4. Verify the published version in a fresh Solid consumer before a stable
   release. Confirm package contents and all public CSS entry points.

Subsequent releases use a tag named `npm-ui-v<package-version>`. The tag must
match the committed package version. The Publish UI workflow first runs UI
certification, then publishes with npm provenance. Prereleases use `next`;
stable versions use `latest`. No npm token is required by that workflow.

After publication, verify the version, dist-tag, integrity, and provenance
with `npm view @k2b/ui --json`, then install that exact version in a fresh
consumer. Remove a bootstrap `next` tag only after the stable release is
verified and no preview still needs it.

## Publish the website image

The Cloud website image workflow builds `docs-site/Dockerfile`, starts the
production container, and checks its public routes. Pull requests and manual
runs verify without publishing. A `website-v<version>` tag publishes
`ghcr.io/valentinkolb/cloud-website:website-v<version>` for AMD64 and ARM64
after verification. The public origin is `https://cloud.k2b.dev`.

Check the release workflow, inspect both image architectures, and record the
published digest. Use that immutable digest for deployment.

## Deploy the website

Choose the hosting target and configure DNS and HTTPS for `cloud.k2b.dev`.
Run the image on port 3000 with `CLOUD_DOCS_SITE_URL=https://cloud.k2b.dev`.
The website needs no Cloud application stack. Leave `FIBEL_AI_MODEL` unset
unless the documentation assistant and its provider are intentionally enabled.

Before announcing it, verify `/health`, `/en`, `/en/docs`, `/en/ui`, search,
`/robots.txt`, `/sitemap.xml`, `/llms.txt`, the documentation MCP at
`/_fibel/mcp`, and skill discovery at `/.well-known/agent-skills/index.json`.
Check a hydrated UI example on desktop and mobile, keyboard interaction, and
both themes. Confirm canonical and sitemap URLs use the public HTTPS origin.
Keep the previous image digest available for rollback.

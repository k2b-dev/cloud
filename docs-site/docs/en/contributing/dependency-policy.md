---
title: Dependency policy
navTitle: Dependency policy
section: Contributing
order: 1306
description: Where dependencies are declared, which root overrides and patches exist, why, and when each one can go.
tags: [contributing, dependencies, security]
updated: 2026-10-09
---

# Dependency policy

Declare every dependency in the package that imports it. Shared versions live
in the root workspace catalog; private packages refer to them with `catalog:`.
Published packages (`@k2b/cloud`, `@k2b/ui`) use concrete versions because
their npm artifacts must not contain catalog references.

`bun install` applies a three-day release-age gate to new npm versions. The
first-party `@k2b/*` packages are excluded so a coordinated Cloud update can
use a new release immediately. Lifecycle scripts are denied by default; add a
trusted dependency only after verifying why its install script is required.

Update `bun.lock` together with the manifest. `bun run check` verifies that
manifests, catalog, lockfile, and published-package constraints agree. A
concrete pin of a catalog dependency, in a published package, in the root
`devDependencies`, or in the root `overrides`, must equal the catalog
version, and `bun.lock` must resolve that dependency to the catalog version
for every workspace package. Otherwise the workspace installs two copies,
and types, `instanceof` checks, and browser builds stop matching.

Dependabot opens weekly grouped pull requests for the workspace and for GitHub
Actions. It does not read Bun catalogs yet
([dependabot-core#14320](https://github.com/dependabot/dependabot-core/issues/14320)):
it bumps the concrete pins and leaves the catalog behind, and it proposes no
update for a catalog entry that no concrete pin mirrors. When
`bun run check dependencies` fails on a Dependabot pull request, set each
reported catalog entry to the bumped version in the root `package.json`, run
`bun install`, and push the result to the pull request branch.

## Root overrides

Overrides force one version of a transitive dependency across the workspace.
Each one exists for a reason and has a removal condition.

| Override | Reason | Remove when |
| --- | --- | --- |
| `zod` | One Zod instance across `@k2b/cloud`, applications, and `hono-openapi`; mixed majors break schema identity checks. | Every consumer's peer range allows the catalog version without an override. |
| `@k2b/sync` | One Sync client per process; a second copy would register duplicate NATS consumers. | Every consumer's peer range allows the catalog version. |
| `nodemailer` | Pin the audited major shared by platform outgoing mail in `@k2b/cloud` and Mail. | All direct dependents use the catalog version. |
| `fast-uri` | Pin the transitive of `ajv` (through `@modelcontextprotocol/sdk` and Filegate's OpenAPI parser) above the authority-injection and host-confusion advisories (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g). | The transitive dependents resolve to a patched release on their own. |
| `nanoid` | Pin the 3.x line to a release above the predictable-ID advisory (GHSA-mwcw-c2x4-8c55) for dependents still on 3.x. | No dependency requires `nanoid@3`. |
| `sharp` | One native build across the workspace; two versions would double the native download and install time. | All dependents share one range. |
| `@xmldom/xmldom` | Pin above the multiple-root-element advisory (GHSA-crh6-fp67-6883) for XML consumers such as calendar and DATEV imports. | The transitive dependents resolve to a patched release. |
| `svgo` | Pin the 3.x line used by icon and asset builds so a stray 2.x copy does not enter the tree. | All dependents share one range. |
| `lodash-es` | Pin above the `_.template` code-injection advisory (GHSA-r5fr-rjxr-66jc). Mermaid 12 requires chevrotain `~11.1.2`, and chevrotain 11.1.2 with its `@chevrotain/*` packages pins `lodash-es` exactly at the vulnerable 4.17.23, so no in-range update reaches the fix. | The chevrotain release that mermaid resolves reaches a patched `lodash-es` on its own. |

The origin of each override is `git log -S'"<name>"' -- package.json`. The
supply-chain hardening commit (`506eb4895`) added `fast-uri`, `nanoid`, and
`sharp`; `@xmldom/xmldom` and `svgo` followed later without an advisory link in
their commit. Verify the current advisory state with `bun audit` before
removing any of them.

## Patches

`patches/` holds Bun patch files applied at install time through
`patchedDependencies`. Each patch names an upstream issue or the reason it
cannot be upstreamed.

| Patch | Reason | Remove when |
| --- | --- | --- |
| `hucre@1.1.0` | The ODS reader skipped rows nested in `table-row-group`, `table-header-rows`, and `table-rows`; Assistant code mode read incomplete workbooks. Added in `feat(assistant): read ODS workbooks in code mode`. | An upstream `hucre` release walks nested row containers. |
| `bun-plugin-tailwind@0.1.2` | Bun 1.4.2 keeps only the first of adjacent `@supports` rules with the same condition ([oven-sh/bun#24770](https://github.com/oven-sh/bun/issues/24770)), so Tailwind's `color-mix()` polyfill lost mixed colors. The root patch keeps only the `@property` polyfill; `packages/cloud/src/styles/tokens.test.ts` checks mixed tokens and no color-mix polyfill. Standalone apps use `@k2b/cloud/scripts/tailwind.ts` through build and preload to remove generated color-mix fallbacks before bundling; Tailwind v4's supported browsers implement `color-mix()`. Wrapper tests in `packages/cloud/scripts/tailwind.test.ts` cover Tailwind 4.3.3's flat and the plugin's bundled 4.1.14 `& { }` shapes, shorthand/gradient values, matching importance, and byte-identical passthrough for mismatched importance. `scripts/check-cloud-packed-consumer.ts` builds a standalone app with the published, unpatched plugin. See [Styling and accessibility](/en/docs/frontend/styling-and-accessibility#mix-semantic-colors). | Bun merges same-condition `@supports` rules ([oven-sh/bun#38589](https://github.com/oven-sh/bun/pull/38589)) and mixed-value tests pass without either workaround; remove the wrapper, root patch, and polyfill-removal assertions, including the packed-consumer's no-polyfill assertion. Keep mixed-value assertions. |

To change a patch, edit the installed package under `node_modules`, run
`bun patch --commit <package>`, and describe the reason in the pull request.
A patch without a removal condition is a fork; prefer upstreaming.

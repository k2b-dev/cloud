---
title: Dependency policy
navTitle: Dependency policy
section: Contributing
order: 1306
description: Where dependencies are declared, which root overrides and patches exist, why, and when each one can go.
tags: [contributing, dependencies, security]
updated: 2026-09-21
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
manifests, catalog, lockfile, and published-package constraints agree.
Dependabot opens weekly grouped pull requests for the workspace and for GitHub
Actions.

## Root overrides

Overrides force one version of a transitive dependency across the workspace.
Each one exists for a reason and has a removal condition.

| Override | Reason | Remove when |
| --- | --- | --- |
| `zod` | One Zod instance across `@k2b/cloud`, applications, and `hono-openapi`; mixed majors break schema identity checks. | Every consumer's peer range allows the catalog version without an override. |
| `@k2b/sync` | One Sync client per process; a second copy would register duplicate NATS consumers. | Every consumer's peer range allows the catalog version. |
| `nodemailer` | Pin the audited major shared by Core, Mail, and Grids email. | All direct dependents use the catalog version. |
| `fast-uri` | Introduced with the supply-chain hardening commit to pin a transitive of `ajv`; earlier releases had a URI-parsing advisory. | The transitive dependents resolve to a patched release on their own. |
| `nanoid` | Pin the 3.x line to a release above the predictable-ID advisory (GHSA-mwcw-c2x4-8c55) for dependents still on 3.x. | No dependency requires `nanoid@3`. |
| `sharp` | One native build across the workspace; two versions would double the native download and install time. | All dependents share one range. |
| `@xmldom/xmldom` | Pin above the multiple-root-element advisory (GHSA-crh6-fp67-6883) for XML consumers such as calendar and DATEV imports. | The transitive dependents resolve to a patched release. |
| `svgo` | Pin the 3.x line used by icon and asset builds so a stray 2.x copy does not enter the tree. | All dependents share one range. |

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
| `@valentinkolb/filegate@2.4.0` | Bun rejects a `Uint8Array` view over a shared buffer as a fetch body; the patch copies upload bodies. Added in `fix(files): patch Filegate upload bodies and enforce full typechecking`. | The `files` application moves to the Filegate v6 client used by Filesv2, or the v2 client copies bodies upstream. |

To change a patch, edit the installed package under `node_modules`, run
`bun patch --commit <package>`, and describe the reason in the pull request.
A patch without a removal condition is a fork; prefer upstreaming.

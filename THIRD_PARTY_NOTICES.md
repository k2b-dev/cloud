# Third-Party Notices

Cloud includes third-party dependencies. Each dependency remains governed
by its own license.

This file highlights notable third-party license obligations and metadata that
must not be confused with the Cloud project license. It is not a complete bill of
materials.

## Runtime and Distributed Assets

- IBM Plex fonts are provided under the SIL Open Font License 1.1.
- Tabler Icons are used for UI iconography. The package metadata for
  `@tabler/icons-webfont` may omit the `license` field in some published
  versions; the upstream project describes the icon set as MIT-licensed.
- DOMPurify is dual-licensed under MPL-2.0 or Apache-2.0. Cloud relies on the
  Apache-2.0 option.
- `sharp` is Apache-2.0. Its prebuilt `libvips` packages, such as
  `@img/sharp-libvips-*`, are LGPL-3.0-or-later and are included transitively
  through file processing dependencies.

- Grids uses `@stackforge-eu/factur-x`, which is EUPL-1.2, for its German
  E-Invoice renderer.

## Dependency Licenses

For a full dependency inventory, inspect the lockfile and installed dependency
metadata for the exact build being distributed.

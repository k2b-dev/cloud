# Third-Party Notices

Cloud includes third-party dependencies. Each dependency remains governed
by its own license.

This file highlights notable third-party license obligations and metadata that
must not be confused with the Cloud project license. It is not a complete bill of
materials.

## Runtime and Distributed Assets

- The Core image contains the DB-IP IP to City Lite and IP to ASN Lite
  databases, © DB-IP.com, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Attribution: [IP Geolocation by DB-IP](https://db-ip.com).
  Converted from gzip only; otherwise unmodified.

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

- Tools ships `libheif-js` 1.23.5 under LGPL-3.0, including `libheif`
  (LGPL-3.0) and `libde265` (LGPL-3.0). It reaches browsers only as a lazily
  loaded Tools chunk for HEIC/HEIF conversion. LGPL-3.0 is compatible with
  Cloud's AGPL-3.0 distribution; these libraries retain their LGPL terms.

## Dependency Licenses

For a full dependency inventory, inspect the lockfile and installed dependency
metadata for the exact build being distributed.

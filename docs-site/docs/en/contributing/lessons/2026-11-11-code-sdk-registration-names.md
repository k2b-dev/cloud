### Refuse conflicting SDK names before advertising an application

- **What happened:** A conflicting application manifest could register successfully and prevent Code authors from generating their SDK.
- **Root cause:** Name validation ran only during SDK generation, after the registry accepted the manifest.
- **Error class:** Derived public contract validated after publication.
- **Guard:** Registration and generation share SDK name validation. Registration-seam tests reject explicit, implicit and normalized path collisions, preserve the accepted manifest on failure, and serialize concurrent claims.

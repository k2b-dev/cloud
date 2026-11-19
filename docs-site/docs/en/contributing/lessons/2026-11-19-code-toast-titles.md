### Branch toasts missed the short outcome title

- **What happened:** Gustav and Code showed sentence-only toasts and explicit tone icons after the shared toast rule reached the feature branch.
- **Root cause:** The branch synchronization added the existing findings to the toast baseline instead of adapting the call sites.
- **Error class:** Feature-branch feedback bypasses a shared presentation contract through baseline entries.
- **Guard:** The `toast-copy` check enforces short localized titles and variant-owned tone icons; removing the resolved entries makes regressions fail.

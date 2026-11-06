### Development credentials must carry their declared grants

- **What happened:** Development enrollment inferred the OAuth issuance grant from an application name.
- **Root cause:** The fixture omitted grants and enrollment supplied a name-specific rule.
- **Error class:** Implicit policy outside its owning data declaration.
- **Guard:** Generator tests preserve explicit grants for differently named apps and default new fixtures to no grants. The development enrollment integration test compares stored grants with each fixture. The app-deployments repository rule independently checks generated artifacts.

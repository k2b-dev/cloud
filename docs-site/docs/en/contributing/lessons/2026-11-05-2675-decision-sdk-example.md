### Compile decision examples against the generated SDK

- **What happened:** The documented mail-triage example failed the Code checker.
- **Root cause:** It called a targetless query on the app namespace instead of the app handle, and returned a boolean from a schedule callback that accepts only `void`.
- **Error class:** An SDK example assumes a call path or callback contract that the generated types do not provide.
- **Guard:** The mail-triage checker test compiles the exact shared documentation and Code skill example against the real Core query manifest, verifies AI classification, and executes urgent spam and support cases. The `help-writing` rule checks the help pages' metadata and glossary terms.

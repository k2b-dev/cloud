### Defer recent result names to independent resource readers

- **What happened:** Recent Code effects kept their result references but showed no task names or links because the parent capability had already spent its one child Query reading a permission Space.
- **Root cause:** Activity presentation attempted to resolve several resource names within one invocation's child-Query allowance.
- **Error class:** A bounded orchestration layer spent a per-invocation resource budget before its consumer's needed read.
- **Guard:** Activity integration rejects any child Query while asserting the exact result reference and localized name slot. Unit tests keep fallback text free of names and links, omit ambiguous targets and validate the six-row contract. Consumers resolve each reference with an independent authorized reader and retain the kind-only sentence when that read fails.

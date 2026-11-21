### A synced CLI command must follow the current capability target contract

- **What happened:** The prepared-summary CLI command sent a mailbox ID inside the Action input instead of selecting the mailbox target.
- **Root cause:** The command merged cleanly from a branch that still passed mailbox identity in the input, while the receiving branch had moved it to the capability call target.
- **Error class:** Semantic merge conflict across a public transport contract.
- **Guard:** The `protected summary CLI invokes the idempotent capability with explicit revision fences` test checks the complete request body, including the mailbox target; `capability-targets` checks Action declarations.

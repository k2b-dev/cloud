# Frozen capability contracts

Provider conformance uses these manifests with
`assertCapabilityManifestEvolution(previous, current)`. Preserve the previous
contract; do not regenerate fixtures to silence a failure.

Before Code R1 makes the SDK public, the approved SDK contract deliberately
hides Mail's `conversation.status.update` and `.update.batch` aliases with
`code: false`. The canonical SDK paths are `conversation.status.set` and
`.set.batch`. Both aliases remain in the capability manifest with their original
inputs, results and execution behavior.

For this pre-R1 change, the frozen Mail fixture's single-operation alias gained
only `code: false`. Its operation `schemaHash` and enclosing `manifestHash` were
recomputed with the platform's `capabilityHash`. No other fixture fields changed.
The older fixture has no batch alias; provider conformance separately verifies
both current aliases and their SDK omissions. No RPC schema, capability ID, or
compatibility assertion changed. This exception does not allow resetting
published contracts after R1.

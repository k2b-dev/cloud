### Input schema index signatures erased chart prop types

- **What happened:** Code chart builders accepted an unknown description prop and a string instead of a series array.
- **Root cause:** Projecting strip-mode chart objects as input added an unknown index signature. Applying `Omit` to remove the kind discriminator erased the named prop types.
- **Error class:** Open index signature erased known fields through a mapped type.
- **Guard:** The TSX building-block negative cases remain unchanged; the generated SDK typecheck also rejects both cases. Chart authoring projects input defaults while closing objects that strip unknown keys.

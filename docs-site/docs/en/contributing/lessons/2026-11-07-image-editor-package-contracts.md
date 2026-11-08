### Check a lazy component through the package it ships

- **What happened:** The complete UI suite rejected the new ImageEditor stylesheet inventory and its lazy-bundle fixture, although focused interaction tests passed.
- **Root cause:** Two stylesheet contracts still expected the old import list. The bundle fixture sent raw Solid TSX to Bun without the package's Solid compiler, so a lazy dependency received an incompatible JSX transform.
- **Error class:** Testing a component outside its shipped package boundary.
- **Guard:** Both stylesheet inventories explicitly include ImageEditor while retaining all focus and ownership assertions. The bundle fixture imports the compiled public browser entry, then checks that the view and engine exist only beyond a dynamic import. Run the complete owning package suite before handing off a new public component.

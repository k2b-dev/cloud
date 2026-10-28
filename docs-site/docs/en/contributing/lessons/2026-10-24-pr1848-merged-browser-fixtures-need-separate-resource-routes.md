### Merged browser fixtures need separate resource routes

- **What happened:** A missing-glyph regression no longer reached its failing handler after two map fixtures were combined.
- **Root cause:** Both the successful snapshot fixture and the failure fixture used the same glyph URL prefix; the first handler always returned a valid font.
- **Error class:** Fixture route shadowing removes the intended failure condition.
- **Guard:** Success and failure glyph routes have distinct prefixes; the regression asserts a failing request occurred and the map offers a visible retry.

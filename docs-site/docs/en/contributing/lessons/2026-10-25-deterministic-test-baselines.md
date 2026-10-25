---
title: Deterministic test baselines
description: Compare test findings independently of directory order and pin database timestamp fixtures before writes.
updated: 2026-10-25
---

# Deterministic test baselines

- **What happened:** The module-mocks tests passed locally but failed in CI when findings arrived in another directory order. An integration test also had a timing assertion that raced within one clock tick.
- **Root cause:** The guard fixture compared an unordered collection as an ordered list. The integration fixture compared successive database writes without controlling their starting timestamp.
- **Error class:** Assertions depend on filesystem order or clock resolution.
- **Guard:** `scripts/checks/module-mocks.test.ts` sorts findings by path and separately asserts the existing module replacement rule and import-time spy detection. `tests/integration/identity/admin-credential-matrix.integration.test.ts` pins the stored timestamp before each action, then requires accepted writes to advance it and refused writes to preserve it.

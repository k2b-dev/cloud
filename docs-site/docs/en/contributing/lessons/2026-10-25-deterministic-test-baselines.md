---
title: Deterministic test baselines
navTitle: Test baselines
section: Contributing
order: 1307
description: Compare test findings independently of directory order and pin database timestamp fixtures before writes.
tags: [contributing, testing, quality]
updated: 2026-10-25
---

# Deterministic test baselines

- **What happened:** The module-mocks tests passed locally but failed in CI when findings arrived in another directory order. An integration test's timestamp comparison also obscured a response mismatch.
- **Root cause:** The guard fixture compared an unordered collection as an ordered list. The integration fixture checked timestamps before responses, used outdated expected responses, and did not control the starting timestamp.
- **Error class:** Uncontrolled assertion baselines and side-effect checks before response checks.
- **Guard:** `scripts/checks/module-mocks.test.ts` sorts findings by path and separately asserts the existing module replacement rule and import-time spy detection. `tests/integration/identity/admin-credential-matrix.integration.test.ts` uses the current route contract and checks responses before effects. It pins the stored timestamp before each action, then requires accepted writes to advance it and refused writes to preserve it.

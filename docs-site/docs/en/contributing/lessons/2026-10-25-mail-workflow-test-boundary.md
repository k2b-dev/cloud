---
title: Mail workflow tests belong outside application source
navTitle: Workflow test boundary
section: Contributing
order: 1308
description: Keep tests that drive private platform internals in the package test directory.
tags: [contributing, testing, quality]
updated: 2026-10-25
---

# Mail workflow tests belong outside application source

- **What happened:** The repository check rejected four private Cloud imports in Mail's workflow integration test.
- **Root cause:** A test that drives platform internals lived in application source, where only public Cloud imports are allowed.
- **Error class:** Test code crosses the application source boundary.
- **Guard:** The `boundaries` check continues to reject private platform imports from application source. The integration test lives in `packages/mail/test/`, which Mail's typecheck and both test entry points include. `packages/mail/scripts/test-integration.test.ts` explicitly requires that file in the discovered integration suites.

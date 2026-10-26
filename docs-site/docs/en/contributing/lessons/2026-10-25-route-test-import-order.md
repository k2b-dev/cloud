---
title: Isolate import-time route spies
navTitle: Route test isolation
section: Contributing
order: 1309
description: Isolate tests whose imported modules retain temporary replacements.
tags: [contributing, testing, quality]
updated: 2026-10-25
---

# Isolate import-time route spies

- **What happened:** All six Dashboard settings request tests returned 500 in CI unit shard 3, although they passed alone.
- **Root cause:** A skipped integration file statically imported the router before the unit test replaced its rate-limit factory. Bun reused the initialized router, whose real limiter read settings from the unavailable unit-test database. No database pool had been closed by the skipped test.
- **Error class:** Import-time test replacement depends on file order.
- **Guard:** Dashboard and API Docs isolate their test files. The `module-mocks` check rejects top-level spies restored after a dynamic import in shared suites; its tests cover the failure pattern and both package and behavior isolation.

---
title: Verify Assistant chat code
navTitle: Chat code verification
section: Contributing
order: 1316
description: Verify runner-backed chat execution, approvals, files and native views.
tags: [testing, ai, assistant]
updated: 2026-11-08
---

# Verify Assistant chat code

Studio HTML checks, app presentations and browser-host evaluations are retired.
Chat `code_run` executes on the Code runner. It keeps the existing result card,
inspect/stop/export controls and the originating turn's authority.

## Focused checks

From the repository root:

```bash
bun run test --filter src/chat-code/runner-code-host.test.ts
bun run test --filter src/chat-code/view-route.test.ts
bun run test --filter scripts/checks/retired-studio.test.ts
```

The runner fixture tests the generated SDK, exports, errors, approvals and signed
chat routes. Native-view tests check file references and chat/Project access.
The boundary guard rejects retired Studio imports and browser packaging.

With the explicit `CLOUD_TEST_*` targets described in
[Testing](/en/docs/contributing/testing), run the persistence and upgrade files:

```bash
bun run test --integration --filter src/chat-code/service.integration.test.ts
bun run test --integration --filter src/chat-code/retired-studio-migrate.integration.test.ts
```

These check lost-host fencing, deduplication, encrypted chat secrets, approval
scope, resource access and fresh/existing-install preservation. They never use
the development database or start their own service containers.

The fixture does not replace the runner's native workerd engine checks. Follow
[Code runner operations](/en/docs/operations/code-runner) for the runner image and
its execution contract. Report fixture results and native engine results separately.

## Before the cut

Follow [Studio retirement](/en/docs/operations/studio-retirement) before upgrading.
Back up required Studio definitions and external data while the old compatible
release is available; the new release does not transfer them into Code.

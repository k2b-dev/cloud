---
title: Code acceptance
navTitle: Code acceptance
section: Contributing
order: 1317
description: Verify the mailbox schedule, Space task, personal draft and lifecycle story with two in-process runners.
tags: [contributing, code, testing]
updated: 2026-11-02
---

# Code acceptance

`packages/core/src/code/acceptance.integration.test.ts` contains the C25
acceptance expectations for Code Phase 0+1. Run it through the repository
runner with the test infrastructure described in [Testing](/en/docs/contributing/testing):

```sh
bun run test --integration --filter packages/core/src/code/acceptance.integration.test.ts
```

The suite requires `CLOUD_TEST_DATABASE_URL`, `CLOUD_TEST_NATS_SERVERS` and
`CLOUD_TEST_VALKEY_URL`. It uses a disposable migrated database and isolated
NATS namespaces. All people, addresses, credentials and documents are fictional.
No application stack or external mailbox is needed.

The story covers Lea checking resource Code for `rechnung@beispiel.test`,
Ben activating it, a Monday schedule creating a Space task, and personal Code
creating a mail draft. It asserts the permission preview, ordered calls,
idempotency, an update-only version, access removal and cleanup after mailbox
deletion. The fixture uses `Sp4kd2` for the conceptual `sp_4kd2`, following
Spaces' six-character public ID contract.

Additional assertions cover a foreign Space shared with all signed-in people,
a phone activation attempt with otherwise valid browser authority, and a
version-bound credential whose value is echoed by an HTTP fixture or included
in its thrown error. The HTTP version goes through the CLI/chat authoring
service, which selects the current credential bindings and reruns the real
checker before saving. Personal Code also needs internet approval: the suite
asserts rejection before approval, the declared origin and policy row in the
saved version, and the exact HTTP grant in the activated mandate.

Two production Runner supervisors share Core's real Postgres and NATS
coordination. Each supervisor has one slot. A barrier and per-supervisor run
IDs prove that each executes one of the two scheduled runs. The same two
supervisors remain running for the repeat, update, revoked-access and HTTP
attempts. The checker runs through its native isolation launcher. Only fixture source is imported
by the in-process execution engine; the separate Runner isolation tests own
workerd confinement. Provider delivery and external HTTP responses stay in
process. Action delivery uses the real invocation middleware, signature
verification, current mandate resolution and domain services. Owner titles use
the signed account-inspection route. Catalog and person-reader transport is
replaced by direct fixture delivery; its network authentication is outside this
suite. Core's call bridge and app proof verification execute.

These are acceptance expectations, not a record of a successful run. A passing
integration job on the combined branch is required before accepting the slice.

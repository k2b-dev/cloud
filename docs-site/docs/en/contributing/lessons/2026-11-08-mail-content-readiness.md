### Pending content should wait within the original run

- **What happened:** Mail handlers could use every automatic attempt before message content finished loading.
- **Root cause:** Shipped examples treated ordinary pending hydration as an immediate handler failure.
- **Error class:** Retrying asynchronous readiness without waiting for progress.
- **Guard:** `packages/mail/src/service/message-readiness.test.ts` bounds waiting with a fixed clock. `packages/cloud/src/code/checker.test.ts` runs the actual invoice template through five pending replies before content is ready, and checks explicit terminal failure.

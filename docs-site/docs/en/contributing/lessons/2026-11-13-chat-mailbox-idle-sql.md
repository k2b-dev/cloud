### Chat runner waits queried Postgres while idle

- **What happened:** Each idle chat mailbox or reply wait executed five SQL statements every 100 ms, about 50 statements per second per wait.
- **Root cause:** A short timer queried durable delivery state even when no message or reply had changed.
- **Error class:** Database polling in a live wait path (DATA-13).
- **Guard:** `chat-runner.integration.test.ts` meters idle waits, one reply event, the slow fallback, lost notifications and the real Assistant mailbox. `chat-run-wake.integration.test.ts` pins the 2-second fallback with a fake clock and checks NATS channel isolation, cleanup and cancellation with an unresponsive broker flush. Both idle budget tests fail with the original polling loops.

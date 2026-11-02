### One slow application exhausted discovery and the HTTP idle window

- **What happened:** Pages waited for resource-based app discovery, healthy applications disappeared, and the gateway could lose the upstream connection before a response.
- **Root cause:** Sequential existence probes shared a ten-second signal equal to the HTTP idle timeout. A stalled owner consumed the later owners' budget. Discovery and entry also collapsed lookup failures into permission denials.
- **Error class:** Shared deadline starvation and conflating authorization denial with unavailable authorization.
- **Guard:** `app-access-deadline.test.ts` exercises bounded concurrency, fresh per-app deadlines, the overall deadline, page responses, and next-request revocation. `server/middleware/app-access.test.ts` checks the longer entry budget and distinguishes 503 unavailable from confirmed 403 denial. Invocation and capability tests preserve the same unavailable error; later checks in long-running API requests receive fresh budgets.

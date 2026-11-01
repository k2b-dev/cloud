### A resource lookup hid a temporary write refusal

- **What happened:** Collectors discarded recoverable deliveries because a paused source answered 404.
- **Root cause:** Token resolution filtered paused sources out of the lookup, so a temporary refusal looked like a missing resource.
- **Error class:** Resource lookup hides temporary write refusal.
- **Guard:** Test: Pulse `api/website-traffic.integration.test.ts` sends a real source token through paused, inactive, clearing and deleted states, checks distinct 409 and 404 codes and no stored rows, then verifies retry, conflict and schema errors.

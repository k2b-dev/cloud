### Keep reader availability consistent across independent releases

- **What happened:** A new platform permission could remove an application from older registry readers; a missing generated Query could still advertise reader checks. Long resource titles could also prevent startup, and activity consumers rejected additive provider fields.
- **Root cause:** Reader validation used producer rules, availability projections did not follow retained operations, generated labels exceeded the title bound, and the activity contract confused accepted fields with retained fields.
- **Error class:** Compatibility drift between declarations, discovery, and consumers.
- **Guard:** `registry-validation.test.ts` checks unknown permission filtering. `resource-types.test.ts` checks retained reader availability, title bounds, additive activity fields, and required fields. `app-queries.test.ts` and `discussion-providers.test.ts` preserve the person catalog projection. `app-queries.integration.test.ts` checks active principal filtering and one-time constraint upgrades. `server.test.ts` limits redirect changes to app-authority calls.

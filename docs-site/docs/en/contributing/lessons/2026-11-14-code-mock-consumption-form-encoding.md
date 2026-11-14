### Code fixtures need explicit reply counts and encoded form bodies

- **What happened:** Gustav needed extra test rounds after reusing one mock reply for two calls and sending a literal plus sign in a form body.
- **Root cause:** Mock replies are consumed once per non-replayed call, but guidance did not show repeated calls and exhaustion lacked located counts. Form examples did not show the standard URLSearchParams serializer.
- **Error class:** Incomplete executable guidance for fixture consumption and transport encoding.
- **Guard:** The mock exhaustion regression in `packages/cloud/src/code/test-bridge.test.ts` checks counts, location, replay handling and the public result schema. `packages/assistant/src/skills/code-authoring/examples.test.ts` checks and executes the two-call fixture, encoded incoming form fixture and outgoing form POST example.

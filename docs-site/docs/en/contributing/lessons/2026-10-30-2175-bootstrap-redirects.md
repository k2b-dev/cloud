### A refused redirect exhausted the startup retry budget

- **What happened:** An application configured with a redirecting Core origin kept retrying until its five-minute startup budget expired.
- **Root cause:** The client classified every fetch rejection as a transient transport failure, including Bun's `UnexpectedRedirect` error from `redirect: "error"`.
- **Error class:** Permanent protocol failures classified as transient transport failures.
- **Guard:** `packages/cloud/src/runtime/bootstrap-client.test.ts` sends a real HTTP 302 and requires one permanent failure, no follow or retry, and logs containing only the approved metadata.

### Studio's disposable machine schema lacked local group membership

- **What happened:** Studio machine integration tests returned 409 or finished before their effect lock barriers, including cancellation tests with live grants.
- **Root cause:** Machine ACL resolution began querying `auth.service_account_groups`, but the disposable Assistant fixture created only service accounts and credentials. PostgreSQL rejected authorization before the intended effect path could run.
- **Error class:** Handwritten integration schema drift after a shared authorization change.
- **Guard:** The existing agent and standalone cases in `packages/assistant/src/artifacts/machine.integration-cases.ts` exercise real ACL resolution, explicit effect rights, cancellation at database lock barriers, and successful writes with live grants. The disposable fixture now includes the membership table with its production foreign keys and primary key.
